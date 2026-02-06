import { bytesToHex, hexToBytes } from "./bytes.js";
import { storage, STORAGE_KEYS } from "./storage.js";

function normalizeWalletId(walletId) {
  const id = String(walletId ?? "").trim();
  if (!id) throw new Error("walletId is required");
  return id;
}

function normalizeNetworkKey(networkKey) {
  const k = String(networkKey ?? "").trim();
  if (!k) throw new Error("networkKey is required");
  return k;
}

function normalizeProfileIndex(profileIndex) {
  const n = Number(profileIndex);
  if (!Number.isFinite(n) || n < 0) throw new Error("profileIndex must be a non-negative number");
  return Math.floor(n);
}

export function normalizeContractId(contractId) {
  // Canonical format: 0x + 64 lowercase hex chars.
  try {
    const bytes =
      contractId instanceof Uint8Array
        ? contractId
        : Array.isArray(contractId)
          ? new Uint8Array(contractId)
          : hexToBytes(contractId);
    if (bytes.length !== 32) throw new Error("contractId must be 32 bytes");
    return `0x${bytesToHex(bytes)}`;
  } catch {
    throw new Error("Invalid contractId (expected 32-byte hex string or bytes)");
  }
}

function normalizeTokenId(tokenId) {
  const raw = String(tokenId ?? "").trim();
  if (!raw) throw new Error("tokenId is required");
  let n;
  try {
    n = BigInt(raw);
  } catch {
    throw new Error("tokenId must be a u64 decimal string");
  }
  if (n < 0n || n > 18446744073709551615n) throw new Error("tokenId out of range for u64");
  return n.toString();
}

function normalizeDecimals(decimals) {
  const n = Number(decimals);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(255, Math.floor(n));
}

function normalizeName(s, maxLen = 64) {
  const out = String(s ?? "").trim().replace(/\s+/g, " ");
  if (!out) return "";
  return out.length > maxLen ? out.slice(0, maxLen) : out;
}

async function getAll() {
  const res = await storage.get({ [STORAGE_KEYS.ASSETS]: {} });
  const all = res?.[STORAGE_KEYS.ASSETS];
  return all && typeof all === "object" ? all : {};
}

async function setAll(next) {
  await storage.set({ [STORAGE_KEYS.ASSETS]: next });
}

function ensureBuckets(all, walletId, networkKey, profileIndex) {
  const id = normalizeWalletId(walletId);
  const net = normalizeNetworkKey(networkKey);
  const idx = normalizeProfileIndex(profileIndex);

  const w = all?.[id] && typeof all[id] === "object" ? { ...all[id] } : {};
  const n = w?.[net] && typeof w[net] === "object" ? { ...w[net] } : {};
  const p = n?.[String(idx)] && typeof n[String(idx)] === "object" ? { ...n[String(idx)] } : {};

  const tokens = Array.isArray(p.tokens) ? [...p.tokens] : [];
  const nfts = Array.isArray(p.nfts) ? [...p.nfts] : [];

  return { id, net, idx, w, n, p: { ...p, tokens, nfts } };
}

/**
 * @typedef {Object} WatchedToken
 * @property {"DRC20"} type
 * @property {string} contractId 0x-prefixed 32-byte hex
 * @property {string} name
 * @property {string} symbol
 * @property {number} decimals
 * @property {number} addedAt
 */

/**
 * @typedef {Object} WatchedNft
 * @property {"DRC721"} type
 * @property {string} contractId 0x-prefixed 32-byte hex
 * @property {string} tokenId u64 decimal string
 * @property {string} name
 * @property {string} symbol
 * @property {string} tokenUri
 * @property {number} addedAt
 */

/**
 * @param {string} walletId
 * @param {string} networkKey
 * @param {number} profileIndex
 * @returns {Promise<{tokens: WatchedToken[], nfts: WatchedNft[]}>}
 */
export async function getWatchedAssets(walletId, networkKey, profileIndex) {
  const id = normalizeWalletId(walletId);
  const net = normalizeNetworkKey(networkKey);
  const idx = normalizeProfileIndex(profileIndex);
  const all = await getAll();
  const w = all?.[id];
  const n = w && typeof w === "object" ? w?.[net] : null;
  const p = n && typeof n === "object" ? n?.[String(idx)] : null;
  const tokens = Array.isArray(p?.tokens) ? p.tokens : [];
  const nfts = Array.isArray(p?.nfts) ? p.nfts : [];
  return { tokens, nfts };
}

