// Local (in-process) message handler implementing a subset of the extension
// background message API.
//
// This lets the same UI (popup/full) run without chrome.runtime messaging,
// which is how we reuse it in Tauri desktop/mobile.

import { checkResetPassword, clearVault, countVaultWallets, createVault, loadVault, unlockVault } from "../shared/vault.js";
import { getSettings, normalizeAutoLock, rememberNodeChain, setSettings } from "../shared/settings.js";
import { getAccountNames } from "../shared/accountNames.js";
import { clearAllPermissions } from "../shared/permissions.js";
import { WALLET_LIFECYCLE_LOCK, withStorageLock } from "../shared/storageLock.js";
import { applyTxDefaults, defaultGasPriceOf } from "../shared/txDefaults.js";
import { networkNameFromNodeUrl } from "../shared/network.js";
import { listedSettings } from "../shared/nodeNetwork.js";
import { endpointProblem } from "../shared/securityPolicy.js";
import { chainIdForChoice, checkAllEndpoints, checkEveryMs, checkNode, getNetworkStatus, isStatusStale, readChainId, resetNetworkStatus, statusChainRefusal, statusWords } from "../shared/networkStatus.js";
import { WALLET_MESSAGE_EVENT } from "../shared/constants.js";
import { ERROR_CODES, rpcError } from "../shared/errors.js";
import { serializeError } from "../shared/transport.js";
import { forgetTxs, getTxEpoch, getTxMeta, listTxs, onTxSettled, patchTxMeta, putTxMeta } from "../shared/txStore.js";
import { sendingProfile, signedTxFields, submittedTxMeta, typedRecipientName, unclearTxMeta, walletSendFields } from "../shared/txRecord.js";
import { beginReset, clearWalletData, endReset, finishPendingReset, finishReset } from "../shared/walletReset.js";
import {
  executionEventError,
  executionEventOk,
  waitForTxExecution,
} from "../shared/txExecution.js";
import { accountNonce, accountNonceNow, classifyTxPresence, finalizedTxMetadata, handedOverState, sentMeanwhileOf } from "../shared/txLifecycle.js";
import { isShieldedTxMeta, recheckTx } from "../shared/txReconcile.js";
import { engineContactsVault, handleUiCommand, sendParams } from "./uiCommands.js";
import { sendPasswordLimit, sendPasswordOnce } from "../shared/sendPassword.js";
import { handleWalletCommand, keepWalletShown, walletsShown } from "./walletCommands.js";
import { getWalletDirectory } from "../shared/wallets.js";
import { WAITING_NOTICE, arrivalNotice, askForNotices, mayNotify, noticesState, saidNoticesOff } from "../shared/phoneNotices.js";
import { appNoticesAllowed, askAppNotices, settleAppArrival, showAppNotice, waitAppSend, watchAppArrival } from "../platform/notices.js";
import { incomingNoticeToken, isIncomingNoticeToken, noticeTokenFor, takeNoticeToken } from "../shared/noticeTokens.js";
import { isPhone } from "../ui/lib/device.js";
import { clearContacts, contactsStore, keepOnlyContactsOf, moveLegacyContacts } from "../shared/contactsStore.js";
import { formatDusk } from "../shared/amount.js";
import { shortAddress } from "../ui/lib/strings.js";
import { cancelWaitingSend, checkedOnNode, dropUnsent, followHandedOver, forgetWent, noteHandingOver, reviewedParams, sendHeld, sendsReadBegins, sendWhenReachable, stopWaitingSends, waitingForNetwork, waitingRecordOf, waitingSendsOf } from "../shared/waitingSends.js";
import { withKeptBalances } from "../shared/keptBalances.js";
import { TX_KIND } from "../shared/constants.js";
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
  cancelSend,
  resendSend,
  forgetHandedOver,
  handedOverTx,
  rebroadcastTx,
  sendUnderWay,
  lastOwnNonce,
  setHandOverHook,
  selectAccountIndex,
  setShieldedCheckpointNow,
  startShieldedSync,
  unlockWallets,
  switchWallet,
  addWallet,
  removeWallet,
  walletAccountsOf,
  getWallets,
  getWalletKey,
  walletIdOf,
  waitTxExecuted,
  waitTxRemoved,
  getMinimumStake,
  getStakeInfo,
  getStakeOwnerStatus,
  getSozuStatus,
} from "../shared/walletEngine.js";

// A node's chain ID being asked for again: the app has no status checks, so
// a node whose chain ID couldn't be read when it was chosen is asked as the
// wallet draws, once at a time and at most every 30 seconds, as the
// extension's checks do. Once read, the page draws again (popup/app.js).
let askingChain = null;
let chainAskedAt = -Infinity;

// A notice's tap is anyone's to send: Android opens the app for any other
// app, with what it likes in the tap. The wallet's own notice carries a token
// made for its send and kept on the phone (shared/noticeTokens.js): only a
// tap with it opens the send, and only its news goes on the send's record
// (DUSK_UI_TX_NOTICED). One token a send, whichever notice asks first.
const noticeTokenOf = (hash, walletId) => noticeTokenFor(hash, String(walletId ?? "")).catch(() => "");

