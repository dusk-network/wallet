import { describe, expect, it } from "vitest";

import { BRIDGE_CONTRACTS } from "./bridge.js";
import { BRIDGE_FUNCTIONS, checksumAddress, decodeBridgeCall, weiToDusk } from "./bridgeCalls.js";
import { hexToBytes } from "./bytes.js";
import fixtures from "./fixtures/duskevm-bridge-calls.json";

// Calls made with the bridge's own deposit encoder and its pinned
// OptimismPortal data driver; `expected` is what the bridge's decoders read
// from them. "deposit-shoot" is byte for byte what the bridge sent the wallet
// on testnet (40 bytes · sha256=2f64b19f5ac0…731c7c2a).
const TESTNET = "https://testnet.nodes.dusk.network";
const { bridge, portal } = BRIDGE_CONTRACTS.testnet;
const call = (name) => fixtures.calls.find((c) => c.name === name);
const decode = (name, over = {}) => {
  const c = call(name);
  return decodeBridgeCall({
    nodeUrl: TESTNET,
    contractId: c.fnName === BRIDGE_FUNCTIONS.deposit ? bridge : portal,
    fnName: c.fnName,
    args: hexToBytes(c.args),
    deposit: c.fnName === BRIDGE_FUNCTIONS.deposit ? c.expected.amountLux : "0",
    ...over,
  });
};

describe("DuskEVM bridge calls", () => {
  it("reads a deposit's DuskEVM recipient and amount, and what the call sends", () => {
    for (const name of ["deposit", "deposit-shoot"]) {
      const { expected } = call(name);
      expect(decode(name)).toEqual({
        kind: "deposit",
        amountLux: BigInt(expected.amountLux),
        recipient: expected.to,
        minGasLimit: expected.minGasLimit,
        extraDataBytes: 0,
        sentLux: BigInt(expected.amountLux),
      });
    }
    // A deposit that sends other DUSK than it bridges says so.
    expect(decode("deposit", { deposit: "200000000" })).toMatchObject({ amountLux: 100000000n, sentLux: 200000000n });
  });

  it.each([
    ["prove-account", "prove"],
    ["prove-contract", "prove"],
    ["claim-account", "claim"],
    ["claim-contract", "claim"],
    ["claim-external-account", "claim"],
    ["claim-external-contract", "claim"],
  ])("reads %s: the withdrawal's amount, who it pays on Dusk and who sent it", (name, kind) => {
    const { expected } = call(name);
    const out = decode(name);
    expect(out).toMatchObject({ kind, amountWei: BigInt(expected.amountWei), sender: expected.from });
    expect(out.recipient).toEqual(
      expected.recipient.length === 64
        ? { kind: "contract", contractId: expected.recipient }
        : { kind: "account", account: expected.recipient }
    );
    if (kind === "prove") expect(out).toMatchObject({ disputeGameIndex: 42n, proofNodes: 3 });
  });

  it("decodes nothing off the bridge's own network and contracts", () => {
    const deposit = call("deposit");
    const args = hexToBytes(deposit.args);
    const base = { contractId: bridge, fnName: deposit.fnName, args, deposit: "100000000" };
    expect(decodeBridgeCall({ ...base, nodeUrl: TESTNET })).not.toBeNull();
    // Mainnet has no bridge yet; a custom node's contract at that ID could be anything.
    for (const nodeUrl of ["https://nodes.dusk.network", "https://testnet.evil.example", "http://127.0.0.1:8080", "", undefined]) {
      expect(decodeBridgeCall({ ...base, nodeUrl }), String(nodeUrl)).toBeNull();
    }
    expect(decodeBridgeCall({ ...base, nodeUrl: TESTNET, contractId: portal })).toBeNull();
    expect(decodeBridgeCall({ ...base, nodeUrl: TESTNET, contractId: `0x${"ab".repeat(32)}` })).toBeNull();
    expect(decodeBridgeCall({ ...base, nodeUrl: TESTNET, fnName: "depositETH" })).toBeNull();
    expect(decodeBridgeCall({ ...base, nodeUrl: TESTNET, contractId: `0x${bridge.toUpperCase()}` })).not.toBeNull();
  });

  it("decodes nothing that differs from what the bridge encodes", () => {
    const tamper = (name, edit) => {
      const c = call(name);
      const args = hexToBytes(c.args);
      const out = edit(args) ?? args;
      return decodeBridgeCall({ nodeUrl: TESTNET, contractId: c.fnName === BRIDGE_FUNCTIONS.deposit ? bridge : portal, fnName: c.fnName, args: out });
    };
    const at = (bytes, seq) => bytes.findIndex((_, i) => seq.every((b, j) => bytes[i + j] === b));
    const root = (args, size) => args.length - size;

    // Too short, or extra data that isn't there.
    expect(tamper("deposit", (a) => a.subarray(0, 39))).toBeNull();
    expect(tamper("deposit", (a) => (a[36] = 5))).toBeNull();
    // The withdrawal's data pointing elsewhere, an amount that differs from
    // the one the relayed message pays, and a proof longer than the buffer.
    expect(tamper("claim-account", (a) => (a[root(a, 144) + 96] = 0x7f))).toBeNull();
    expect(tamper("claim-account", (a) => (a[root(a, 144) + 63] ^= 1))).toBeNull();
    expect(tamper("prove-account", (a) => (a[a.length - 4] = 0xff))).toBeNull();
    // The relayed call must be the bridge's: another selector is unknown.
    expect(tamper("claim-account", (a) => (a[0] ^= 0xff))).toBeNull();
    // A recipient in an unknown format is not shown as one.
    expect(tamper("claim-contract", (a) => (a[at(a, [0x20, 0x01, 0x21, 0xa5])] = 0x21))).toBeNull();
    // Untouched, they decode.
    expect(tamper("claim-contract", () => {})).not.toBeNull();
    expect(tamper("prove-account", () => {})).not.toBeNull();
  });

  it("writes EVM addresses with their EIP-55 checksum", () => {
    expect(checksumAddress(hexToBytes("3e5b8223e638cb414bef8cf95393460ca1c3a11d"))).toBe("0x3E5B8223e638CB414BEF8CF95393460cA1C3a11d");
    expect(checksumAddress(hexToBytes("efa73d0f1a0646a0222a9a2be389a4ee6ac40a26"))).toBe("0xEFa73D0F1a0646A0222A9a2BE389a4EE6AC40A26");
  });

  it("turns DuskEVM's 18 decimals into DUSK", () => {
    expect(weiToDusk(1008000000000000000000n)).toEqual({ lux: 1008000000000n, text: "" });
    expect(weiToDusk(1n)).toEqual({ lux: null, text: "0.000000000000000001" });
    expect(weiToDusk(1500000000000000001n)).toEqual({ lux: null, text: "1.500000000000000001" });
  });
});
