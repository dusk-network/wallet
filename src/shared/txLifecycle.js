/**
 * Best-effort transaction lifecycle reconciliation against a Dusk node.
 *
 * `mempoolTxs` is exposed by the public Postman collection and current node
 * GraphQL surface, but is treated as best-effort because its detailed shape is
 * less stable than finalized `tx(hash)` lookups.
 */

import { fetchWithTimeout } from "./networkStatus.js";

function graphqlUrl(nodeUrl) {
  const base = String(nodeUrl || "").trim();
  if (!base) throw new Error("nodeUrl is required");
  return new URL("/on/graphql/query", base).toString();
}

function losslessJson(text) {
  const parts = String(text).split(/("(?:\\.|[^"\\])*")/g);
  return JSON.parse(parts.map((part, index) => index % 2 ? part : part.replace(
    /([:\[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g,
    (_, prefix, integer) => `${prefix}"${integer}"`
  )).join(""));
}

async function postGraphql(nodeUrl, query) {
  const res = await fetchWithTimeout(graphqlUrl(nodeUrl), {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: query,
  }, 5_000);

  if (!res.ok) {
    throw new Error(`GraphQL request failed (${res.status})`);
  }

  const json = losslessJson(await res.text());
  if (Array.isArray(json?.errors) && json.errors.length) {
    const msg = json.errors.map((e) => e?.message || String(e)).join("; ");
    throw new Error(msg || "GraphQL returned errors");
  }
  return json;
}

const MAX_U64 = (1n << 64n) - 1n;

function decimal(value) {
  try {
    if (typeof value === "number" && !Number.isSafeInteger(value)) return undefined;
    const text = String(value ?? "").trim();
    if (!/^\d+$/.test(text)) return undefined;
    const integer = BigInt(text);
    return integer <= MAX_U64 ? integer.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function finalizedTxMetadata(tx) {
  const gasSpent = decimal(tx?.gasSpent ?? tx?.gas_spent);
  const gasPrice = decimal(tx?.tx?.gasPrice ?? tx?.tx?.gas_price ?? tx?.gasPrice ?? tx?.gas_price);
  const blockHeight = decimal(tx?.blockHeight ?? tx?.block_height);
  const blockTimestamp = decimal(tx?.blockTimestamp ?? tx?.block_timestamp);
  const blockHash = String(tx?.blockHash ?? tx?.block_hash ?? "").trim() || undefined;
  const finalizedAt = blockTimestamp && BigInt(blockTimestamp) * 1_000n <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(BigInt(blockTimestamp) * 1_000n)
    : undefined;
  return Object.fromEntries(Object.entries({
    gasSpent,
    gasPrice,
    feePaid: gasSpent && gasPrice ? (BigInt(gasSpent) * BigInt(gasPrice)).toString() : undefined,
    blockHash,
    blockHeight,
    blockTimestamp,
    finalizedAt,
  }).filter(([, value]) => value !== undefined));
}

function txError(tx) {
  const err = tx?.err ?? tx?.error;
  if (!err) return "";
  if (typeof err === "string") return err;
  if (typeof err?.message === "string") return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export async function queryTxByHash(nodeUrl, hash) {
  const h = String(hash || "").trim();
  if (!h) throw new Error("hash is required");
  const query = `query { tx(hash: ${JSON.stringify(h)}) { id err gasSpent blockHash blockHeight blockTimestamp tx { id gasLimit gasPrice txType isDeploy memo } } }`;
  const json = await postGraphql(nodeUrl, query);
  return json?.tx ?? null;
}

export async function queryMempoolTxs(nodeUrl) {
  const query = "query { mempoolTxs { id gasLimit gasPrice txType memo json } }";
  const json = await postGraphql(nodeUrl, query);
  return Array.isArray(json?.mempoolTxs) ? json.mempoolTxs : [];
}

/**
 * An account's nonce, as the node's chain has it now: the last one used. A
 * new public transaction's is counted from it.
 * @param {string} nodeUrl
 * @param {string} account
 * @returns {Promise<bigint>}
 */
export async function accountNonce(nodeUrl, account) {
  const url = new URL(`/on/account:${encodeURIComponent(String(account))}/status`, String(nodeUrl || "").trim()).toString();
  const res = await fetchWithTimeout(url, { method: "POST" }, 5_000);
  if (!res.ok) throw new Error(`Account request failed (${res.status})`);
  const nonce = decimal(losslessJson(await res.text())?.nonce);
  if (nonce === undefined) throw new Error("The node gave no nonce");
  return BigInt(nonce);
}

// A transaction's JSON as the node gives it, or null.
function txJson(text) {
  try {
    return losslessJson(String(text ?? ""));
  } catch {
    return null;
  }
}

/**
 * The account's nonce now, as the node has it: the last one its chain used,
 * or, past that, the last of the account's transactions waiting in the
 * node's mempool, where that can be read. A payment that waited tells by it
 * whether its account sent anything else meanwhile (waitingSends.js).
 * @param {string} nodeUrl
 * @param {string} account
 * @returns {Promise<bigint>}
 */
export async function accountNonceNow(nodeUrl, account) {
  const [used, waiting] = await Promise.all([
    accountNonce(nodeUrl, account),
    queryMempoolTxs(nodeUrl).catch(() => []),
  ]);
  let nonce = used;
  for (const tx of waiting) {
    const said = txJson(tx?.json);
    const its = decimal(said?.nonce);
    if (said?.type === "moonlight" && String(said?.sender ?? "") === String(account) && its !== undefined && BigInt(its) > nonce) nonce = BigInt(its);
  }
  return nonce;
}

// The account's transactions read for the one at a nonce: those it sent from
// about when the payment was made, at most this many pages of the archive's.
const TAKEN_PAGES = 4;
const TAKEN_PAGE = 50;
// Blocks come about every 10 seconds: counted back as if every 5, and an hour
// more, to start before the payment was made.
const BLOCK_MS_AT_LEAST = 5_000;
const BLOCKS_BEFORE = 360;

/**
 * The account's transaction at `nonce`, as the chain shows it: those it sent
 * since about when the payment was made (`at`), read from the archive with
 * their nonces. Its ID, or "" where none of those read is at it.
 * @param {string} nodeUrl
 * @param {{ account: string, nonce: string | bigint, at?: number }} tx
 */
async function nonceTakenBy(nodeUrl, { account, nonce, at }) {
  const head = await postGraphql(nodeUrl, "query { pair: lastBlockPair { json } }");
  const tip = Number(decimal(head?.pair?.json?.last_block?.[0]));
  if (!Number.isSafeInteger(tip)) return "";
  const made = Number(at) > 0 ? Number(at) : Date.now();
  const from = Math.max(0, tip - Math.ceil(Math.max(0, Date.now() - made) / BLOCK_MS_AT_LEAST) - BLOCKS_BEFORE);
  const want = BigInt(nonce);
  for (let page = 1; page <= TAKEN_PAGES; page++) {
    const args = [`sender: ${JSON.stringify(String(account))}`, `fromBlock: ${from}`, `maxCount: ${TAKEN_PAGE}`, ...(page > 1 ? [`pageCount: ${page}`] : [])];
    const rows = (await postGraphql(nodeUrl, `query { h: moonlightHistory(${args.join(", ")}) { json } }`))?.h?.json;
    const list = Array.isArray(rows) ? rows : [];
    const hashes = [...new Set(list.map((row) => String(row?.origin ?? "").toLowerCase()).filter((id) => /^[0-9a-f]{64}$/.test(id)))];
    if (hashes.length) {
      const txs = await postGraphql(nodeUrl, `query { ${hashes.map((id, i) => `t${i}: tx(hash: ${JSON.stringify(id)}) { tx { json } }`).join(" ")} }`);
      for (const [i, id] of hashes.entries()) {
        const said = txJson(txs?.[`t${i}`]?.tx?.json);
        const its = decimal(said?.nonce);
        if (said?.type === "moonlight" && String(said?.sender ?? "") === String(account) && its !== undefined && BigInt(its) === want) return id;
      }
    }
    if (list.length < TAKEN_PAGE) break;
  }
  return "";
}

/**
 * Where a public transaction handed to the node without a clear answer
 * stands, as the node says it: "in" its chain or its mempool, so it went;
 * "absent", in neither and its account's nonce not past it, so the node never
 * had it (or turned it down) and it can't go out unless it's sent again;
 * "replaced", in neither, the account's nonce past it, and the account's
 * transaction at its nonce seen, another: it never will go (`by`, that one's
 * ID); "used", in neither though the account's nonce went past it, with no
 * transaction seen at its nonce yet, which is no proof: the chain's list may
 * be behind, and it may yet be this one; "unknown" where the node couldn't be
 * asked. Without `prove`, a nonce gone past is "used", the transaction at it
 * not looked for.
 * @param {string} nodeUrl
 * @param {{ hash: string, account: string, nonce: string | bigint, at?: number }} tx - `at`, when the payment was made
 * @param {{ prove?: boolean }} [opts]
 * @returns {Promise<{ state: "in" | "absent" | "replaced" | "used" | "unknown", presence?: object, by?: string }>}
 */
export async function handedOverState(nodeUrl, { hash, account, nonce, at }, { prove = true } = {}) {
  const presence = await classifyTxPresence(nodeUrl, hash);
  if (presence.state === "executed_success" || presence.state === "executed_failed" || presence.state === "mempool") return { state: "in", presence };
  if (presence.state !== "not_found" || !account || !/^\d+$/.test(String(nonce ?? ""))) return { state: "unknown" };
  try {
    if ((await accountNonce(nodeUrl, account)) < BigInt(nonce)) return { state: "absent" };
    if (!prove) return { state: "used" };
    const by = await nonceTakenBy(nodeUrl, { account, nonce, at });
    if (!by) return { state: "used" };
    // Its own, listed before the chain's lookup by its ID has it: it went.
    return by === String(hash ?? "").toLowerCase() ? { state: "in" } : { state: "replaced", by };
  } catch {
    return { state: "unknown" };
  }
}

export async function classifyTxPresence(nodeUrl, hash) {
  try {
    const tx = await queryTxByHash(nodeUrl, hash);
    if (tx) {
      const error = txError(tx);
      return error
        ? { state: "executed_failed", tx, error }
        : { state: "executed_success", tx };
    }

    const mempool = await queryMempoolTxs(nodeUrl);
    const found = mempool.find((t) => String(t?.id ?? "") === String(hash));
    return found ? { state: "mempool", tx: found } : { state: "not_found" };
  } catch (e) {
    return { state: "unavailable", error: e?.message ?? String(e) };
  }
}
