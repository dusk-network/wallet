import { describe, expect, it } from "vitest";

import { BRIDGE_CONTRACTS } from "./bridge.js";
import { BRIDGE_FUNCTIONS, bridgeEnvelopeOk, callsBridge, checksumAddress, decodeBridgeCall, evmAddressOf, weiToDusk } from "./bridgeCalls.js";
import { hexToBytes } from "./bytes.js";
import fixtures from "./fixtures/duskevm-bridge-calls.json";

// Calls made with the bridge's own deposit encoder and its pinned
// OptimismPortal data driver; `expected` is what the bridge's decoders read
// from them. "deposit-shoot" is byte for byte what the bridge sent the wallet
// on testnet (40 bytes · sha256=2f64b19f5ac0…731c7c2a). The withdrawals take
// DuskEVM testnet's route (`fixtures.route`), as its MessagePassed logs name it.
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

  it("decodes a withdrawal only on the bridge's route: messenger to messenger, relaying bridge to bridge", () => {
    const { route } = fixtures;
    // Dusk's bridge as DuskEVM names it: its contract ID's EVM address.
    expect(`0x${evmAddressOf(bridge)}`).toBe(route.l1Bridge.toLowerCase());
    const find = (bytes, seq) => bytes.findIndex((_, i) => seq.every((b, j) => bytes[i + j] === b));
    for (const name of ["claim-account", "prove-account", "claim-external-contract"]) {
      const c = call(name);
      expect(decode(name), name).not.toBeNull();
      // The withdrawal's sender and target, and the relayed call's sender and target.
      for (const [part, address] of Object.entries(route)) {
        const args = hexToBytes(c.args);
        const at = find(args, Array.from(hexToBytes(address.slice(2).toLowerCase())));
        expect(at, `${name}: ${part}`).toBeGreaterThan(-1);
        args[at + 19] ^= 1;
        expect(decode(name, { args }), `${name} with another ${part}`).toBeNull();
      }
    }
  });

  it("tells a call to the bridge's contracts on its network, read or not", () => {
    expect(callsBridge({ nodeUrl: TESTNET, contractId: portal })).toBe(true);
    expect(callsBridge({ nodeUrl: TESTNET, contractId: `0x${bridge.toUpperCase()}` })).toBe(true);
    expect(callsBridge({ nodeUrl: TESTNET, contractId: "ab".repeat(32) })).toBe(false);
    expect(callsBridge({ nodeUrl: "https://nodes.dusk.network", contractId: portal })).toBe(false);
    expect(callsBridge({ nodeUrl: TESTNET })).toBe(false);
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

describe("bridgeEnvelopeOk", () => {
  const deposit = { kind: "deposit", amountLux: 100_000_000n };
  const prove = { kind: "prove", amountWei: 10n ** 18n };
  const own = ["own-account", "own-address"];

  it("takes a deposit that moves its bridged amount as the deposit, and nothing else", () => {
    expect(bridgeEnvelopeOk(deposit, { amount: "0", deposit: "100000000" })).toBe(true);
    expect(bridgeEnvelopeOk(deposit, { deposit: 100_000_000n, to: "own-account", own })).toBe(true);
    expect(bridgeEnvelopeOk(deposit, { amount: "1", deposit: "100000000" })).toBe(false);
    expect(bridgeEnvelopeOk(deposit, { deposit: "200000000" })).toBe(false);
    expect(bridgeEnvelopeOk(deposit, { deposit: "100000000", to: "someone", own })).toBe(false);
    expect(bridgeEnvelopeOk(deposit, { deposit: "not a number" })).toBe(false);
  });

  it("takes a proof or a claim that moves nothing", () => {
    expect(bridgeEnvelopeOk(prove, {})).toBe(true);
    expect(bridgeEnvelopeOk({ ...prove, kind: "claim" }, { amount: "0", deposit: "0", to: "own-address", own })).toBe(true);
    expect(bridgeEnvelopeOk(prove, { deposit: "1" })).toBe(false);
    expect(bridgeEnvelopeOk(prove, { amount: "1" })).toBe(false);
    expect(bridgeEnvelopeOk(prove, { to: "someone" })).toBe(false);
  });
});
