// What a call to the DuskEVM bridge's contracts on DuskDS does, read from its
// arguments, so a site's request can show it instead of opaque bytes: a
// deposit's DuskEVM recipient and amount, and a withdrawal's amount and Dusk
// recipient when it is proved or claimed.
//
// Only the contracts in BRIDGE_CONTRACTS, through their network's own node: a
// network without them (Mainnet, for now) decodes nothing, and neither does a
// custom node, whose contract at the same ID could be anything. The
// arguments are rkyv, as
// the bridge's encoder and the portal's data driver write them, and must
// decode exactly: every pointer in bounds, a withdrawal's amount the same in
// each place it's written, and its route the bridge's own. Anything else
// stays undecoded.

import { keccak_256 } from "@noble/hashes/sha3";

import { formatDuskExact, safeBigInt } from "./amount.js";
import { BRIDGE_CONTRACTS, BRIDGE_SERVICE_ACCOUNTS } from "./bridge.js";
import { toBytes } from "./bytes.js";
import { NETWORK_PRESETS } from "./networkPresets.js";

export const BRIDGE_FUNCTIONS = Object.freeze({
  deposit: "depositETHToWithValue",
  prove: "proveWithdrawalTransaction",
  claim: "finalizeWithdrawalTransaction",
  claimWithProofOf: "finalizeWithdrawalTransactionExternalProof",
});

// Archived sizes, in bytes. The root object sits at the end of the buffer.
const DEPOSIT_ROOT = 40; // u64 amount, [u8; 20] to, u32 min gas, Vec<u8> extra data
const WITHDRAWAL = 144; // nonce, value, gas limit (32 each), Vec<u8> data, sender, target (20 each)
const PROVE_ROOT = 312; // output root proof (128), game index (32), withdrawal, Vec<Vec<u8>> proof
const CLAIM_ROOT = WITHDRAWAL;
const CLAIM_WITH_PROOF_OF_ROOT = WITHDRAWAL + 20;

// What DuskEVM's bridge relays: L1CrossDomainMessenger.relayMessage, with
// L1StandardBridge.finalizeBridgeETH as its message.
const RELAY_MESSAGE = "d764ad0b";
const FINALIZE_BRIDGE_ETH = "1635f5fd";

// The route a DUSK withdrawal takes: DuskEVM's messenger sends it to Dusk's,
// relaying DuskEVM's bridge to Dusk's. The DuskEVM side are OP-stack
// predeploys; the Dusk side are the EVM addresses DuskEVM gives Dusk's
// contracts (L2CrossDomainMessenger.otherMessenger, L2StandardBridge.
// otherBridge), the bridge's being its contract ID's (evmAddressOf). A
// withdrawal on any other route is some other message through the portal.
const L2_MESSENGER = "4200000000000000000000000000000000000007";
const L2_BRIDGE = "4200000000000000000000000000000000000010";
const L1_MESSENGERS = Object.freeze({
  testnet: "8b6aa15321d9656c91ad2d5fbc2ae8b750ad6f9a",
});

const WEI_PER_LUX = 1_000_000_000n;

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const norm = (id) =>
  String(id ?? "")
    .trim()
    .toLowerCase()
    .replace(/^0x/, "");

function fail() {
  throw new Error("Not a known bridge call");
}

function uintLe(bytes, at, length) {
  let out = 0n;
  for (let i = length - 1; i >= 0; i--) out = (out << 8n) | BigInt(bytes[at + i]);
  return out;
}

function uintBe(bytes, at, length) {
  let out = 0n;
  for (let i = 0; i < length; i++) out = (out << 8n) | BigInt(bytes[at + i]);
  return out;
}

// An ArchivedVec<T> at `at`: a relative pointer and a length. Its items must
// lie before `end` (the root), where the serializer put them.
function vecAt(bytes, at, end, itemSize = 1) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = at + view.getInt32(at, true);
  const length = view.getUint32(at + 4, true);
  if (start < 0 || start + length * itemSize > end) fail();
  return { start, length };
}

