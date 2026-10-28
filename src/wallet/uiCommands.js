import { getSettings, normalizeCustomGas, setSettings } from "../shared/settings.js";
import { ERROR_CODES, rpcError } from "../shared/errors.js";
import { serializeStakeInfo } from "../shared/transport.js";
import { nativeRewardRate } from "../shared/rewardRate.js";
import { clearContacts, contactsStore } from "../shared/contactsStore.js";
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
  DUSK_UI_DRC20_ENCODE_INPUT: ["dusk_encodeDrc20Input", (message) => ({ fnName: message.fnName, args: message.args, driver: message.driver })],
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

export async function handleUiCommand(
  message,
  { engineCall, ensureEngineConfigured, getEngineStatus }
) {
  const type = message?.type;

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

  // Custom gas from Settings, or null for the network's price.
  if (type === "DUSK_UI_SET_CUSTOM_GAS") {
    const next = await setSettings({ customGas: normalizeCustomGas(message.customGas) });
    return { ok: true, customGas: next.customGas ?? null };
  }

  // About what native staking pays a year lately: from the node, at most once a day.
  if (type === "DUSK_UI_GET_REWARD_RATE") {
    return { ok: true, result: await nativeRewardRate((await getSettings()).nodeUrl) };
  }

  if (type === "DUSK_UI_GET_CACHED_GAS_PRICE") {
    await ensureEngineConfigured();
    return { ok: true, result: await engineCall("dusk_getCachedGasPrice") };
  }

  // Contacts: read and changed only while the wallet is unlocked, as the
  // engine holds their key; deleting them all needs none.
  if (type === "DUSK_UI_CONTACTS") {
    if (message.op === "clear") {
      await clearContacts();
      return { ok: true, result: true };
    }
    const op = Object.hasOwn(CONTACT_OPS, message.op) ? CONTACT_OPS[message.op] : null;
    if (!op) throw rpcError(ERROR_CODES.INVALID_PARAMS, "Unknown contacts operation");
    return { ok: true, result: (await op(contactsStore(engineContactsVault(engineCall)), message)) ?? null };
  }

  const engineCommand = ENGINE_COMMANDS[type];
  const assetCommand = ASSET_COMMANDS[type];
  if (!engineCommand && !assetCommand && type !== "DUSK_UI_SET_ACCOUNT_INDEX" && type !== "DUSK_UI_SET_SHIELDED_CHECKPOINT_NOW") {
    return null;
  }

  const status = await getEngineStatus();
  if (!status.isUnlocked) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");

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

  if (type === "DUSK_UI_SET_SHIELDED_CHECKPOINT_NOW") {
    await ensureEngineConfigured();
    return { ok: true, result: await engineCall("dusk_setShieldedCheckpointNow", { profileIndex: 0 }) };
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
