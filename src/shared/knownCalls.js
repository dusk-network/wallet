// Plain words for the contract calls Activity knows, as the explorer names
// them: a call to Dusk Domains by what it did to a .dusk name. Only on the
// network the contracts are on, and only for a node of that network: a
// custom node's contract at the same ID could be anything. It reads nothing
// from the node.

import releases from "./dusk-domains-releases.json";
import { detectPresetIdFromNodeUrl } from "./network.js";

// What a Dusk Domains call did, by its function.
const NAME_CALLS = Object.freeze({
  commit: "Reserved a .dusk name",
  register: "Registered a .dusk name",
  renew: "Renewed a .dusk name",
  issue_reserved: "Issued a reserved .dusk name",
  create_subname: "Created a .dusk subname",
  set_primary: "Set a primary .dusk name",
  clear_primary: "Cleared the primary .dusk name",
  mutate_records: "Changed a .dusk name's records",
});

const norm = (id) =>
  String(id ?? "")
    .trim()
    .toLowerCase()
    .replace(/^0x/, "");

// Dusk Domains' contracts on each network, its lens included.
const DUSK_DOMAINS = Object.fromEntries(
  Object.entries(releases).map(([network, release]) => [
    network,
    new Set([...(release.contracts ?? []).map((c) => norm(c.contractId)), norm(release.lens?.contractId)].filter(Boolean)),
  ])
);

/**
 * What a known contract call did, or null for a contract the wallet doesn't
 * name on this network.
 * @param {{ contractId?: string, fnName?: string, nodeUrl?: string }} call
 * @returns {{ app: "Dusk Domains", label: string } | null} `label`: the call
 *   in words, or the app's name for a function without them
 */
export function knownCall({ contractId, fnName, nodeUrl } = {}) {
  const ids = DUSK_DOMAINS[detectPresetIdFromNodeUrl(String(nodeUrl ?? ""))];
  if (!ids?.has(norm(contractId))) return null;
  const fn = String(fnName ?? "").trim();
  return { app: "Dusk Domains", label: Object.hasOwn(NAME_CALLS, fn) ? NAME_CALLS[fn] : "Dusk Domains" };
}
