// What a call to the DuskEVM bridge's contracts on DuskDS does, read from its
// arguments by @dusk-network/networks/duskevm, so a site's request can show it
// instead of opaque bytes, and what a transfer to the bridge's account on Dusk
// comes to.
//
// Only the bridge's contracts on the node's network, by the chain ID the node
// gave (nodeNetwork.js): a transaction carries that chain ID and goes through
// only on that chain, where the IDs are the bridge's. A network without them
// (Mainnet, for now) decodes nothing, and neither does a node whose network
// isn't known.

import { routeForAccount } from "@dusk-network/networks";
import { bridgeEnvelopeOk, decodeBridgeCall, isBridgeContract } from "@dusk-network/networks/duskevm";
import { formatEvmAddress } from "@dusk-network/networks/format";

import { formatDuskExact, safeBigInt } from "./amount.js";
import { toBytes } from "./bytes.js";
import { networkForNode } from "./nodeNetwork.js";

const WEI_PER_LUX = 1_000_000_000n;

/**
 * What a contract call to the DuskEVM bridge does (decodeBridgeCall), or null
 * when it isn't one of the bridge's known calls on the node's network, or its
 * arguments, in any encoding bytes.js reads, don't decode exactly as the
 * bridge encodes them.
 * @param {{ nodeUrl?: string, contractId?: string, fnName?: string, args?: unknown }} call
 * @returns {import("@dusk-network/networks/duskevm").BridgeCall | null}
 */
export function bridgeCallFor({ nodeUrl, contractId, fnName, args } = {}) {
  const net = networkForNode(String(nodeUrl ?? ""));
  try {
    return net ? decodeBridgeCall(net, { contractId, fnName, args: toBytes(args) }) : null;
  } catch {
    return null;
  }
}

/**
 * The DuskEVM address a deposit to DuskEVM pays, for the wallet's record of
 * it: only for a deposit bridgeCallFor reads, sent as the bridge's route
 * expects (bridgeEnvelopeOk), else undefined.
 * @param {{ nodeUrl?: string, contractId?: string, fnName?: string, fnArgs?: unknown, amount?: string|bigint, deposit?: string|bigint }} tx
 * @returns {string|undefined} the address with its checksum
 */
export function bridgeDepositRecipient({ nodeUrl, contractId, fnName, fnArgs, amount, deposit } = {}) {
  const call = bridgeCallFor({ nodeUrl, contractId, fnName, args: fnArgs });
  return call?.kind === "deposit" && bridgeEnvelopeOk(call, { amount, deposit }) ? call.recipient : undefined;
}

/**
 * Whether a call goes to the DuskEVM bridge's contracts on this network,
 * decoded or not. One that bridgeCallFor doesn't read is the bridge's
 * contract doing something the wallet can't vouch for.
 * @param {{ nodeUrl?: string, contractId?: string }} call
 * @returns {boolean}
 */
export function callsBridge({ nodeUrl, contractId } = {}) {
  const net = networkForNode(String(nodeUrl ?? ""));
  return Boolean(net && isBridgeContract(net, contractId));
}

/**
 * Whether `value` is an EVM address: 20 bytes in hex after 0x, and a mixed
 * case one with its EIP-55 checksum right.
 * @param {string} value
 * @returns {boolean}
 */
export function isEvmAddress(value) {
  const text = String(value ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) return false;
  const digits = text.slice(2);
  return digits === digits.toLowerCase() || digits === digits.toUpperCase() || formatEvmAddress(text) === text;
}

/**
 * A transfer to the bridge's account on Dusk, a service route of the node's
 * network (@dusk-network/networks), which pays its memo's EVM address on
 * another chain: that chain, whether the memo is an address there, whether
 * the bridge pays out there now, and what arrives of the amount once the
 * bridge takes its fee. Null for any other transfer, and on a node whose
 * network isn't known.
 * @param {{ nodeUrl?: string, to?: string, memo?: string, amount?: string|bigint }} transfer - `amount` in Lux
 * @returns {{ chain: string, network: string, recipient: string, recipientOk: boolean,
 *   running: boolean, sentLux: bigint, feeLux: bigint, arrivesLux: bigint } | null}
 */
