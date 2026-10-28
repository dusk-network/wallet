// Local (in-process) message handler implementing a subset of the extension
// background message API.
//
// This lets the same UI (popup/full) run without chrome.runtime messaging,
// which is how we reuse it in Tauri desktop/mobile.

import { clearVault, createVault, loadVault, unlockVault } from "../shared/vault.js";
import { getSettings, setSettings } from "../shared/settings.js";
import { getAccountNames } from "../shared/accountNames.js";
import { clearPermissions } from "../shared/permissions.js";
import { WALLET_LIFECYCLE_LOCK, withStorageLock } from "../shared/storageLock.js";
import { applyTxDefaults } from "../shared/txDefaults.js";
import { networkNameFromNodeUrl } from "../shared/network.js";
import { ERROR_CODES, rpcError } from "../shared/errors.js";
import { serializeError } from "../shared/transport.js";
import { getTxEpoch, getTxMeta, listTxs, patchTxMeta, putTxMeta } from "../shared/txStore.js";
import { submittedTxMeta, walletSendFields } from "../shared/txRecord.js";
import { beginReset, clearWalletData, endReset, finishPendingReset, finishReset } from "../shared/walletReset.js";
import {
  executionEventError,
  executionEventOk,
  waitForTxExecution,
} from "../shared/txExecution.js";
import { classifyTxPresence, finalizedTxMetadata } from "../shared/txLifecycle.js";
import { engineContactsVault, handleUiCommand } from "./uiCommands.js";
import { clearContacts, keepOnlyContactsOf, moveLegacyContacts } from "../shared/contactsStore.js";
import {
  configure,
  getAccounts,
  getAddresses,
  getCachedGasPrice,
  getSelectedAccountIndex,
  getPublicBalance,
  encodeDrc20Input,
  decodeDrc20Input,
  encodeDrc721Input,
  decodeDrc721Input,
  getDrc20Metadata,
  getDrc20Balance,
  getDrc721Metadata,
  getDrc721OwnerOf,
  getDrc721TokenUri,
  getShieldedBalance,
  getShieldedHistory,
  getShieldedStatus,
  isUnlocked,
  lock,
  openContactsRecords,
  sealContactsRecord,
  sendTransaction,
  selectAccountIndex,
  setShieldedCheckpointNow,
  startShieldedSync,
  unlockWithMnemonic,
  walletIdOf,
  waitTxExecuted,
  waitTxRemoved,
  getMinimumStake,
  getStakeInfo,
  getStakeOwnerStatus,
  getSozuStatus,
} from "../shared/walletEngine.js";

async function ensureEngineConfigured() {
  const settings = await getSettings();
  configure({
    nodeUrl: settings.nodeUrl,
    proverUrl: settings.proverUrl,
    archiverUrl: settings.archiverUrl,
    accountCount: settings.accountCount,
    selectedAccountIndex: settings.selectedAccountIndex,
  });
  return settings;
}

function engineStatus() {
  return {
    isUnlocked: isUnlocked(),
    accounts: isUnlocked() ? getAccounts() : [],
    selectedAccountIndex: isUnlocked() ? getSelectedAccountIndex() : 0,
  };
}

const localEngineMethods = {
  dusk_getMinimumStake: getMinimumStake,
  dusk_getStakeInfo: getStakeInfo,
  dusk_getStakeOwnerStatus: getStakeOwnerStatus,
  dusk_getSozuStatus: getSozuStatus,
  dusk_getCachedGasPrice: getCachedGasPrice,
  dusk_getDrc20Metadata: getDrc20Metadata,
  dusk_getDrc20Balance: getDrc20Balance,
  dusk_encodeDrc20Input: encodeDrc20Input,
  dusk_decodeDrc20Input: decodeDrc20Input,
  dusk_getDrc721Metadata: getDrc721Metadata,
  dusk_getDrc721OwnerOf: getDrc721OwnerOf,
  dusk_getDrc721TokenUri: getDrc721TokenUri,
  dusk_decodeDrc721Input: decodeDrc721Input,
  dusk_setShieldedCheckpointNow: setShieldedCheckpointNow,
  dusk_getShieldedHistory: getShieldedHistory,
  engine_selectAccount: selectAccountIndex,
  engine_contactsOpen: ({ records }) => openContactsRecords(records),
  engine_contactsSeal: ({ text }) => sealContactsRecord(text),
};

