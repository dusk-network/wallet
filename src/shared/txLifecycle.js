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
