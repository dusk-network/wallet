// Local (in-process) message handler implementing a subset of the extension
// background message API.
//
// This lets the same UI (popup/full) run without chrome.runtime messaging,
// which is how we reuse it in Tauri desktop/mobile.

import { createVault, loadVault, unlockVault } from "../shared/vault.js";
import { getSettings, setSettings } from "../shared/settings.js";
import { getAccountNames } from "../shared/accountNames.js";
import { applyTxDefaults } from "../shared/txDefaults.js";
import { networkNameFromNodeUrl } from "../shared/network.js";
import { ERROR_CODES, rpcError } from "../shared/errors.js";
import { getTxMeta, listTxs, patchTxMeta, putTxMeta } from "../shared/txStore.js";
import { bytesToHex } from "../shared/bytes.js";
import {
  executionEventError,
  executionEventOk,
  waitForTxExecution,
} from "../shared/txExecution.js";
import { classifyTxPresence, finalizedTxMetadata } from "../shared/txLifecycle.js";
import { handleUiCommand } from "./uiCommands.js";
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
  getShieldedStatus,
  isUnlocked,
  lock,
  sendTransaction,
  selectAccountIndex,
  setShieldedCheckpointNow,
  startShieldedSync,
  unlockWithMnemonic,
  waitTxExecuted,
  waitTxRemoved,
  getMinimumStake,
  getStakeInfo,
  getStakeOwnerStatus,
  getSozuStatus,
} from "../shared/walletEngine.js";

// Prevent users from accidentally triggering expensive vault / stronghold
// operations multiple times (e.g. double-clicking "Create wallet" while
// Argon2 + snapshot encryption is running).
let unlockInFlight = null;
let createWalletInFlight = null;

function nullifierHexes(value) {
  const out = [];
  for (const n of Array.isArray(value) ? value : []) {
    try {
      if (typeof n === "string") {
        const hex = n.trim();
        if (/^[0-9a-fA-F]+$/.test(hex)) out.push(hex.toLowerCase());
        continue;
      }
      const u8 = n instanceof Uint8Array ? n : new Uint8Array(n);
      const hex = bytesToHex(u8);
      if (hex) out.push(hex);
    } catch {
      // ignore invalid nullifier shapes
    }
  }
  return out;
}

function serializeError(err) {
  return {
    code: err?.code ?? ERROR_CODES.INTERNAL,
    message: err?.message ?? String(err),
    data: err?.data,
  };
}

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
  engine_selectAccount: selectAccountIndex,
};

/**
 * @param {any} message
 */