// What a payment's notice says of it, as Activity does: how much, but not
// while balances are hidden, and to whom: the contact's name, a profile's of
// this wallet, the .dusk name it was sent to, else its short address.
async function paymentOf({ kind, to, amount, toName, walletId, memo }) {
  if (String(kind ?? "") !== TX_KIND.TRANSFER || !to) return {};
  const hidden = (await getSettings().catch(() => null))?.hideBalances === true;
  const address = String(to);
  const contacts = await contactsStore(engineContactsVault(localEngineCall))
    .list()
    .catch(() => []);
  const own = isUnlocked() ? [getAccounts(), getAddresses()].map((list) => (Array.isArray(list) ? list.indexOf(address) : -1)).find((i) => i >= 0) : undefined;
  const label = own === undefined ? "" : String((await getAccountNames(String(walletId ?? getAccounts()[0] ?? "")).catch(() => ({})))?.[String(own)] ?? "").trim() || `Profile ${own + 1}`;
  const name = contacts.find((contact) => contact?.address === address)?.name || label || typedRecipientName(toName) || shortAddress(address);
  return { amount: hidden || !amount ? "" : formatDusk(String(amount)), to: name, memo: String(memo ?? "") };
}

// A payment's arrival as a notice, in the app on a phone: once the person
// asked for notices (phoneNotices.js) and while Android lets the app show
// them, read each time, and only while they're away from it: what came of
// it, how much and to whom, but on a locked phone that hides what notices
// say, only what came of it. Heard here, Android stops looking for it
// (watchArrival); each send's notice shows once.
async function noticeArrival({ hash, ok, tx }) {
  if (!isPhone()) return;
  settleAppArrival(hash).catch(() => {});
  if (globalThis.document?.visibilityState !== "hidden") return;
  if (!(await mayNotify(appNoticesAllowed))) return;
  const { title, network, body } = arrivalNotice({ kind: tx.kind, ok, nodeUrl: tx.nodeUrl, ...(await paymentOf(tx)) });
  await showAppNotice({ title, body, publicBody: network, hash, token: await noticeTokenOf(hash, tx.walletId) }).catch(() => {});
}

// However a send's outcome is learned, while the app is away.
onTxSettled((hash, tx) => {
  noticeArrival({ hash, ok: tx.status === "executed", tx }).catch(() => {});
});

// A send the person asked to hear of, for Android to look for once the app
// leaves the screen, when it cuts the page's network (android/ArrivalJob.kt):
// its notice, for either outcome, comes from there.
async function watchArrival(hash, tx) {
  if (!hash || !isPhone() || !(await mayNotify(appNoticesAllowed))) return;
  const { kind, nodeUrl, walletId } = tx;
  const payment = await paymentOf(tx);
  const went = arrivalNotice({ kind, ok: true, nodeUrl, ...payment });
  const failed = arrivalNotice({ kind, ok: false, nodeUrl, ...payment });
  await watchAppArrival({
    hash,
    nodeUrl,
    title: went.title,
    failTitle: failed.title,
    body: went.body,
    publicBody: went.network,
    wallet: String(walletId ?? ""),
    token: await noticeTokenOf(hash, walletId),
  });
}

