// Read-only calls of the data-driver contracts the engine reads together, as
// Sozu's hub, pool and stDUSK token, sent through Multicall for Dusk: the reads
// made in one task go as one `aggregate` query (multicallFetch.js). Each read's
// argument is encoded, and its answer decoded, by the contract's data driver,
// as w3sper's `Contract.call` does: only the transport changes. A read alone in
// its task goes as it is.

import { createMulticallFetch } from "./multicallFetch.js";

/**
 * @typedef {{ id: string, encode: (fnName: string, args?: unknown) => Promise<Uint8Array> }} ReadableContract
 * @typedef {{ decodeOutputFn: (fnName: string, bytes: Uint8Array) => unknown }} OutputDriver
 */

/**
 * @param {{ nodeUrl: string, fetch?: typeof fetch }} opts - `fetch` sends the queries
 * @returns {(contract: ReadableContract, driver: OutputDriver, fnName: string, args?: unknown) => Promise<unknown>}
 */
export function createContractReads({ nodeUrl, fetch: base = (...args) => fetch(...args) }) {
  const node = String(nodeUrl).replace(/\/$/, "");
  const batched = createMulticallFetch({ nodeUrl: node, fetch: base });

  return async (contract, driver, fnName, args) => {
    const body = await contract.encode(fnName, args);
    const res = await batched(`${node}/on/contracts:${contract.id}/${fnName}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `HTTP ${res.status}`);
    }
    return driver.decodeOutputFn(String(fnName), new Uint8Array(await res.arrayBuffer()));
  };
}