const localEngineCall = (method, params) => localEngineMethods[method](params ?? {});

/**
 * @param {any} message
 */
export async function localSend(message) {
  try {
    const common = await handleUiCommand(message, {
      engineCall: localEngineCall,
      ensureEngineConfigured,
      getEngineStatus: engineStatus,
    });
    if (common) return common;
    // Wallet lifecycle operations share one lock so persisted and in-memory
    // identities cannot be changed independently.
    if (message?.type === "DUSK_UI_UNLOCK") {
      return await withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
        if (isUnlocked()) return { ok: true, accounts: getAccounts() };
        const mnemonic = await unlockVault(message.password);
        await ensureEngineConfigured();
        await unlockWithMnemonic(mnemonic);
        // Contacts kept in plain text before they were encrypted move into
        // this wallet's record (background/index.js does the same).
        await moveLegacyContacts(engineContactsVault(localEngineCall)).catch(() => {});
        return { ok: true, accounts: getAccounts() };
      });
    }

    if (message?.type === "DUSK_UI_LOCK") {
      return await withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
        lock();
        if (isUnlocked()) throw new Error("Wallet lock did not complete");
        return { ok: true };
      });
    }

    if (message?.type === "DUSK_UI_RESET_WALLET") {
      return await withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
        lock();
        if (isUnlocked()) throw new Error("Wallet lock did not complete");
        await beginReset();
        await clearPermissions();
        await clearVault();
        // Nothing of the old wallet stays: its transactions, shielded notes
        // and history. A store that can't be cleared fails the reset and keeps
        // it pending (walletReset.js).
        await finishReset();
        return { ok: true };
      });
    }

    if (message?.type === "DUSK_UI_CREATE_WALLET") {
      return await withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
        const { mnemonic, password } = message;
        if (!mnemonic || !password) {
          throw rpcError(ERROR_CODES.INVALID_PARAMS, "mnemonic and password required");
        }
        if (await loadVault()) {
          throw rpcError(ERROR_CODES.UNAUTHORIZED, "Reset the existing wallet before replacing it");
        }
        if (isUnlocked()) {
          throw rpcError(ERROR_CODES.UNAUTHORIZED, "Lock or reset the current wallet first");
        }
        // A reset that couldn't clear the old wallet's data finishes first.
        const { pending, keepContactsOf } = await finishPendingReset();
        if (keepContactsOf) {
          // A restore cut short before its vault: its wallet's contacts stay
          // if this is that wallet, and go if it's another.
          await keepOnlyContactsOf(await walletIdOf(String(mnemonic)));
        } else {
          // A new wallet starts with no contacts: any kept here are another's.
          await clearContacts();
        }
        await createVault(mnemonic, password);
        if (pending) await endReset();
        await ensureEngineConfigured();
        await unlockWithMnemonic(String(mnemonic));
        return { ok: true, accounts: getAccounts() };
      });
    }

    // A forgotten password: the wallet restored from its recovery phrase in
    // place of the one here, as background/index.js does it.
    if (message?.type === "DUSK_UI_RESTORE_WALLET") {
      return await withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
        const { mnemonic, password } = message;
        if (!mnemonic || !password) {
          throw rpcError(ERROR_CODES.INVALID_PARAMS, "mnemonic and password required");
        }
        if (isUnlocked()) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Lock the wallet first");
        const walletId = await walletIdOf(String(mnemonic));
        lock();
        // Noted with the wallet it makes until that wallet's vault is.
        await beginReset({ keepContactsOf: walletId });
        await clearPermissions();
        await clearWalletData({ keepContactsOf: walletId });
        await clearVault();
        await createVault(mnemonic, password);
        await endReset();
        await ensureEngineConfigured();
        await unlockWithMnemonic(String(mnemonic));
        return { ok: true, accounts: getAccounts() };
      });
    }

    // UI checks status
    if (message?.type === "DUSK_UI_STATUS") {
      const vault = await loadVault();
      const status = engineStatus();
      return {
        hasVault: Boolean(vault),
        isUnlocked: status.isUnlocked,
        accounts: status.accounts,
      };
    }

    // UI switches network by setting a new node URL
    if (message?.type === "DUSK_UI_SET_NODE_URL") {
      const nodeUrl = String(message?.nodeUrl ?? "").trim();
      const proverUrl =
        message?.proverUrl !== undefined && message?.proverUrl !== null
          ? String(message.proverUrl).trim()
          : "";
      const archiverUrl =
        message?.archiverUrl !== undefined && message?.archiverUrl !== null
          ? String(message.archiverUrl).trim()
          : "";
      try {
        // eslint-disable-next-line no-new
        new URL(nodeUrl);
      } catch {
        throw rpcError(ERROR_CODES.INVALID_PARAMS, "Invalid node URL");
      }

      if (proverUrl) {
        try {
          // eslint-disable-next-line no-new
          new URL(proverUrl);
        } catch {
          throw rpcError(ERROR_CODES.INVALID_PARAMS, "Invalid prover URL");
        }
      }
      if (archiverUrl) {
        try {
          // eslint-disable-next-line no-new
          new URL(archiverUrl);
        } catch {
          throw rpcError(ERROR_CODES.INVALID_PARAMS, "Invalid archiver URL");
        }
      }

      const nextSettings = await setSettings({
        nodeUrl,
        ...(proverUrl ? { proverUrl } : {}),
        ...(archiverUrl ? { archiverUrl } : {}),
      });
      // Apply immediately.
      configure({
        nodeUrl: nextSettings.nodeUrl,
        proverUrl: nextSettings.proverUrl,
        archiverUrl: nextSettings.archiverUrl,
      });

      return {
        ok: true,
        nodeUrl: nextSettings.nodeUrl,
        proverUrl: nextSettings.proverUrl,
        archiverUrl: nextSettings.archiverUrl,
        networkName: networkNameFromNodeUrl(nextSettings.nodeUrl),
      };
    }

    // UI asks for overview data (network + addresses + balance)
    if (message?.type === "DUSK_UI_OVERVIEW") {
      const vault = await loadVault();
      const settings = await ensureEngineConfigured();
      const status = engineStatus();

      const activeOrigin = null;
      const activeConnected = null;

      let addresses = [];
      let balance = null;
      let balanceError = null;

      let shieldedBalance = null;
      let shieldedSync = null;
      let shieldedError = null;

      // Recent activity (transaction list) scoped to the current node URL.
      let txs = [];
      try {
        txs = await listTxs({ nodeUrl: settings.nodeUrl });
      } catch {
        txs = [];
      }

      // Account names (stored per walletId, which is profile 0 account).
      let accountNames = {};
      try {
        const walletId = status?.isUnlocked ? String(status?.accounts?.[0] ?? "").trim() : "";
        accountNames = walletId ? await getAccountNames(walletId) : {};
      } catch {
        accountNames = {};
      }

      if (status.isUnlocked) {
        let publicBalanceAvailable = false;

        try {
          addresses = getAddresses() ?? [];
        } catch {
          // ignore
        }

        try {
          const bal = await getPublicBalance();
          balance = { nonce: bal.nonce.toString(), value: bal.value.toString() };
          publicBalanceAvailable = true;
        } catch (e) {
          balanceError = e?.message ?? String(e);
        }

        try {
          shieldedSync = getShieldedStatus();
        } catch {
          shieldedSync = null;
        }

        if (publicBalanceAvailable) {
          try {
            // Kick off incremental sync (non-blocking)
            await startShieldedSync({ force: false });
          } catch {
            // ignore
          }

          try {
            const sb = await getShieldedBalance();
            shieldedBalance = {
              value: sb.value?.toString?.() ?? String(sb.value),
              spendable: sb.spendable?.toString?.() ?? String(sb.spendable),
            };
          } catch (e) {
            shieldedError = e?.message ?? String(e);
          }
        } else {
          shieldedError = balanceError;
        }
      }

      return {
        hasVault: Boolean(vault),
        isUnlocked: status.isUnlocked,
        accounts: status.accounts,
        selectedAccountIndex: status.selectedAccountIndex,
        accountCount: settings.accountCount ?? 1,
        addresses,
        balance,
        balanceError,
        shieldedBalance,
        shieldedSync,
        shieldedError,
        nodeUrl: settings.nodeUrl,
        proverUrl: settings.proverUrl,
        archiverUrl: settings.archiverUrl,
        nftMetadataEnabled: settings.nftMetadataEnabled !== false,
        ipfsGateway: settings.ipfsGateway ?? "",
        hideBalances: settings.hideBalances === true,
        customGas: settings.customGas ?? null,
        networkName: networkNameFromNodeUrl(settings.nodeUrl),
        activeOrigin,
        activeConnected,
        txs,
        accountNames,
      };
    }

    // UI initiated transaction (from the wallet popup)
    if (message?.type === "DUSK_UI_SEND_TX") {
      const status = engineStatus();
      if (!status.isUnlocked) {
        throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
      }
      // What this send and its watcher keep is dropped after a reset meanwhile.
      const txEpoch = await getTxEpoch();
      const patch = (txHash, value) => patchTxMeta(txHash, value, { epoch: txEpoch });

      await ensureEngineConfigured();
      // Fetch live gas price from node (cached for 30s) to use as default.
      let dynamicPrice;
      try {
        const gasData = await getCachedGasPrice();
        dynamicPrice = gasData?.median;
      } catch {
        // Ignore errors, will fall back to static default
      }
      const baseParams = applyTxDefaults(message.params ?? {}, { dynamicPrice });
      const result = await sendTransaction(baseParams);

      // Persist metadata (see background/index.js comments).
      const hash = result?.hash ?? "";
      try {
        const nodeUrl = (await getSettings())?.nodeUrl ?? "";

        if (hash) {
          // The profile that paid, as the extension keeps it: a stake's own
          // profile may not be the one selected.
          const profileIndex =
            baseParams?.profileIndex !== undefined && baseParams?.profileIndex !== null
              ? Number(baseParams.profileIndex) || 0
              : Number(status.selectedAccountIndex ?? 0) || 0;
          const record = submittedTxMeta(baseParams, { origin: "Wallet", nodeUrl, profileIndex, nullifiers: result?.nullifiers }, walletSendFields(baseParams, message));
          const { pendingNullifiers } = record;
          await putTxMeta(hash, record, { epoch: txEpoch });

          // Fire-and-forget: wait for EXECUTED/REMOVED and patch local activity.
          (async () => {
            try {
              const timeoutMs = 180_000;
              const removedWatcher = waitTxRemoved(hash, { timeoutMs }).catch((e) => {
                if (/removed watcher not available/i.test(String(e?.message ?? e))) {
                  return new Promise(() => {});
                }
                throw e;
              });
              const executedEvent = await waitForTxExecution(
                waitTxExecuted(hash, { timeoutMs }),
                removedWatcher,
                async () => {
                  const meta = await getTxMeta(hash);
                  const presence = await classifyTxPresence(nodeUrl, hash);
                  const now = Date.now();
                  const isShielded = pendingNullifiers.length > 0;

                  if (presence.state === "executed_success" || presence.state === "executed_failed") {
                    const ok = presence.state === "executed_success";
                    await patch(hash, {
                      status: ok ? "executed" : "failed",
                      error: ok ? undefined : presence.error || undefined,
                      executedAt: now,
                      lastCheckedAt: now,
                      reservationStatus: isShielded ? "spent" : meta?.reservationStatus,
                      reservationUpdatedAt: isShielded ? now : meta?.reservationUpdatedAt,
                    });
                  } else if (presence.state === "not_found") {
                    await patch(hash, {
                      status: "unknown",
                      lastCheckedAt: now,
                      recoveryReason: "removed_unconfirmed",
                      reservationStatus: isShielded ? "pending" : meta?.reservationStatus,
                    });
                  } else if (presence.state === "mempool") {
                    await patch(hash, {
                      status: "mempool",
                      lastCheckedAt: now,
                      reservationStatus: isShielded ? "pending" : meta?.reservationStatus,
                    });
                  } else {
                    await patch(hash, {
                      status: "unknown",
                      lastCheckedAt: now,
                      recoveryReason: "removed_unconfirmed",
                      reservationStatus: isShielded ? "pending" : meta?.reservationStatus,
                    });
                  }
                }
              );
              const ok = executionEventOk(executedEvent);
              const error = ok ? "" : executionEventError(executedEvent);

              const now = Date.now();
              await patch(hash, {
                status: ok ? "executed" : "failed",
                error: ok ? undefined : (error || undefined),
                executedAt: now,
                lastCheckedAt: now,
                ...(pendingNullifiers.length
                  ? { reservationStatus: "spent", reservationUpdatedAt: now }
                  : {}),
              });

              const presence = await classifyTxPresence(nodeUrl, hash);
              if (presence.state === "executed_success" || presence.state === "executed_failed") {
                const finalizedOk = ok && presence.state === "executed_success";
                await patch(hash, {
                  ...finalizedTxMetadata(presence.tx),
                  status: finalizedOk ? "executed" : "failed",
                  error: finalizedOk ? undefined : error || presence.error || undefined,
                  lastCheckedAt: Date.now(),
                });
              }
            } catch (e) {
              const meta = await getTxMeta(hash);
              const hasExecution = meta?.status === "executed" || meta?.status === "failed";
              const timedOut = /timed out/i.test(String(e?.message ?? e));
              if (!hasExecution && timedOut && meta?.recoveryReason === "removed_unconfirmed") {
                const presence = await classifyTxPresence(nodeUrl, hash);
                const now = Date.now();
                if (presence.state === "executed_success" || presence.state === "executed_failed") {
                  const ok = presence.state === "executed_success";
                  await patch(hash, {
                    status: ok ? "executed" : "failed",
                    error: ok ? undefined : presence.error || undefined,
                    executedAt: now,
                    lastCheckedAt: now,
                    reservationStatus: pendingNullifiers.length ? "spent" : meta?.reservationStatus,
                    reservationUpdatedAt: pendingNullifiers.length ? now : meta?.reservationUpdatedAt,
                  });
                } else if (presence.state === "not_found") {
                  await patch(hash, {
                    status: "removed",
                    removedAt: now,
                    lastCheckedAt: now,
                    recoveryReason: "removed",
                    reservationStatus: pendingNullifiers.length ? "recoverable" : meta?.reservationStatus,
                    reservationUpdatedAt: pendingNullifiers.length ? now : meta?.reservationUpdatedAt,
                  });
                } else {
                  await patch(hash, { lastCheckedAt: now });
                }
              } else if (!hasExecution) {
                await patch(hash, {
                  status: "unknown",
                  lastCheckedAt: Date.now(),
                  recoveryReason: timedOut ? "watcher_timeout" : "watcher_unavailable",
                });
              }
            } finally {
              // Reconcile shielded state after tx execution.
              startShieldedSync({ force: false }).catch(() => {});
            }
          })().catch(() => {});
        }
      } catch {
        // best-effort
      }

      return {
        ok: true,
        result: {
          hash: result.hash,
          nonce: result.nonce?.toString?.() ?? String(result.nonce),
        },
      };
    }

    return { ok: false, error: "Unknown message" };
  } catch (err) {
    return { error: serializeError(err) };
  }
}