// A send handed to the node, followed as each one is: Android looks for it
// once the app leaves the screen, where the person asked for notices
// (watchArrival); one found on the node after a hand-over with no clear
// answer (`found`) is looked up at once; and the wallet waits for its block,
// or for it to drop out, keeping what came of it on its record.
function followSent(hash, { record, nodeUrl, txEpoch, found = false }) {
  const patch = (txHash, value) => patchTxMeta(txHash, value, { epoch: txEpoch });
  const pendingNullifiers = Array.isArray(record?.pendingNullifiers) ? record.pendingNullifiers : [];
  watchArrival(hash, record).catch(() => {});
  if (found) {
    recheckTx(hash)
      .then(({ event }) => tellPage({ type: "DUSK_UI_TX_STATUS", ...event }))
      .catch(() => {});
  }

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

// A payment from Send waiting for the network, told to Android for the app's
// time away (android/ArrivalJob.kt's Waiting): the app signs and sends only
// while it's open, so the notice says it goes out once the app's opened
// again, and once the network's back, to open it to send it. Told as one
// starts or stops waiting, wherever Android lets the app show notices, as
// for money coming in, whether or not the person asked to hear of arrivals
// (Tell me when it arrives): a payment that hasn't gone out is said so
// either way (Chen's, filmed: never asked, the app put away, no notice
// came). None for none.
let waitingTold = Promise.resolve("");
function tellWaitingForApp() {
  if (!isPhone()) return waitingTold;
  waitingTold = waitingTold
    .then(async (said) => {
      const [first] = waitingForNetwork();
      const setup = first && (await appNoticesAllowed().catch(() => false)) ? { wallet: first.walletId, nodeUrl: first.nodeUrl, ...WAITING_NOTICE } : null;
      const key = JSON.stringify(setup);
      if (key !== said) await waitAppSend(setup).catch(() => {});
      return key;
    })
    .catch(() => "");
  return waitingTold;
}

// How the payments from Send that wait for the network reach the wallet, as
// the extension's background has them: the node asked whether it answers and
// where one handed over stands, the engine to call one off or forget one that
// never went, the page told whether one waits (waitingSends.js).
const waitingHost = {
  answers: async () => (await checkNode((await getSettings()).nodeUrl))?.nodeStatus === "online",
  cancelInEngine: async (sendId) => cancelSend({ sendId }),
  check: (record) => handedOverState(record.nodeUrl, record),
  release: async (sendId) => forgetHandedOver({ sendId }),
  underWay: async (sendId) => sendUnderWay({ sendId })?.underWay === true,
  // Whether the account sent something else while one waited: its nonce on
  // the node now, and the last the wallet's own sends took.
  nonceNow: (record) => accountNonceNow(record.nodeUrl, record.account),
  // What the account sent while one waited, as the node says it, for its hold to name.
  meanwhile: (record, range) => sentMeanwhileOf(record.nodeUrl, { account: record.account, ...range, at: record.at }),
  chainNonce: (record) => accountNonce(record.nodeUrl, record.account),
  ownNonce: async (record) => lastOwnNonce({ profileIndex: Number(record.profileIndex) || 0 }).nonce,
  // Handed to the node: kept as a sent one, from when it was made, and looked
  // up by its ID at once; `unclear`, as a send with no clear answer.
  follow: async ({ record, hash, unclear = false }) => {
    const params = { kind: TX_KIND.TRANSFER, privacy: record.privacy, to: record.to, amount: record.lux, memo: record.memo };
    const sent = { walletId: record.walletId, origin: "Wallet", nodeUrl: record.nodeUrl, profileIndex: Number(record.profileIndex) || 0 };
    const extras = { toName: typedRecipientName(record.toName) };
    const meta = unclear ? unclearTxMeta(params, sent, extras) : { ...submittedTxMeta(params, sent, extras), submittedAt: Number(record.at) || Date.now() };
    await putTxMeta(hash, meta, { epoch: await getTxEpoch() });
    if (!unclear) {
      recheckTx(hash)
        .then(({ event }) => tellPage({ type: "DUSK_UI_TX_STATUS", ...event }))
        .catch(() => {});
    }
  },
  tell: (message) => {
    tellPage(message);
    if (message?.type === "DUSK_UI_SEND_WAITING") tellWaitingForApp();
  },
  // A payment began its first try: Android's told, as the app may be left before it's through.
  changed: () => {
    tellWaitingForApp();
  },
};

// A payment from Send is kept with its transaction's ID and nonce before the
// engine hands it to the node, on every try (waitingSends.js): one that can't
// be kept isn't handed over. Those being handed over as the app stopped are
// looked up on the node.
setHandOverHook(async ({ sendId, hash, nonce }) => {
  if (!(await noteHandingOver(sendId, { hash, nonce }, waitingHost))) throw new Error("Not kept");
});
followHandedOver(waitingHost).catch(() => {});

// As the app starts, nothing waits here: the payments waiting for the network
// live in this page, and one that waited as Android ended the app, or as the
// page went, is said not sent (waitingSends.js). What Android was told of it
// goes, its notice and its looks for the network with it (Astra's: started
// again, leaving the app said once more that a payment waits). Told again as
// the wallet's read, should this first word not reach it.
tellWaitingForApp();

// The wallet locks: a payment waiting for the network goes out only while its wallet is open.
async function lockWallet() {
  await stopWaitingSends("locked", waitingHost).catch(() => {});
  lock();
  tellWaitingForApp();
}

// Auto-lock in the app, as the extension's background does it: the wallet
// locks once it's gone this long without a press or a key in it (the page's
// DUSK_UI_ACTIVITY), looked at every half minute while the page runs, and as
// the page asks for anything, as when the app comes back to the front after
// Android stopped its timers. Immediately is the page's (popup/app.js).
const AUTO_LOCK_CHECK_MS = 30_000;
let lastActivity = Date.now();

async function lockIfIdle() {
  if (!isUnlocked()) return false;
  const minutes = Number((await getSettings())?.autoLockTimeoutMinutes ?? 0);
  if (!(minutes > 0) || Date.now() - lastActivity < minutes * 60_000) return false;
  return withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
    if (!isUnlocked()) return false;
    await lockWallet();
    tellPage({ type: "DUSK_UI_LOCK_STATE", isUnlocked: false, reason: "auto_lock" });
    return true;
  });
}

try {
  setInterval(() => lockIfIdle().catch(() => {}), AUTO_LOCK_CHECK_MS);
} catch {
  // No timers here.
}

function tellPage(message) {
  try {
    globalThis.window?.dispatchEvent(new CustomEvent(WALLET_MESSAGE_EVENT, { detail: message }));
  } catch {
    // no page to tell
  }
}

async function ensureEngineConfigured() {
  const settings = await getSettings();
  configure({
    nodeUrl: settings.nodeUrl,
    proverUrl: settings.proverUrl,
    archiverUrl: settings.archiverUrl,
    chainId: settings.chainId,
    accountCount: settings.accountCount,
    selectedAccountIndex: settings.selectedAccountIndex,
  });
  if (settings.chainId === null && !askingChain && Date.now() - chainAskedAt >= 30_000) {
    chainAskedAt = Date.now();
    askingChain = readChainId(settings.nodeUrl)
      .then((chainId) => rememberNodeChain(settings.nodeUrl, chainId))
      .then((changed) => {
        if (changed) tellPage({ type: "DUSK_UI_NETWORK_CHANGED" });
      })
      .catch(() => false)
      .finally(() => {
        askingChain = null;
      });
  }
  return settings;
}

