import { getSettings, normalizeCustomGas, setSettings } from "../shared/settings.js";
import { ERROR_CODES, rpcError } from "../shared/errors.js";
import { WALLET_LIFECYCLE_LOCK, withStorageLock } from "../shared/storageLock.js";
import { serializeStakeInfo } from "../shared/transport.js";
import { nativeRewardRate, stakingFigures } from "../shared/rewardRate.js";
import { contactsStore, forgetWalletContacts } from "../shared/contactsStore.js";
import { askedOf, proveSendPassword, sendPasswordLimit, setSendPasswordLimit } from "../shared/sendPassword.js";
import { checkVaultPassword } from "../shared/vault.js";
import { applyTxDefaults, defaultGasPriceOf } from "../shared/txDefaults.js";
import {
  getWatchedAssets,
  watchToken,
  unwatchToken,
  watchNft,
  unwatchNft,
} from "../shared/assetsStore.js";

const ENGINE_COMMANDS = {
  DUSK_UI_GET_MINIMUM_STAKE: ["dusk_getMinimumStake", () => undefined],
  DUSK_UI_GET_STAKE_INFO: ["dusk_getStakeInfo", (_message, profileIndex) => ({ profileIndex })],
  DUSK_UI_GET_STAKE_OWNER_STATUS: ["dusk_getStakeOwnerStatus", (_message, profileIndex) => ({ profileIndex })],
  DUSK_UI_GET_SOZU_STATUS: ["dusk_getSozuStatus", (_message, profileIndex) => ({ profileIndex })],
  DUSK_UI_DRC20_GET_METADATA: ["dusk_getDrc20Metadata", (message) => ({ contractId: message.contractId, driver: message.driver })],
  DUSK_UI_DRC20_GET_BALANCE: ["dusk_getDrc20Balance", (message, profileIndex) => ({ contractId: message.contractId, profileIndex, driver: message.driver })],
  DUSK_UI_DRC20_ENCODE_INPUT: ["dusk_encodeDrc20Input", (message) => ({ contractId: message.contractId, fnName: message.fnName, args: message.args, driver: message.driver })],
  DUSK_UI_DRC20_DECODE_INPUT: ["dusk_decodeDrc20Input", (message) => ({ fnName: message.fnName, fnArgs: message.fnArgs, driver: message.driver })],
  DUSK_UI_DRC721_GET_METADATA: ["dusk_getDrc721Metadata", (message) => ({ contractId: message.contractId })],
  DUSK_UI_DRC721_OWNER_OF: ["dusk_getDrc721OwnerOf", (message) => ({ contractId: message.contractId, tokenId: message.tokenId })],
  DUSK_UI_DRC721_TOKEN_URI: ["dusk_getDrc721TokenUri", (message) => ({ contractId: message.contractId, tokenId: message.tokenId })],
  DUSK_UI_DRC721_DECODE_INPUT: ["dusk_decodeDrc721Input", (message) => ({ fnName: message.fnName, fnArgs: message.fnArgs })],
  DUSK_UI_GET_SHIELDED_HISTORY: ["dusk_getShieldedHistory", () => undefined],
};

const ASSET_COMMANDS = {
  DUSK_UI_ASSETS_GET: (walletId, nodeUrl, profileIndex) =>
    getWatchedAssets(walletId, nodeUrl, profileIndex),
  DUSK_UI_ASSETS_WATCH_TOKEN: (walletId, nodeUrl, profileIndex, message) =>
    watchToken(walletId, nodeUrl, profileIndex, message.token),
  DUSK_UI_ASSETS_UNWATCH_TOKEN: (walletId, nodeUrl, profileIndex, message) =>
    unwatchToken(walletId, nodeUrl, profileIndex, message.contractId),
  DUSK_UI_ASSETS_WATCH_NFT: (walletId, nodeUrl, profileIndex, message) =>
    watchNft(walletId, nodeUrl, profileIndex, message.nft),
  DUSK_UI_ASSETS_UNWATCH_NFT: (walletId, nodeUrl, profileIndex, message) =>
    unwatchNft(walletId, nodeUrl, profileIndex, message.contractId, message.tokenId),
};

/**
 * The engine's contacts key, for the contacts store: it opens and seals this
 * wallet's record while the wallet is unlocked, and throws "Wallet locked"
 * otherwise. The key itself never leaves the engine.
 * @param {(method: string, params?: object) => Promise<any>} engineCall
 */
export function engineContactsVault(engineCall) {
  return {
    open: (records) => engineCall("engine_contactsOpen", { records }),
    seal: (text) => engineCall("engine_contactsSeal", { text }),
  };
}

// What changes one wallet's data, besides its contacts: a profile chosen, a
// token or an NFT watched or not.
const ASSET_CHANGES = new Set(["DUSK_UI_ASSETS_WATCH_TOKEN", "DUSK_UI_ASSETS_UNWATCH_TOKEN", "DUSK_UI_ASSETS_WATCH_NFT", "DUSK_UI_ASSETS_UNWATCH_NFT"]);