export function bridgeServiceTransfer({ nodeUrl, to, memo, amount } = {}) {
  const net = networkForNode(String(nodeUrl ?? ""));
  const route = net ? routeForAccount(net, String(to ?? ""), "out") : null;
  if (!route) return null;
  const recipient = String(memo ?? "").trim();
  const sentLux = safeBigInt(amount ?? 0, 0n);
  return {
    chain: route.chain.name,
    network: net.name,
    recipient,
    recipientOk: isEvmAddress(recipient),
    running: route.running,
    sentLux,
    feeLux: route.feeLux,
    arrivesLux: sentLux > route.feeLux ? sentLux - route.feeLux : 0n,
  };
}

/**
 * What a transfer to the bridge's account comes to, in one line: "2 DUSK
 * sent · 1 DUSK bridge fee · 1 DUSK arrives on BNB Smart Chain", or
 * "Nothing arrives" when the fee takes it all, the bridge doesn't pay out
 * there now, or the memo is no address there to pay.
 * @param {{ chain: string, running: boolean, recipientOk: boolean, sentLux: bigint, feeLux: bigint, arrivesLux: bigint }} service - bridgeServiceTransfer's
 * @returns {string}
 */
export function bridgeServiceLine({ chain, running, recipientOk, sentLux, feeLux, arrivesLux }) {
  const arrives = !running || arrivesLux <= 0n
    ? `Nothing arrives on ${chain}`
    : recipientOk
      ? `${formatDuskExact(arrivesLux)} DUSK arrives on ${chain}`
      : noBridgeRecipientText(chain);
  return `${formatDuskExact(sentLux)} DUSK sent · ${formatDuskExact(feeLux)} DUSK bridge fee · ${arrives}`;
}

/**
 * What arrives of a payment to the bridge's account whose memo is no address
 * on its chain: "Nothing arrives without a BNB Smart Chain address in the memo".
 * @param {string} chain - bridgeServiceTransfer's `chain`
 * @returns {string}
 */
export function noBridgeRecipientText(chain) {
  return `Nothing arrives without ${/^[aeiou]/i.test(chain) ? "an" : "a"} ${chain} address in the memo`;
}

/**
 * What to warn of before paying the bridge's account, each as a title and
 * a line: a route the bridge doesn't pay out on now ("off"), and an amount
 * its fee takes whole ("fee").
 * @param {ReturnType<typeof bridgeServiceTransfer>} service
 * @returns {{ kind: "off" | "fee", title: string, text: string }[]}
 */
export function bridgeServiceWarnings(service) {
  const out = [];
  if (!service.running) {
    out.push({
      kind: "off",
      title: `Not running on ${service.network} right now`,
      text: `The bridge isn't paying out on ${service.chain} at the moment, so DUSK sent to it doesn't arrive there.`,
    });
  }
  if (service.arrivesLux <= 0n) {
    out.push({
      kind: "fee",
      title: `Nothing arrives on ${service.chain}`,
      text: `The bridge takes its ${formatDuskExact(service.feeLux)} DUSK fee from the amount, and this is no more than that.`,
    });
  }
  return out;
}

/**
 * A withdrawal's amount in DUSK: DuskEVM counts 18 decimals, Dusk 9. Whole
 * Lux show as Lux do; anything finer keeps its 18 decimals.
 * @param {bigint} wei
 * @returns {{ lux: bigint|null, text: string }}
 */
export function weiToDusk(wei) {
  const value = BigInt(wei);
  if (value % WEI_PER_LUX === 0n) return { lux: value / WEI_PER_LUX, text: "" };
  const whole = value / 10n ** 18n;
  const frac = (value % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return { lux: null, text: `${whole}.${frac}` };
}