// The node, prover and archiver, checked as the wallet draws, as the
// extension's background checks them: at most every 5 minutes, and after 30
// seconds while something fails. The page draws again once a check is done,
// for the header's dot to say what it found.
async function networkStatusFor(settings, { failing, read }) {
  const status = await getNetworkStatus();
  if (isStatusStale(status, checkEveryMs(status, { failing, read }))) {
    checkAllEndpoints({ nodeUrl: settings.nodeUrl, proverUrl: settings.proverUrl, archiverUrl: settings.archiverUrl })
      .then((next) => {
        if (statusWords(next) !== statusWords(status)) tellPage({ type: "DUSK_UI_NETWORK_CHANGED" });
      })
      .catch(() => {});
  }
  return status;
}

function engineStatus() {
  return {
    isUnlocked: isUnlocked(),
    accounts: isUnlocked() ? getAccounts() : [],
    addresses: isUnlocked() ? getAddresses() : [],
    selectedAccountIndex: isUnlocked() ? getSelectedAccountIndex() : 0,
    walletKey: getWalletKey(),
    wallets: getWallets(),
  };
}

// The engine's answer to an unlock or a switch, as the extension's engine gives it.
const unlockedNow = () => ({ accounts: getAccounts(), walletKey: getWalletKey(), wallets: getWallets() });

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
  engine_walletId: ({ mnemonic }) => walletIdOf(mnemonic),
  engine_switchWallet: async (params) => {
    await switchWallet(params);
    return unlockedNow();
  },
  engine_addWallet: addWallet,
  engine_removeWallet: removeWallet,
  engine_walletAccounts: walletAccountsOf,
  engine_contactsOpen: ({ records }) => openContactsRecords(records),
  engine_contactsSeal: ({ text }) => sealContactsRecord(text),
};

const localEngineCall = (method, params) => localEngineMethods[method](params ?? {});

/**
 * @param {any} message
 */
