// The contract calls Activity knows: a call to Dusk Domains by what it did to
// a .dusk name, a registration by the name it registered, read from its
// arguments, and a name reservation as its call makes it or a registration
// reveals it. Only on the network the contracts are on, and only for a node
// of that network: a custom node's contract at the same ID could be anything.
// The facts are @duskdomains/sdk's (call-facts), read from the call alone.

import { nameCall } from "@duskdomains/sdk/call-facts";
import { contractRole } from "@duskdomains/sdk/releases";

import { toBytes } from "./bytes.js";
import { labelForNode } from "./nodeNetwork.js";
import { duskNamesNetwork } from "./verifiedNames.js";

/**
 * Whether `contractId` is one of Dusk Domains' contracts on the network of
 * `nodeUrl`, by the chain ID the node gave (nodeNetwork.js).
 * @param {string} contractId
 * @param {string} nodeUrl
 */
export function isDuskDomains(contractId, nodeUrl) {
  const network = duskNamesNetwork(nodeUrl);
  return Boolean(network && contractRole(String(contractId ?? ""), network));
}

/**
 * What a contract is called on the node's network, as the explorer names it:
 * by the network's file, or Dusk Domains for one of its contracts; null for
 * any other.
 * @param {string} contractId
 * @param {string} nodeUrl
 * @returns {string | null}
 */
export function contractLabel(contractId, nodeUrl) {
  return labelForNode(String(nodeUrl ?? ""), String(contractId ?? "")) ?? (isDuskDomains(contractId, nodeUrl) ? "Dusk Domains" : null);
}

// What a call to Dusk Domains on the node's network is (nameCall), its
// arguments in any encoding bytes.js reads; null for any other call.
function factsOf({ contractId, fnName, nodeUrl, args, account }) {
  const network = duskNamesNetwork(nodeUrl);
  if (!network) return null;
  let bytes = null;
  try {
    bytes = toBytes(args);
  } catch {
    // Arguments that don't read, which name nothing.
  }
  return nameCall({ contractId: String(contractId ?? ""), fnName: String(fnName ?? "").trim(), args: bytes }, network, account);
}

/**
 * What calls to Dusk Domains on the node's network did, for Activity's rows
 * (@dusk-network/app-core/activity's `nameCall`): a call's kind, and the
 * name a registration registered and the reservation, as kept with the
 * entry or the send (registeredNameOf, nameReservationOf): undefined while
 * its call isn't read, so the send's stand, and null for a call read that
 * has none. Null for any other call.
 * @param {string} nodeUrl
 * @returns {(call: { contractId: string, fnName: string }, kept: object) => { kind: string, name?: string|null, reservation?: string|null } | null}
 */
export const nameFactsFor = (nodeUrl) => (call, kept) => {
  const fact = factsOf({ ...call, nodeUrl });
  return fact && { kind: fact.kind, name: kept?.registeredName, reservation: kept?.reservation };
};

/**
 * The .dusk name a registration registered, read from its arguments:
 * undefined for any other call, and null for arguments that don't read as
 * the registration of the name of the node they name, as Dusk Domains checks.
 * @param {{ contractId?: string, fnName?: string, nodeUrl?: string, args?: unknown }} call
 * @returns {string|null|undefined} "alice.dusk"
 */
export function registeredNameOf(call = {}) {
  const fact = factsOf(call);
  return fact?.kind === "registration" ? fact.name : undefined;
}

/**
 * A name reservation as a reservation makes it, or as a registration reveals
 * it once it checks out for the account that sent it, in hex: the two match
 * when they're for the same name. Undefined for any other call, null for
 * arguments that don't read, or a registration that doesn't check out.
 * @param {{ contractId?: string, fnName?: string, nodeUrl?: string, args?: unknown, account?: string }} call
 *   `account`: the public account that sent it
 * @returns {string|null|undefined}
 */
export function nameReservationOf(call = {}) {
  return factsOf(call)?.reservation;
}