export async function localSend(message) {
  try {
    const common = await handleUiCommand(message, {
      engineCall: (method, params) => localEngineMethods[method](params ?? {}),
      ensureEngineConfigured,
      getEngineStatus: engineStatus,
    });
    if (common) return common;
    // UI wants to unlock
    if (message?.type === "DUSK_UI_UNLOCK") {
      // Fast path: if the engine is already unlocked, do not re-load the vault.
      // This helps onboarding flows where we may have just created/imported a
      // wallet and already unlocked it locally.
      if (isUnlocked()) {
        return { ok: true, accounts: getAccounts() };
      }

      // Coalesce multiple unlock clicks into one expensive vault decrypt.
      if (unlockInFlight) {
        return await unlockInFlight;
      }

      unlockInFlight = (async () => {
        const password = message.password;
        const mnemonic = await unlockVault(password);
        await ensureEngineConfigured();
        // Unlock uses the decrypted mnemonic.
        await unlockWithMnemonic(mnemonic);
        return { ok: true, accounts: getAccounts() };
      })();

      try {
        return await unlockInFlight;
      } finally {
        unlockInFlight = null;
      }
    }

    // UI wants to lock
    if (message?.type === "DUSK_UI_LOCK") {
      lock();
      return { ok: true };
    }

    // UI creates/imports wallet
    if (message?.type === "DUSK_UI_CREATE_WALLET") {
      // Coalesce multiple create/import clicks into one Stronghold write.
      if (createWalletInFlight) {
        return await createWalletInFlight;
      }

      createWalletInFlight = (async () => {
        const { mnemonic, password } = message;
        if (!mnemonic || !password) {
          throw rpcError(ERROR_CODES.INVALID_PARAMS, "mnemonic and password required");
        }
        await createVault(mnemonic, password);
        // UX improvement for local runtimes (Tauri/mobile/desktop): immediately
        // unlock the engine with the provided mnemonic. This avoids an extra
        // round-trip to Stronghold and makes onboarding feel instant.
        await ensureEngineConfigured();
        await unlockWithMnemonic(String(mnemonic));
        return { ok: true, accounts: getAccounts() };
      })();

      try {
        return await createWalletInFlight;
      } finally {
        createWalletInFlight = null;
      }
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
      const kind = String(baseParams?.kind ?? "");
      try {
        const nodeUrl = (await getSettings())?.nodeUrl ?? "";

        if (hash) {
          const pendingNullifiers = nullifierHexes(result?.nullifiers);
          await putTxMeta(hash, {
            origin: "Wallet",
            nodeUrl,
            kind,
            privacy: baseParams?.privacy ? String(baseParams.privacy) : undefined,
            profileIndex: Number(status.selectedAccountIndex ?? 0) || 0,
            ownerProfileIndex:
              baseParams?.ownerProfileIndex !== undefined && baseParams?.ownerProfileIndex !== null
                ? Number(baseParams.ownerProfileIndex) || 0
                : undefined,
            payment: baseParams?.payment ? String(baseParams.payment) : undefined,
            asset:
              message?.asset && typeof message.asset === "object"
                ? message.asset
                : undefined,
            to: baseParams?.to ? String(baseParams.to) : undefined,
            amount:
              baseParams?.amount !== undefined && baseParams?.amount !== null
                ? String(baseParams.amount)
                : undefined,
            deposit:
              baseParams?.deposit !== undefined && baseParams?.deposit !== null
                ? String(baseParams.deposit)
                : undefined,
            contractId:
              kind === "contract_call" && baseParams?.contractId
                ? String(baseParams.contractId)
                : undefined,
            fnName:
              kind === "contract_call" && baseParams?.fnName
                ? String(baseParams.fnName)
                : undefined,
            gasLimit: baseParams?.gas?.limit != null ? String(baseParams.gas.limit) : undefined,
            gasPrice: baseParams?.gas?.price != null ? String(baseParams.gas.price) : undefined,
            pendingNullifiers,
            reservationStatus: pendingNullifiers.length ? "pending" : undefined,
            reservationUpdatedAt: pendingNullifiers.length ? Date.now() : undefined,
            submittedAt: Date.now(),
            status: "submitted",
          });

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
                    await patchTxMeta(hash, {
                      status: ok ? "executed" : "failed",
                      error: ok ? undefined : presence.error || undefined,
                      executedAt: now,
                      lastCheckedAt: now,
                      reservationStatus: isShielded ? "spent" : meta?.reservationStatus,
                      reservationUpdatedAt: isShielded ? now : meta?.reservationUpdatedAt,
                    });
                  } else if (presence.state === "not_found") {
                    await patchTxMeta(hash, {
                      status: "unknown",
                      lastCheckedAt: now,
                      recoveryReason: "removed_unconfirmed",
                      reservationStatus: isShielded ? "pending" : meta?.reservationStatus,
                    });
                  } else if (presence.state === "mempool") {
                    await patchTxMeta(hash, {
                      status: "mempool",
                      lastCheckedAt: now,
                      reservationStatus: isShielded ? "pending" : meta?.reservationStatus,
                    });
                  } else {
                    await patchTxMeta(hash, {
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
              await patchTxMeta(hash, {
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
                const finalizedOk = presence.state === "executed_success";
                await patchTxMeta(hash, {
                  ...finalizedTxMetadata(presence.tx),
                  status: finalizedOk ? "executed" : "failed",
                  error: finalizedOk ? undefined : presence.error || undefined,
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
                  await patchTxMeta(hash, {
                    status: ok ? "executed" : "failed",
                    error: ok ? undefined : presence.error || undefined,
                    executedAt: now,
                    lastCheckedAt: now,
                    reservationStatus: pendingNullifiers.length ? "spent" : meta?.reservationStatus,
                    reservationUpdatedAt: pendingNullifiers.length ? now : meta?.reservationUpdatedAt,
                  });
                } else if (presence.state === "not_found") {
                  await patchTxMeta(hash, {
                    status: "removed",
                    removedAt: now,
                    lastCheckedAt: now,
                    recoveryReason: "removed",
                    reservationStatus: pendingNullifiers.length ? "recoverable" : meta?.reservationStatus,
                    reservationUpdatedAt: pendingNullifiers.length ? now : meta?.reservationUpdatedAt,
                  });
                } else {
                  await patchTxMeta(hash, { lastCheckedAt: now });
                }
              } else if (!hasExecution) {
                await patchTxMeta(hash, {
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