export async function localSend(message) {
  try {
    // A use of the wallet: a press or a key, or an unlock.
    if (message?.type === "DUSK_UI_ACTIVITY") {
      lastActivity = Date.now();
      return { ok: true };
    }
    // Gone long enough without one: locked before anything is answered.
    await lockIfIdle().catch(() => {});
    if (message?.type === "DUSK_UI_SET_AUTO_LOCK") {
      const next = await setSettings({ autoLockTimeoutMinutes: normalizeAutoLock(message.autoLockTimeoutMinutes ?? 0) });
      lastActivity = Date.now();
      return { ok: true, autoLockTimeoutMinutes: next.autoLockTimeoutMinutes };
    }
    const common = await handleUiCommand(message, {
      engineCall: localEngineCall,
      ensureEngineConfigured,
      getEngineStatus: engineStatus,
    });
    if (common) return common;
    // Switch, add, remove and rename wallets, and change the password.
    const wallets = await handleWalletCommand(message, {
      engineCall: localEngineCall,
      ensureEngineConfigured,
      getEngineStatus: async () => engineStatus(),
      // Locked as the extension's background locks it: the page is told,
      // and shows the unlock form (a switch that failed, a removal cut short).
      lock: async (reason = "remove") => {
        await lockWallet();
        tellPage({ type: "DUSK_UI_LOCK_STATE", isUnlocked: false, reason });
      },
      // Another wallet: what waited to go out on the one before doesn't.
      beforeSwitch: () => {
        stopWaitingSends("switched", waitingHost).catch(() => {});
      },
      walletsChanged: () => tellPage({ type: "DUSK_UI_WALLETS_CHANGED" }),
    });
    if (wallets) return wallets;
    // Wallet lifecycle operations share one lock so persisted and in-memory
    // identities cannot be changed independently.
    if (message?.type === "DUSK_UI_UNLOCK") {
      return await withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
        if (isUnlocked()) return { ok: true, accounts: getAccounts() };
        // Every wallet the password opens, the one unlocked last unlocked again.
        const { wallets } = await unlockVault(message.password);
        lastActivity = Date.now();
        await ensureEngineConfigured();
        await unlockWallets({ wallets, walletKey: (await getWalletDirectory().catch(() => ({}))).active });
        await keepWalletShown(unlockedNow());
        // Contacts kept in plain text before they were encrypted move into
        // this wallet's record (background/index.js does the same).
        await moveLegacyContacts(engineContactsVault(localEngineCall)).catch(() => {});
        return { ok: true, accounts: getAccounts() };
      });
    }

    if (message?.type === "DUSK_UI_LOCK") {
      return await withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
        await lockWallet();
        if (isUnlocked()) throw new Error("Wallet lock did not complete");
        return { ok: true };
      });
    }

    if (message?.type === "DUSK_UI_RESET_WALLET") {
      return await withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
        // The password first, as for removing a wallet: a reset wipes them all.
        if (await loadVault()) await checkResetPassword(message.password);
        await lockWallet();
        if (isUnlocked()) throw new Error("Wallet lock did not complete");
        await beginReset();
        await clearAllPermissions();
        await clearVault();
        // Nothing of the old wallet stays: its transactions, shielded notes
        // and history, its names and addresses, and the node it was on. A
        // store that can't be cleared fails the reset and keeps it pending
        // (walletReset.js).
        await finishReset();
        // On the default network from now on.
        await ensureEngineConfigured();
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
        const wallet = await createVault(mnemonic, password);
        if (pending) await endReset();
        await ensureEngineConfigured();
        await unlockWallets({ wallets: [{ ...wallet, mnemonic: String(mnemonic) }], walletKey: wallet.id });
        // A phrase made here has no history: its shielded sync starts now.
        if (message.fresh === true) await setShieldedCheckpointNow({ profileIndex: 0 }).catch(() => {});
        await keepWalletShown(unlockedNow());
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
        // Mainnet, Testnet or Devnet stays: a restore isn't a move to another network.
        const network = listedSettings(String((await getSettings())?.nodeUrl ?? ""));
        await lockWallet();
        // Noted with the wallet it makes until that wallet's vault is.
        await beginReset({ keepContactsOf: walletId });
        await clearAllPermissions();
        await clearWalletData({ keepContactsOf: walletId });
        await clearVault();
        const restored = await createVault(mnemonic, password);
        await endReset();
        if (network) await setSettings(network);
        await ensureEngineConfigured();
        await unlockWallets({ wallets: [{ ...restored, mnemonic: String(mnemonic) }], walletKey: restored.id });
        await keepWalletShown(unlockedNow());
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
      // Each an https address, or plain http on this computer only, as the extension takes them.
      const problem = endpointProblem(nodeUrl, "node") || (proverUrl && endpointProblem(proverUrl, "prover")) || (archiverUrl && endpointProblem(archiverUrl, "archiver"));
      if (problem) throw rpcError(ERROR_CODES.INVALID_PARAMS, problem);

      // The chain ID the node signs for, fixed with it, as the background fixes it.
      const chainId = await chainIdForChoice(nodeUrl, { accept: Number.isInteger(message?.acceptChain) ? message.acceptChain : null });
      // What a check said of the network before is for that one.
      await resetNetworkStatus();
      const nextSettings = await setSettings({
        nodeUrl,
        chainId,
        ...(proverUrl ? { proverUrl } : {}),
        ...(archiverUrl ? { archiverUrl } : {}),
      });
      // Apply immediately.
      configure({
        nodeUrl: nextSettings.nodeUrl,
        proverUrl: nextSettings.proverUrl,
        archiverUrl: nextSettings.archiverUrl,
        chainId: nextSettings.chainId,
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
      tellWaitingForApp();
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

      // Recent activity (transaction list) scoped to the current node URL
      // and the wallet unlocked.
      let txs = [];
      let txsRead = false;
      // A payment gone out after this read began can't be among them (forgetWent).
      const txsReadBegan = sendsReadBegins();
      try {
        txs = status.isUnlocked ? await listTxs({ nodeUrl: settings.nodeUrl, walletId: String(status.accounts?.[0] ?? "") }) : [];
        txsRead = true;
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

      const networkStatus = await networkStatusFor(settings, { failing: Boolean(balanceError) || !Number.isInteger(settings.chainId), read: Boolean(balance) && !balanceError });
      // Payments handed over as the app stopped, asked of the node as the
      // wallet draws, at most every 10 seconds: the page hears what changed.
      followHandedOver(waitingHost, { every: 10_000 }).catch(() => {});
      // What couldn't be read now, as with no signal: what was read last on
      // this phone, said to be maybe out of date; what was read, kept.
      const kept = status.isUnlocked
        ? await withKeptBalances(
            { nodeUrl: settings.nodeUrl, account: String(status.accounts?.[Number(status.selectedAccountIndex) || 0] ?? "") },
            { balance, shieldedBalance }
          ).catch(() => ({}))
        : {};
      // A payment said Sent on Home after it waited goes once its block's in,
      // by the sends read above, and the balance was read after them.
      if (status.isUnlocked) {
        await forgetWent({ walletId: String(status.accounts?.[0] ?? ""), nodeUrl: settings.nodeUrl }, txsRead ? txs : null, { balanceRead: Boolean(balance) && !balanceError, read: txsReadBegan }).catch(() => {});
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
        ...kept,
        nodeUrl: settings.nodeUrl,
        proverUrl: settings.proverUrl,
        archiverUrl: settings.archiverUrl,
        nftMetadataEnabled: settings.nftMetadataEnabled !== false,
        ipfsGateway: settings.ipfsGateway ?? "",
        hideBalances: settings.hideBalances === true,
        incomingNotices: settings.incomingNotices !== false,
        lockOnLeave: settings.lockOnLeave === true,
        autoLockTimeoutMinutes: settings.autoLockTimeoutMinutes ?? 15,
        sendPasswordLimit: (await sendPasswordLimit())?.toString() ?? null,
        customGas: settings.customGas ?? null,
        chainId: settings.chainId,
        chainRefusal: statusChainRefusal(networkStatus, settings.nodeUrl, settings.chainId),
        networkName: networkNameFromNodeUrl(settings.nodeUrl),
        networkStatus,
        activeOrigin,
        activeConnected,
        txs,
        accountNames,
        // Payments from Send waiting for the network, or not sent: this wallet's on this node.
        waitingSends: status.isUnlocked ? await waitingSendsOf({ walletId: String(status.accounts?.[0] ?? ""), nodeUrl: settings.nodeUrl }).catch(() => []) : [],
        // Each wallet the switcher shows, and the one unlocked.
        wallets: await walletsShown(status).catch(() => []),
        walletKey: status.walletKey,
        // Every wallet the vault holds, those another password opens too.
        walletsHere: await countVaultWallets().catch(() => null),
      };
    }

    // Arrival notices on a phone: where they stand, the question Android asks
    // when the person taps Tell me when it arrives, and Sent having said they're off.
    if (message?.type === "DUSK_UI_NOTICES") return { ok: true, state: await noticesState(appNoticesAllowed) };
    if (message?.type === "DUSK_UI_NOTICES_ASK") {
      const state = await askForNotices(askAppNotices, appNoticesAllowed);
      // The send on Sent, on its way as the person asked: looked for once they leave.
      const meta = message.hash ? await getTxMeta(String(message.hash)).catch(() => null) : null;
      if (meta && !["executed", "failed", "removed"].includes(meta.status)) await watchArrival(String(message.hash), meta).catch(() => {});
      // Or still waiting for the network: Android says so while the app's away.
      tellWaitingForApp();
      return { ok: true, state };
    }
    if (message?.type === "DUSK_UI_NOTICES_SAID") {
      await saidNoticesOff(appNoticesAllowed);
      return { ok: true };
    }
    // Notices for money coming in (android/ArrivalJob.kt): turned on or off in
    // Settings, and the open wallet's token for their taps.
    if (message?.type === "DUSK_UI_SET_INCOMING_NOTICES") {
      const next = await setSettings({ incomingNotices: message.on === true });
      return { ok: true, incomingNotices: next.incomingNotices !== false };
    }
    if (message?.type === "DUSK_UI_INCOMING_TOKEN") {
      const status = engineStatus();
      if (!status?.isUnlocked || !status.accounts?.[0]) return { ok: true, token: "" };
      return { ok: true, token: await incomingNoticeToken(String(status.accounts[0])) };
    }

    // The network checked now, as when the phone is back online.
    if (message?.type === "DUSK_UI_CHECK_NETWORK") {
      const settings = await getSettings();
      return { ok: true, networkStatus: await checkAllEndpoints({ nodeUrl: settings.nodeUrl, proverUrl: settings.proverUrl, archiverUrl: settings.archiverUrl }) };
    }

    // A page that shows asks whether the node answers, now and then.
    if (message?.type === "DUSK_UI_CHECK_NODE") return { ok: true, networkStatus: await checkNode((await getSettings()).nodeUrl) };

    // A notice's tap opened the app on its send: a tap is anyone's to send,
    // so it's the notice's only with the token made for that send's notice
    // (noticeTokenOf), taken once, and else nothing (null). The notice's news,
    // what Android heard of it in its block (android/ArrivalJob.kt), goes on
    // its record as the background's watcher's news would, where the record
    // has no final word yet, and is still kept: history's sync forgets one
    // it has, and history says what came of it. The page shows it while the
    // app reconnects; the lookup after brings the fee.
    if (message?.type === "DUSK_UI_TX_NOTICED") {
      const hash = String(message.hash ?? "").trim();
      const token = String(message.token ?? "");
      if (!hash) throw rpcError(ERROR_CODES.INVALID_PARAMS, "hash is required");
      // Money that came in to one of the open wallet's accounts, as Android's
      // job told it: its profile, to open the payment in, with the wallet's
      // token for those notices.
      if (message.account) {
        const status = engineStatus();
        // Locked, as by its auto-lock while the page still showed it open: the
        // page keeps the tap for the unlock rather than drop it.
        if (!status?.isUnlocked) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
        const accounts = (status.accounts ?? []).map(String);
        const profileIndex = accounts.indexOf(String(message.account));
        const ours = profileIndex >= 0 && (await isIncomingNoticeToken(accounts[0], token).catch(() => false));
        return { ok: true, result: ours ? { incoming: true, profileIndex } : null };
      }
      if (!(await takeNoticeToken(hash, token).catch(() => false))) return { ok: true, result: null };
      const meta = await getTxMeta(hash).catch(() => null);
      const status = message.status === "executed" || message.status === "failed" ? message.status : "";
      if (!meta || !status || meta.status === "executed" || meta.status === "failed") return { ok: true, result: { patched: false } };
      const blockHeight = /^[1-9]\d*$/.test(String(message.blockHeight ?? "")) ? String(message.blockHeight) : undefined;
      const now = Date.now();
      await patchTxMeta(hash, {
        status,
        executedAt: now,
        ...(blockHeight ? { blockHeight } : {}),
        reservationStatus: isShieldedTxMeta(meta) ? "spent" : meta.reservationStatus,
        reservationUpdatedAt: isShieldedTxMeta(meta) ? now : meta.reservationUpdatedAt,
      });
      tellPage({ type: "DUSK_UI_TX_STATUS", hash, status, ok: status === "executed", ...(blockHeight ? { blockHeight } : {}) });
      return { ok: true, result: { patched: true } };
    }

    // A send looked up again by its ID, as the extension's background does:
    // the page hears what came of it.
    if (message?.type === "DUSK_UI_RECHECK_TX") {
      const hash = String(message.hash ?? "").trim();
      if (!hash) throw rpcError(ERROR_CODES.INVALID_PARAMS, "hash is required");
      const { reconciled, event } = await recheckTx(hash);
      tellPage({ type: "DUSK_UI_TX_STATUS", ...event });
      return { ok: true, result: reconciled };
    }

    // Cancel on a payment from Send, waiting for the network or being sent:
    // whether it was called off before it went out.
    if (message?.type === "DUSK_UI_CANCEL_SEND") {
      return { ok: true, result: { cancelled: await cancelWaitingSend(String(message.sendId ?? ""), waitingHost) } };
    }

    // Send it too, on a payment held as its account sent something else while it waited.
    if (message?.type === "DUSK_UI_SEND_HELD") {
      return { ok: true, result: { sending: await sendHeld(String(message.sendId ?? ""), waitingHost) } };
    }

    // Don't send on a payment from Send that wasn't sent.
    if (message?.type === "DUSK_UI_DROP_UNSENT") {
      return { ok: true, result: { dropped: await dropUnsent(String(message.sendId ?? "")) } };
    }

    // Send it now, on a send of the wallet's own the node never had after a
    // hand-over with no clear answer (Not sent yet): the very transaction
    // signed for it, as it is, so it goes out once at most; then followed as
    // each send is (followSent). Where another took its place, Not sent. As a
    // send is, with the wallet's lock, unlock and reset waiting for it
    // (Astra's: locked as the node was asked of it, it still went); and where
    // its answer is lost, it's looked up again, never said not sent before
    // the node says it never had it.
    if (message?.type === "DUSK_UI_RESEND_TX") {
      const hash = String(message.hash ?? "");
      const { meta, result, txEpoch } = await withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
        const status = engineStatus();
        if (!status.isUnlocked) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
        const meta = await getTxMeta(hash);
        if (!meta?.signedTx || meta.status !== "unsent" || meta.dontSendAt || String(meta.walletId ?? "") !== String(status.accounts?.[0] ?? "")) {
          throw rpcError(ERROR_CODES.INVALID_PARAMS, "This send can't be sent again from here.");
        }
        await ensureEngineConfigured();
        const txEpoch = await getTxEpoch();
        const result = await rebroadcastTx({
          hex: meta.signedTx,
          hash,
          nonce: meta.nonce,
          account: meta.account,
          profileIndex: Number(meta.profileIndex) || 0,
          nodeUrl: meta.nodeUrl,
          at: meta.submittedAt,
        }).catch(async (error) => {
          if (error?.data?.replaced) await patchTxMeta(hash, { status: "not_sent", recoveryReason: "replaced", signedTx: undefined }, { epoch: txEpoch }).catch(() => {});
          else if (error?.data?.sent === "unknown") await patchTxMeta(hash, { status: "unknown", recoveryReason: "handover_unclear", lastCheckedAt: Date.now() }, { epoch: txEpoch }).catch(() => {});
          throw error;
        });
        await patchTxMeta(hash, { status: "submitted", lastCheckedAt: Date.now() }, { epoch: txEpoch });
        return { meta, result, txEpoch };
      });
      followSent(hash, { record: { ...meta, status: "submitted" }, nodeUrl: String(meta.nodeUrl ?? ""), txEpoch });
      return { ok: true, result: { hash: result?.hash ?? hash } };
    }

    // Don't send, on one of the wallet's own sends the node never had. Its
    // hand-over had no clear answer, so it may still arrive: never sent again
    // from here, it's followed till its nonce is used, and shows as Sent if it
    // went after all (txReconcile.js). One another took the place of goes.
    if (message?.type === "DUSK_UI_DROP_TX") {
      const hash = String(message.hash ?? "");
      const meta = await getTxMeta(hash);
      if (meta?.status === "unsent" && !meta.dontSendAt) {
        // As the record is when it's written: one that went meanwhile isn't marked.
        const stored = await patchTxMeta(hash, { dontSendAt: Date.now(), signedTx: undefined });
        return { ok: true, result: stored?.dontSendAt ? { dropped: true, followed: true } : { dropped: false, went: stored?.status === "executed" || stored?.status === "failed" } };
      }
      const dropped = meta?.status === "not_sent";
      if (dropped) await forgetTxs([hash]);
      return { ok: true, result: { dropped } };
    }

    // UI initiated transaction (from the wallet popup)
    if (message?.type === "DUSK_UI_SEND_TX") {
      // A payment from Send (`sendId`) waits for the network where it
      // couldn't reach it before it went out, and can be called off until it
      // goes (waitingSends.js); any other send is tried once.
      const sendId = typeof message.sendId === "string" && /^[\w-]{8,64}$/.test(message.sendId) && String(message.params?.kind ?? "").toLowerCase() === TX_KIND.TRANSFER ? message.sendId : "";
      // From the profile its Review was for, whichever is picked as it goes.
      const reviewed = reviewedParams(message.params);
      // Above the amount chosen in Settings, the password's ticket counts
      // once for the payment, however many tries it takes (`granted`):
      // checked as it's taken, priced as its Review asked it, as one that
      // waits behind others would outlive its ticket.
      let granted;
      const taking = engineStatus();
      const expectedWallet = String(message.walletId ?? "");
      if (taking?.isUnlocked && (!expectedWallet || expectedWallet === String(taking.accounts?.[0] ?? ""))) {
        granted = await sendPasswordOnce(await sendParams({ params: reviewed }, { engineCall: localEngineCall, ensureEngineConfigured }), undefined, {
          ticket: message.sendTicket,
          walletId: String(taking.accounts?.[0] ?? ""),
          nodeUrl: (await getSettings()).nodeUrl,
        });
      }
      // Sent from the wallet unlocked as it goes, the one its Review was on
      // (`walletId`): a switch, lock or reset waits for it. A payment handed
      // over without a clear answer that the node has after all (`found`),
      // or never had and is sent again as it is (`resend`), records the
      // transaction its try made (`made`), on the node it was made for
      // (`madeOn`), whatever was chosen since.
      let made;
      let madeOn = "";
      // Kept as a sent one as soon as its try has handed it over, before it
      // leaves the waiting list (waitingSends.js forgets it once the try is
      // back), under the node it was sent on: another may have been chosen
      // while it waited or was looked up. Read meanwhile, the wallet's lists
      // have it in the one or the other, never in neither (Lena's and Chen's:
      // gone from Home and Activity both for 10 s as it went out). The profile
      // that paid, as the extension keeps it: a stake's own profile may not be
      // the one selected.
      const keptSent = async (tried) => {
        const hash = tried.result?.hash ?? "";
        if (!hash) return tried;
        const nodeUrl = tried.nodeUrl || (await getSettings())?.nodeUrl || "";
        const record = submittedTxMeta(tried.baseParams, { walletId: String(tried.status.accounts?.[0] ?? ""), origin: "Wallet", nodeUrl, profileIndex: sendingProfile(tried.baseParams, tried.status), nullifiers: tried.result?.nullifiers }, walletSendFields(tried.baseParams, message));
        await putTxMeta(hash, record, { epoch: tried.txEpoch }).catch(() => {});
        return { ...tried, record };
      };
      const attempt = ({ resend = false, found = null } = {}) => withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
        const status = engineStatus();
        if (!status.isUnlocked) {
          throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
        }
        const expected = String(message.walletId ?? "");
        if (expected && expected !== String(status.accounts?.[0] ?? "")) {
          throw rpcError(ERROR_CODES.UNAUTHORIZED, "The wallet changed while you reviewed it.");
        }
        // What this send and its watcher keep is dropped after a reset meanwhile.
        const txEpoch = await getTxEpoch();
        await ensureEngineConfigured();
        if (found || resend) {
          const result = found ? { ...found, found: true } : await resendSend({ sendId });
          return keptSent({ status, txEpoch, baseParams: made ?? applyTxDefaults(reviewed, {}), result, nodeUrl: madeOn });
        }
        // The node's gas price (kept 30 s) by both wallets' one rule: its
        // median, under a ceiling.
        let dynamicPrice;
        try {
          const gasData = await getCachedGasPrice();
          dynamicPrice = defaultGasPriceOf(gasData).price.toString();
        } catch {
          // Ignore errors, will fall back to static default
        }
        const baseParams = applyTxDefaults(reviewed, { dynamicPrice });
        // Above the amount chosen in Settings, only with the password checked for it.
        const { nodeUrl } = await getSettings();
        granted = await sendPasswordOnce(baseParams, granted, { ticket: message.sendTicket, walletId: String(status.accounts?.[0] ?? ""), nodeUrl });
        made = baseParams;
        madeOn = nodeUrl;
        const result = await sendTransaction({ ...baseParams, ...(sendId ? { sendId } : {}) }).catch(async (error) => {
          // Handed over with no clear answer: kept, to be looked up by its ID;
          // a public payment from Send is asked of the node first (waitingSends.js).
          const hash = error?.data?.sent === "unknown" ? String(error.data.hash ?? "") : "";
          if (hash && !(sendId && checkedOnNode(baseParams))) {
            const sent = { walletId: String(status.accounts?.[0] ?? ""), origin: "Wallet", nodeUrl, profileIndex: sendingProfile(baseParams, status) };
            // A public one as it was signed: asked of the node by its nonce,
            // and sent again as it is where the node never had it (txReconcile.js).
            const signed = signedTxFields(handedOverTx({ hash }));
            await putTxMeta(hash, unclearTxMeta(baseParams, sent, { ...walletSendFields(baseParams, message), ...signed }), { epoch: txEpoch }).catch(() => {});
          }
          throw error;
        });
        return keptSent({ status, txEpoch, baseParams, result, nodeUrl });
      });
      const { txEpoch, result, nodeUrl: sentOn, record } = sendId
        ? await sendWhenReachable({
            sendId,
            record: waitingRecordOf(message, await getSettings().then((settings) => ({ nodeUrl: settings.nodeUrl, profileIndex: Number(settings.selectedAccountIndex ?? 0) || 0 }))),
            attempt,
            host: waitingHost,
            // Sent again from Home's Send it now, in the place of the one Home said wasn't sent.
            replaces: typeof message.replaces === "string" && /^[\w-]{8,64}$/.test(message.replaces) ? message.replaces : "",
            // Gone out, or ended without: Android's notice of it waiting goes.
          }).finally(() => {
            tellWaitingForApp();
          })
        : await attempt();
      // Kept as sent as it was handed over (keptSent), under the node it was sent on.
      const hash = result?.hash ?? "";
      try {
        const nodeUrl = sentOn || (await getSettings())?.nodeUrl || "";
        if (hash && record) followSent(hash, { record, nodeUrl, txEpoch, found: Boolean(result?.found) });
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