/**
 * A page's change to one wallet's data is for the wallet its screen was
 * drawn for (`message.walletId`, its first public account, which a page
 * names): with another wallet unlocked now, it isn't made. Run it in the
 * wallet lifecycle lock, with the status read there.
 * @param {object} message
 * @param {object} status - the engine's status
 */
export function assertScreenWallet(message, status) {
  const shown = String(message?.walletId ?? "");
  if (shown && shown !== (status?.isUnlocked ? String(status.accounts?.[0] ?? "") : "")) {
    throw rpcError(ERROR_CODES.UNAUTHORIZED, "The wallet changed meanwhile.");
  }
}

// The pages' contacts (shared/addressBook.js), by what they ask.
const CONTACT_OPS = {
  list: (store, message) => store.list({ query: message.query }),
  upsert: (store, message) => store.upsert(message.entry),
  markChecked: (store, message) => store.markChecked(message.entry, message.checkedAt),
  remove: (store, message) => store.remove(message.id),
};

function profileIndex(message, status) {
  const value = Number(message.profileIndex);
  return Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : Number(status.selectedAccountIndex ?? 0) || 0;
}

function serializeResult(type, result) {
  if (type === "DUSK_UI_GET_MINIMUM_STAKE" || type === "DUSK_UI_DRC20_GET_BALANCE") {
    return String(result ?? "0");
  }
  if (type === "DUSK_UI_DRC721_TOKEN_URI") return String(result ?? "");
  if (type === "DUSK_UI_GET_STAKE_INFO") return serializeStakeInfo(result);
  return result;
}

// The transaction as it would go: with the gas it goes with, as the send does it.
export async function sendParams(message, { engineCall, ensureEngineConfigured }) {
  await ensureEngineConfigured();
  const stats = await engineCall("dusk_getCachedGasPrice").catch(() => null);
  return applyTxDefaults(message.params ?? {}, { dynamicPrice: stats ? defaultGasPriceOf(stats).price.toString() : undefined });
}

/**
 * The password on big sends: what a send asks, the password given for it, and a
 * change of the amount, which takes the password too. All for the wallet that's
 * open, and only from the wallet's own pages (background/index.js).
 */
async function sendPasswordCommand(message, host) {
  const status = await host.getEngineStatus();
  if (!status?.isUnlocked) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
  const { nodeUrl } = await getSettings();
  switch (message.type) {
    case "DUSK_UI_SEND_PASSWORD_ASKS":
      return { ok: true, result: askedOf(await sendParams(message, host), await sendPasswordLimit(), nodeUrl) };
    case "DUSK_UI_SEND_PASSWORD_PROVE": {
      const walletId = String(status.accounts?.[0] ?? "");
      const params = await sendParams(message, host);
      return { ok: true, result: await proveSendPassword(message.password, params, { walletKey: status.walletKey, walletId, nodeUrl }) };
    }
    default: {
      const limit = message.limitLux === null ? null : String(message.limitLux ?? "");
      if (limit !== null && !/^\d+$/.test(limit)) throw rpcError(ERROR_CODES.INVALID_PARAMS, "That isn't an amount.");
      await checkVaultPassword(message.password, status.walletKey);
      await setSendPasswordLimit(limit);
      return { ok: true };
    }
  }
}

/** What reads or changes the password on big sends, for the wallet's own pages alone. */
export const SEND_PASSWORD_COMMANDS = new Set(["DUSK_UI_SEND_PASSWORD_ASKS", "DUSK_UI_SEND_PASSWORD_PROVE", "DUSK_UI_SET_SEND_PASSWORD"]);

