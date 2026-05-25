/**
 * Best-effort transaction lifecycle reconciliation against a Dusk node.
 *
 * `mempoolTxs` is exposed by the public Postman collection and current node
 * GraphQL surface, but is treated as best-effort because its detailed shape is
 * less stable than finalized `tx(hash)` lookups.
 */

function graphqlUrl(nodeUrl) {
  const base = String(nodeUrl || "").trim();
  if (!base) throw new Error("nodeUrl is required");
  return new URL("/on/graphql/query", base).toString();
}

async function postGraphql(nodeUrl, query) {
  const res = await fetch(graphqlUrl(nodeUrl), {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: query,
  });

  if (!res.ok) {
    throw new Error(`GraphQL request failed (${res.status})`);
  }

  const json = await res.json();
  if (Array.isArray(json?.errors) && json.errors.length) {
    const msg = json.errors.map((e) => e?.message || String(e)).join("; ");
    throw new Error(msg || "GraphQL returned errors");
  }
  return json;
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
