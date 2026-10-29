// Plain words for the contract calls Activity knows, as the explorer names
// them: a call to Dusk Domains by what it did to a .dusk name, a
// registration by the name it registered, read from its arguments, and a
// name reservation by the name of the registration that follows it. Only on
// the network the contracts are on, and only for a node of that network: a
// custom node's contract at the same ID could be anything. The facts are
// @duskdomains/sdk's (call-facts), read from the call alone; the words are
// the wallet's.

import { nameCall } from "@duskdomains/sdk/call-facts";
import { contractRole } from "@duskdomains/sdk/releases";

import { toBytes } from "./bytes.js";
import { labelForNode } from "./nodeNetwork.js";
import { duskNamesNetwork } from "./verifiedNames.js";

// What a Dusk Domains call did, by what it is.
const NAME_CALLS = Object.freeze({
  reservation: "Name reservation (step 1 of 2)",
  registration: "Registered a .dusk name",
  renewal: "Renewed a .dusk name",
  issue: "Issued a reserved .dusk name",
  subname: "Created a .dusk subname",
  "primary-set": "Set a primary .dusk name",
  "primary-cleared": "Cleared the primary .dusk name",
  records: "Changed a .dusk name's records",
});

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
 * What a known contract call did, or null for a contract the wallet doesn't
 * name on this network.
 * @param {{ contractId?: string, fnName?: string, nodeUrl?: string, registeredName?: string|null, reservedName?: string|null }} call
 *   `registeredName`: the name a registration registered, once read
 *   (registeredNameOf); `reservedName`: the name a reservation was for, once
 *   its registration followed (activityMerge.js)
 * @returns {{ app: "Dusk Domains", label: string } | null} `label`: the call
 *   in words, or the app's name for a function without them
 */
export function knownCall({ contractId, fnName, nodeUrl, registeredName, reservedName } = {}) {
  const fact = factsOf({ contractId, fnName, nodeUrl });
  if (!fact) return null;
  if (fact.kind === "registration" && registeredName) return { app: "Dusk Domains", label: `Registered ${registeredName}` };
  if (fact.kind === "reservation" && reservedName) return { app: "Dusk Domains", label: `Reserved ${reservedName}` };
  return { app: "Dusk Domains", label: NAME_CALLS[fact.kind] ?? "Dusk Domains" };
}

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