function bytesAt(bytes, at, end) {
  const { start, length } = vecAt(bytes, at, end);
  return bytes.subarray(start, start + length);
}

/** The EVM address DuskEVM gives a Dusk contract: its ID's keccak-256, last 20 bytes. */
export function evmAddressOf(contractId) {
  const id = norm(contractId);
  if (!/^[0-9a-f]{64}$/.test(id)) return "";
  return hex(keccak_256(Uint8Array.from(id.match(/../g), (b) => parseInt(b, 16)))).slice(-40);
}

/** An EVM address with its EIP-55 checksum, as EVM wallets and the bridge write it. */
export function checksumAddress(bytes20) {
  const lower = hex(bytes20);
  const digest = hex(keccak_256(new TextEncoder().encode(lower)));
  let out = "0x";
  for (let i = 0; i < lower.length; i++) {
    out += parseInt(digest[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

// ---- Dusk recipients ------------------------------------------------------

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const P = BigInt(
  "0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab"
);
const R_INVERSE = BigInt(
  "0x14fec701e8fb0ce9ed5e64273c4f538b1797ab1458a88de9343ea97914956dc87fe11274d898fafbf4d38259380b4820"
);
const FP_BYTES = 48;
const RAW_KEY_BYTES = 4 * FP_BYTES + 1;
const HALF = (P - 1n) / 2n;

// A field element in Montgomery form, little-endian limbs.
function fp(raw, at) {
  const montgomery = uintLe(raw, at, FP_BYTES);
  if (montgomery >= P) fail();
  return (montgomery * R_INVERSE) % P;
}

function fpBytes(value) {
  const out = new Uint8Array(FP_BYTES);
  let rest = value;
  for (let i = FP_BYTES - 1; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

// The Dusk account of a raw BLS key (affine x and y, then a zero identity
// flag): the key compressed as Dusk writes it, x as c1 || c0 with the
// compression and sign flags on top, in base58.
function rawKeyToAccount(raw) {
  if (raw.length !== RAW_KEY_BYTES || raw[RAW_KEY_BYTES - 1] !== 0) fail();
  const [x0, x1, y0, y1] = [0, 1, 2, 3].map((i) => fp(raw, i * FP_BYTES));
  const largest = y1 > HALF || (y1 === 0n && y0 > HALF);
  const compressed = new Uint8Array(2 * FP_BYTES);
  compressed.set(fpBytes(x1), 0);
  compressed.set(fpBytes(x0), FP_BYTES);
  compressed[0] |= 0x80 | (largest ? 0x20 : 0);
  return encodeBase58(compressed);
}

// Who a withdrawal pays on Dusk, from finalizeBridgeETH's extra data: an
// account (tag 2, version 1, kind 0, its raw key) or a contract (tag 32,
// version 1, its ID, a payload for it).
function duskRecipient(extraData) {
  const b = extraData;
  if (b.length === 3 + RAW_KEY_BYTES && b[0] === 2 && b[1] === 1 && b[2] === 0) {
    return { kind: "account", account: rawKeyToAccount(b.subarray(3)) };
  }
  if (b.length >= 34 && b[0] === 32 && b[1] === 1) {
    const contractId = hex(b.subarray(2, 34));
    if (/^0+$/.test(contractId)) fail();
    return { kind: "contract", contractId };
  }
  return fail();
}

// ---- ABI ------------------------------------------------------------------

// A call's arguments by type: "uint" (a word), "address" (a word whose top 12
// bytes are zero) and "bytes" (a word pointing at a length and the bytes).
function abiCall(data, selector, types) {
  if (data.length < 4 + 32 * types.length || hex(data.subarray(0, 4)) !== selector) fail();
  const body = data.subarray(4);
  return types.map((type, i) => {
    const word = body.subarray(32 * i, 32 * i + 32);
    if (type === "uint") return uintBe(word, 0, 32);
    if (type === "address") {
      if (word.subarray(0, 12).some((b) => b !== 0)) fail();
      return word.subarray(12);
    }
    const offset = uintBe(word, 0, 32);
    if (offset < BigInt(32 * types.length) || offset + 32n > BigInt(body.length)) fail();
    const at = Number(offset);
    const length = uintBe(body, at, 32);
    if (BigInt(at) + 32n + length > BigInt(body.length)) fail();
    return body.subarray(at + 32, at + 32 + Number(length));
  });
}

// ---- Calls ----------------------------------------------------------------

// The network preset `nodeUrl` is the own node of, or null for a custom one.
function presetOf(nodeUrl) {
  const origin = (url) => {
    try {
      return new URL(String(url ?? "")).origin;
    } catch {
      return "";
    }
  };
  const at = origin(nodeUrl);
  return at ? NETWORK_PRESETS.find((p) => p.nodeUrl && origin(p.nodeUrl) === at) ?? null : null;
}

// The bridge's contracts when `nodeUrl` is its network's own node, with the
// route its withdrawals take there (null without one: none decode).
function bridgeContracts(nodeUrl) {
  const preset = presetOf(nodeUrl);
  const contracts = (preset && BRIDGE_CONTRACTS[preset.id]) || null;
  if (!contracts) return null;
  const l1Messenger = L1_MESSENGERS[preset.id];
  const route = l1Messenger
    ? { l2Messenger: L2_MESSENGER, l1Messenger, l2Bridge: L2_BRIDGE, l1Bridge: evmAddressOf(contracts.bridge) }
    : null;
  return { ...contracts, route };
}

function decodeDeposit(args) {
  const root = args.length - DEPOSIT_ROOT;
  if (root < 0 || root % 8 !== 0) fail();
  const extraData = bytesAt(args, root + 32, root);
  return {
    amountLux: uintLe(args, root, 8),
    recipient: checksumAddress(args.subarray(root + 8, root + 28)),
    minGasLimit: Number(uintLe(args, root + 28, 4)),
    extraDataBytes: extraData.length,
  };
}

// A withdrawal, as DuskEVM recorded it: what it pays, to whom on Dusk, and
// who sent it on DuskEVM. It takes the bridge's route, from messenger to
// messenger relaying bridge to bridge, and its amount is the same in the
// withdrawal, the relay and the bridge's message, or the bridge didn't send it.
function decodeWithdrawal(args, at, end, route) {
  if (!route) fail();
  const value = uintBe(args, at + 32, 32);
  const data = bytesAt(args, at + 96, end);
  const sender = hex(args.subarray(at + 104, at + 124));
  const target = hex(args.subarray(at + 124, at + 144));
  if (sender !== route.l2Messenger || target !== route.l1Messenger) fail();
  const [, relaySender, relayTarget, relayValue, , message] = abiCall(data, RELAY_MESSAGE, ["uint", "address", "address", "uint", "uint", "bytes"]);
  if (hex(relaySender) !== route.l2Bridge || hex(relayTarget) !== route.l1Bridge) fail();
  const [from, , amountWei, extraData] = abiCall(message, FINALIZE_BRIDGE_ETH, ["address", "address", "uint", "bytes"]);
  if (value !== relayValue || relayValue !== amountWei) fail();
  return {
    amountWei,
    sender: checksumAddress(from),
    recipient: duskRecipient(extraData),
    gasLimit: uintBe(args, at + 64, 32),
  };
}

function decodeProve(args, route) {
  const root = args.length - PROVE_ROOT;
  if (root < 0 || root % 4 !== 0) fail();
  // The proof's nodes: each a Vec<u8> before the root.
  const proof = vecAt(args, root + 304, root, 8);
  for (let i = 0; i < proof.length; i++) vecAt(args, proof.start + 8 * i, root);
  return {
    ...decodeWithdrawal(args, root + 160, root, route),
    disputeGameIndex: uintBe(args, root + 128, 32),
    proofNodes: proof.length,
  };
}

function decodeClaim(args, rootSize, route) {
  const root = args.length - rootSize;
  if (root < 0 || root % 4 !== 0) fail();
  const out = decodeWithdrawal(args, root, root, route);
  if (rootSize === CLAIM_WITH_PROOF_OF_ROOT) out.proofSubmitter = checksumAddress(args.subarray(root + WITHDRAWAL, root + WITHDRAWAL + 20));
  return out;
}

/**
 * What a contract call to the DuskEVM bridge does, or null when it isn't one
 * of the bridge's known calls on this network, or its arguments don't decode
 * exactly as the bridge encodes them.
 *
 * - deposit: `{ kind: "deposit", amountLux, recipient, minGasLimit,
 *   extraDataBytes, sentLux }`, recipient being the DuskEVM address; the call
 *   sends `sentLux` (its deposit), which should equal amountLux
 * - prove and claim: `{ kind: "prove" | "claim", amountWei, recipient,
 *   sender, gasLimit, ... }`, recipient being `{ kind: "account", account }`
 *   or `{ kind: "contract", contractId }` on Dusk, sender the DuskEVM address
 *   that withdrew; only a withdrawal on the bridge's route
 *
 * @param {{ nodeUrl?: string, contractId?: string, fnName?: string, args?: Uint8Array, deposit?: string|bigint }} call
 * @returns {object|null}
 */
export function decodeBridgeCall({ nodeUrl, contractId, fnName, args, deposit } = {}) {
  const contracts = bridgeContracts(nodeUrl);
  if (!contracts || !(args instanceof Uint8Array)) return null;
  const id = norm(contractId);
  const fn = String(fnName ?? "").trim();
  try {
    if (id === contracts.bridge && fn === BRIDGE_FUNCTIONS.deposit) {
      let sentLux = 0n;
      try {
        sentLux = BigInt(String(deposit ?? "0"));
      } catch {
        sentLux = -1n;
      }
      return { kind: "deposit", ...decodeDeposit(args), sentLux };
    }
    if (id === contracts.portal) {
      const { route } = contracts;
      if (fn === BRIDGE_FUNCTIONS.prove) return { kind: "prove", ...decodeProve(args, route) };
      if (fn === BRIDGE_FUNCTIONS.claim) return { kind: "claim", ...decodeClaim(args, CLAIM_ROOT, route) };
      if (fn === BRIDGE_FUNCTIONS.claimWithProofOf) return { kind: "claim", ...decodeClaim(args, CLAIM_WITH_PROOF_OF_ROOT, route) };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Whether the transfer a bridge call rides on is the one the bridge's route
 * expects. The wallet sends a contract call as a transfer of `amount` to
 * `to` that carries the call and its `deposit`: a deposit to DuskEVM moves
 * its bridged amount as the deposit and no amount; a proof or a claim moves
 * neither; and none pays an account but the payer's own (no `to`, or one of
 * `own`). Anything else isn't the bridge's call alone.
 *
 * @param {object} call - from decodeBridgeCall
 * @param {{ amount?: string|bigint, deposit?: string|bigint, to?: string, own?: string[] }} envelope
 * @returns {boolean}
 */
export function bridgeEnvelopeOk(call, { amount, deposit, to, own = [] } = {}) {
  const lux = (value) => {
    try {
      return BigInt(String(value ?? "").trim() || "0");
    } catch {
      return -1n;
    }
  };
  if (!call || lux(amount) !== 0n) return false;
  const sent = lux(deposit);
  if (call.kind === "deposit" ? sent !== call.amountLux : sent !== 0n) return false;
  const recipient = String(to ?? "").trim();
  return !recipient || own.includes(recipient);
}

/**
 * The DuskEVM address a deposit to DuskEVM pays, for the wallet's record of
 * it: only for a deposit decodeBridgeCall reads, sent as the bridge's route
 * expects (bridgeEnvelopeOk), else undefined.
 * @param {{ nodeUrl?: string, contractId?: string, fnName?: string, fnArgs?: unknown, amount?: string|bigint, deposit?: string|bigint }} tx
 * @returns {string|undefined} the address with its checksum
 */
export function bridgeDepositRecipient({ nodeUrl, contractId, fnName, fnArgs, amount, deposit } = {}) {
  let args;
  try {
    args = toBytes(fnArgs);
  } catch {
    return undefined;
  }
  const call = decodeBridgeCall({ nodeUrl, contractId, fnName, args, deposit });
  return call?.kind === "deposit" && bridgeEnvelopeOk(call, { amount, deposit }) ? call.recipient : undefined;
}

/**
 * The DuskEVM address a deposit to DuskEVM paid, from its call's arguments
 * as the archive gives them, in hex: null for anything decodeBridgeCall
 * doesn't read as a deposit.
 * @param {{ nodeUrl?: string, contractId?: string, fnName?: string, data?: string }} call
 * @returns {string|null} the address with its checksum
 */
export function depositRecipientOf({ nodeUrl, contractId, fnName, data } = {}) {
  const text = norm(data);
  if (!/^(?:[0-9a-f]{2})+$/.test(text)) return null;
  const args = Uint8Array.from(text.match(/../g), (b) => parseInt(b, 16));
  const call = decodeBridgeCall({ nodeUrl, contractId, fnName, args });
  return call?.kind === "deposit" ? call.recipient : null;
}

/**
 * Whether a call goes to the DuskEVM bridge's contracts on this network,
 * decoded or not. One that decodeBridgeCall doesn't read is the bridge's
 * contract doing something the wallet can't vouch for.
 * @param {{ nodeUrl?: string, contractId?: string }} call
 * @returns {boolean}
 */
export function callsBridge({ nodeUrl, contractId } = {}) {
  const contracts = bridgeContracts(nodeUrl);
  const id = norm(contractId);
  return Boolean(contracts && id && (id === contracts.bridge || id === contracts.portal));
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
  if (digits === digits.toLowerCase() || digits === digits.toUpperCase()) return true;
  return checksumAddress(Uint8Array.from(digits.match(/../g), (b) => parseInt(b, 16))) === text;
}

/**
 * A transfer to the bridge's account on Dusk (BRIDGE_SERVICE_ACCOUNTS),
 * which pays its memo's EVM address on another chain: that chain, whether
 * the memo is an address there, whether the bridge pays out there now, and
 * what arrives of the amount once the bridge takes its fee. Null for any
 * other transfer, and on a node that isn't its network's own.
 * @param {{ nodeUrl?: string, to?: string, memo?: string, amount?: string|bigint }} transfer - `amount` in Lux
 * @returns {{ chain: string, short: string, network: string, recipient: string, recipientOk: boolean,
 *   running: boolean, sentLux: bigint, feeLux: bigint, arrivesLux: bigint } | null}
 */
export function bridgeServiceTransfer({ nodeUrl, to, memo, amount } = {}) {
  const preset = presetOf(nodeUrl);
  const service = preset ? BRIDGE_SERVICE_ACCOUNTS[preset.id] : null;
  if (!service || String(to ?? "").trim() !== service.account) return null;
  const recipient = String(memo ?? "").trim();
  const sentLux = safeBigInt(amount ?? 0, 0n);
  const feeLux = BigInt(service.feeLux);
  return {
    chain: service.chain,
    short: service.short,
    network: preset.id,
    recipient,
    recipientOk: isEvmAddress(recipient),
    running: service.running,
    sentLux,
    feeLux,
    arrivesLux: sentLux > feeLux ? sentLux - feeLux : 0n,
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
      text: `The bridge isn't paying out on ${service.short} at the moment, so DUSK sent to it doesn't arrive there.`,
    });
  }
  if (service.arrivesLux <= 0n) {
    out.push({
      kind: "fee",
      title: `Nothing arrives on ${service.short}`,
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