/**
 * @param {string} walletId
 * @param {string} networkKey
 * @param {number} profileIndex
 * @param {{contractId: any, name: any, symbol: any, decimals: any}} token
 * @returns {Promise<{tokens: WatchedToken[], nfts: WatchedNft[]}>}
 */
export async function watchToken(walletId, networkKey, profileIndex, token) {
  const all = await getAll();
  const { id, net, idx, w, n, p } = ensureBuckets(all, walletId, networkKey, profileIndex);

  const contractId = normalizeContractId(token?.contractId);
  const name = normalizeName(token?.name, 64);
  const symbol = normalizeName(token?.symbol, 16);
  const decimals = normalizeDecimals(token?.decimals);

  const nextTokens = p.tokens.filter((t) => String(t?.contractId) !== contractId);
  nextTokens.unshift({
    type: "DRC20",
    contractId,
    name,
    symbol,
    decimals,
    addedAt: Date.now(),
  });

  const nextP = { ...p, tokens: nextTokens };
  const nextN = { ...n, [String(idx)]: nextP };
  const nextW = { ...w, [net]: nextN };
  const nextAll = { ...all, [id]: nextW };
  await setAll(nextAll);
  return { tokens: nextTokens, nfts: p.nfts };
}

/**
 * @param {string} walletId
 * @param {string} networkKey
 * @param {number} profileIndex
 * @param {any} contractId
 * @returns {Promise<{tokens: WatchedToken[], nfts: WatchedNft[]}>}
 */
export async function unwatchToken(walletId, networkKey, profileIndex, contractId) {
  const all = await getAll();
  const { id, net, idx, w, n, p } = ensureBuckets(all, walletId, networkKey, profileIndex);
  const cid = normalizeContractId(contractId);

  const nextTokens = p.tokens.filter((t) => String(t?.contractId) !== cid);
  const nextP = { ...p, tokens: nextTokens };
  const nextN = { ...n, [String(idx)]: nextP };
  const nextW = { ...w, [net]: nextN };
  const nextAll = { ...all, [id]: nextW };
  await setAll(nextAll);
  return { tokens: nextTokens, nfts: p.nfts };
}

/**
 * @param {string} walletId
 * @param {string} networkKey
 * @param {number} profileIndex
 * @param {{contractId: any, tokenId: any, name: any, symbol: any, tokenUri?: any}} nft
 * @returns {Promise<{tokens: WatchedToken[], nfts: WatchedNft[]}>}
 */
export async function watchNft(walletId, networkKey, profileIndex, nft) {
  const all = await getAll();
  const { id, net, idx, w, n, p } = ensureBuckets(all, walletId, networkKey, profileIndex);

  const contractId = normalizeContractId(nft?.contractId);
  const tokenId = normalizeTokenId(nft?.tokenId);
  const name = normalizeName(nft?.name, 64);
  const symbol = normalizeName(nft?.symbol, 16);
  const tokenUri = String(nft?.tokenUri ?? "").trim();

  const key = `${contractId}:${tokenId}`;
  const nextNfts = p.nfts.filter((x) => `${String(x?.contractId)}:${String(x?.tokenId)}` !== key);
  nextNfts.unshift({
    type: "DRC721",
    contractId,
    tokenId,
    name,
    symbol,
    tokenUri,
    addedAt: Date.now(),
  });

  const nextP = { ...p, nfts: nextNfts };
  const nextN = { ...n, [String(idx)]: nextP };
  const nextW = { ...w, [net]: nextN };
  const nextAll = { ...all, [id]: nextW };
  await setAll(nextAll);
  return { tokens: p.tokens, nfts: nextNfts };
}

/**
 * @param {string} walletId
 * @param {string} networkKey
 * @param {number} profileIndex
 * @param {any} contractId
 * @param {any} tokenId
 * @returns {Promise<{tokens: WatchedToken[], nfts: WatchedNft[]}>}
 */
export async function unwatchNft(walletId, networkKey, profileIndex, contractId, tokenId) {
  const all = await getAll();
  const { id, net, idx, w, n, p } = ensureBuckets(all, walletId, networkKey, profileIndex);

  const cid = normalizeContractId(contractId);
  const tid = normalizeTokenId(tokenId);
  const key = `${cid}:${tid}`;

  const nextNfts = p.nfts.filter((x) => `${String(x?.contractId)}:${String(x?.tokenId)}` !== key);
  const nextP = { ...p, nfts: nextNfts };
  const nextN = { ...n, [String(idx)]: nextP };
  const nextW = { ...w, [net]: nextN };
  const nextAll = { ...all, [id]: nextW };
  await setAll(nextAll);
  return { tokens: p.tokens, nfts: nextNfts };
}

