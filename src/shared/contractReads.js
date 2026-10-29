// Read-only contract calls sent through Multicall for Dusk: the reads made in
// one task go as one `aggregate` query (@hdauven/dusk-multicall), and each
// gets its own reply's bytes, as the node would have sent them. A read alone
// in its task goes as it is. The caller encodes the argument and decodes the
// reply, as Sozu's reads do (readSozuStatus, @dusk-network/networks/sozu):
// only the transport changes.

import { createMulticallFetch } from "@hdauven/dusk-multicall";

/**
 * @param {{ nodeUrl: string, multicallId: string | null, fetch?: typeof fetch }} opts - `multicallId`:
 *   the multicall on the node's network, as its file has it, or null for none; `fetch` sends the queries
 * @returns {(contractId: string, fnName: string, args: Uint8Array) => Promise<Uint8Array>}
 */
export function createContractReads({ nodeUrl, multicallId, fetch: base = (...args) => fetch(...args) }) {
  const node = String(nodeUrl).replace(/\/$/, "");
  const batched = createMulticallFetch({ nodeUrl: node, multicallId, fetch: base });

  return async (contractId, fnName, args) => {
    const res = await batched(`${node}/on/contracts:${contractId}/${fnName}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: args,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `HTTP ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  };
}
