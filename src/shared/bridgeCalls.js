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
// decode exactly: every pointer in bounds, and a withdrawal's amount the same
// in each place it's written. Anything else stays undecoded.

import { keccak_256 } from "@noble/hashes/sha3";

import { BRIDGE_CONTRACTS } from "./bridge.js";
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

// The bridge's contracts when `nodeUrl` is its network's own node.
function bridgeContracts(nodeUrl) {
  const origin = (url) => {
    try {
      return new URL(String(url ?? "")).origin;
    } catch {
      return "";
    }
  };
  const at = origin(nodeUrl);
  const preset = at ? NETWORK_PRESETS.find((p) => p.nodeUrl && origin(p.nodeUrl) === at) : null;
  return (preset && BRIDGE_CONTRACTS[preset.id]) || null;
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
// who sent it on DuskEVM. The amount is the same in the withdrawal, the relay
// and the bridge's message, or it isn't one the bridge sent.
function decodeWithdrawal(args, at, end) {
  const value = uintBe(args, at + 32, 32);
  const data = bytesAt(args, at + 96, end);
  const [, , , relayValue, , message] = abiCall(data, RELAY_MESSAGE, ["uint", "address", "address", "uint", "uint", "bytes"]);
  const [from, , amountWei, extraData] = abiCall(message, FINALIZE_BRIDGE_ETH, ["address", "address", "uint", "bytes"]);
  if (value !== relayValue || relayValue !== amountWei) fail();
  return {
    amountWei,
    sender: checksumAddress(from),
    recipient: duskRecipient(extraData),
    gasLimit: uintBe(args, at + 64, 32),
  };
}

function decodeProve(args) {
  const root = args.length - PROVE_ROOT;
  if (root < 0 || root % 4 !== 0) fail();
  // The proof's nodes: each a Vec<u8> before the root.
  const proof = vecAt(args, root + 304, root, 8);
  for (let i = 0; i < proof.length; i++) vecAt(args, proof.start + 8 * i, root);
  return {
    ...decodeWithdrawal(args, root + 160, root),
    disputeGameIndex: uintBe(args, root + 128, 32),
    proofNodes: proof.length,
  };
}

function decodeClaim(args, rootSize) {
  const root = args.length - rootSize;
  if (root < 0 || root % 4 !== 0) fail();
  const out = decodeWithdrawal(args, root, root);
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
 *   that withdrew
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
      if (fn === BRIDGE_FUNCTIONS.prove) return { kind: "prove", ...decodeProve(args) };
      if (fn === BRIDGE_FUNCTIONS.claim) return { kind: "claim", ...decodeClaim(args, CLAIM_ROOT) };
      if (fn === BRIDGE_FUNCTIONS.claimWithProofOf) return { kind: "claim", ...decodeClaim(args, CLAIM_WITH_PROOF_OF_ROOT) };
    }
  } catch {
    return null;
  }
  return null;
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