export async function handleUiCommand(
  message,
  { engineCall, ensureEngineConfigured, getEngineStatus }
) {
  const type = message?.type;

  if (SEND_PASSWORD_COMMANDS.has(type)) return sendPasswordCommand(message, { engineCall, ensureEngineConfigured, getEngineStatus });

  if (type === "DUSK_UI_SET_NFT_SETTINGS") {
    const next = await setSettings({
      nftMetadataEnabled: false,
      ipfsGateway: String(message.ipfsGateway ?? ""),
    });
    return { ok: true, nftMetadataEnabled: false, ipfsGateway: next.ipfsGateway ?? "" };
  }

  // A display choice, so it needs no unlocked wallet.
  if (type === "DUSK_UI_SET_HIDE_BALANCES") {
    const next = await setSettings({ hideBalances: message.hideBalances === true });
    return { ok: true, hideBalances: next.hideBalances === true };
  }

  // Fingerprint unlock is turned on with the password: checked against the
  // vault first, as a wrong unlock is, and counted as one.
  if (type === "DUSK_UI_CHECK_PASSWORD") {
    const status = await getEngineStatus();
    if (!status?.isUnlocked) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
    await checkVaultPassword(message.password, status.walletKey);
    return { ok: true };
  }

  // The app on a phone: lock as the person leaves it (Auto-lock: Immediately).
  if (type === "DUSK_UI_SET_LOCK_ON_LEAVE") {
    const next = await setSettings({ lockOnLeave: message.lockOnLeave === true });
    return { ok: true, lockOnLeave: next.lockOnLeave === true };
  }

  // Custom gas from Settings, or null for the network's price.
  if (type === "DUSK_UI_SET_CUSTOM_GAS") {
    const next = await setSettings({ customGas: normalizeCustomGas(message.customGas) });
    return { ok: true, customGas: next.customGas ?? null };
  }

  // About what native staking pays a year lately: from the node, at most once a day.
  if (type === "DUSK_UI_GET_REWARD_RATE") {
    return { ok: true, result: await nativeRewardRate((await getSettings()).nodeUrl) };
  }

  // What the working under Sozu's rate says: read as that screen opens.
  if (type === "DUSK_UI_GET_STAKING_FIGURES") {
    return { ok: true, result: await stakingFigures((await getSettings()).nodeUrl) };
  }

  if (type === "DUSK_UI_GET_CACHED_GAS_PRICE") {
    await ensureEngineConfigured();
    return { ok: true, result: await engineCall("dusk_getCachedGasPrice") };
  }

  // Contacts: read and changed only while the wallet is unlocked, as the
  // engine holds their key. Deleting them all is one wallet's: the one its
  // page showed (every wallet's go only with Reset).
  if (type === "DUSK_UI_CONTACTS") {
    if (message.op === "clear") {
      return withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
        const status = await getEngineStatus();
        const walletId = String(message.walletId ?? "");
        if (!walletId || !status?.isUnlocked) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
        assertScreenWallet(message, status);
        await forgetWalletContacts(walletId);
        return { ok: true, result: true };
      });
    }
    const op = Object.hasOwn(CONTACT_OPS, message.op) ? CONTACT_OPS[message.op] : null;
    if (!op) throw rpcError(ERROR_CODES.INVALID_PARAMS, "Unknown contacts operation");
    const run = async () => ({ ok: true, result: (await op(contactsStore(engineContactsVault(engineCall)), message)) ?? null });
    // A page's, for the wallet it showed: read or changed for that one alone.
    if (!message.walletId) return run();
    return withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
      assertScreenWallet(message, await getEngineStatus());
      return run();
    });
  }

  const engineCommand = ENGINE_COMMANDS[type];
  const assetCommand = ASSET_COMMANDS[type];
  if (!engineCommand && !assetCommand && type !== "DUSK_UI_SET_ACCOUNT_INDEX") {
    return null;
  }

  // A change to one wallet's data runs in the wallet lifecycle lock, for the
  // wallet its page showed.
  const changes = type === "DUSK_UI_SET_ACCOUNT_INDEX" || ASSET_CHANGES.has(type);
  if (changes) return withStorageLock(WALLET_LIFECYCLE_LOCK, () => runCommand(message, { engineCall, ensureEngineConfigured, getEngineStatus }));
  return runCommand(message, { engineCall, ensureEngineConfigured, getEngineStatus });
}

async function runCommand(message, { engineCall, ensureEngineConfigured, getEngineStatus }) {
  const type = message?.type;
  const engineCommand = ENGINE_COMMANDS[type];
  const assetCommand = ASSET_COMMANDS[type];
  const status = await getEngineStatus();
  if (!status.isUnlocked) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
  if (type === "DUSK_UI_SET_ACCOUNT_INDEX" || ASSET_CHANGES.has(type)) assertScreenWallet(message, status);

  if (type === "DUSK_UI_SET_ACCOUNT_INDEX") {
    const index = Number(message.index);
    if (!Number.isFinite(index) || index < 0) {
      throw rpcError(ERROR_CODES.INVALID_PARAMS, "index must be a non-negative number");
    }
    const settings = await getSettings();
    const clamped = Math.min(Math.floor(index), Math.max(0, Number(settings.accountCount ?? 1) - 1));
    await setSettings({ selectedAccountIndex: clamped });
    await ensureEngineConfigured();
    return { ok: true, result: await engineCall("engine_selectAccount", { index: clamped }) };
  }

  const index = profileIndex(message, status);
  if (assetCommand) {
    const settings = await getSettings();
    const walletId = String(status.accounts?.[0] ?? "").trim();
    if (!walletId) throw rpcError(ERROR_CODES.INTERNAL, "Wallet ID unavailable");
    return { ok: true, result: await assetCommand(walletId, settings.nodeUrl, index, message) };
  }

  await ensureEngineConfigured();
  const [method, params] = engineCommand;
  const result = await engineCall(method, params(message, index));
  return { ok: true, result: serializeResult(type, result) };
}
