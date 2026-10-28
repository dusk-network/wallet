import { describe, expect, it } from "vitest";

import { calls } from "./fixtures/dusk-domains-registrations.json";
import { hexToBytes } from "./bytes.js";
import { knownCall, registeredNameOf } from "./knownCalls.js";

const TESTNET = "https://testnet.nodes.dusk.network";
const [ALICE] = calls;

describe("a .dusk name's registration", () => {
  it.each(calls.map((call) => [call.name, call]))("reads %s from its call's arguments", (name, call) => {
    const read = (args) => registeredNameOf({ ...call, nodeUrl: TESTNET, args });
    // As the archive gives them, and as a site sends them.
    expect([read(call.data), read(`0x${call.data}`), read(hexToBytes(call.data))]).toEqual([name, name, name]);
    expect(knownCall({ ...call, nodeUrl: TESTNET, registeredName: name })).toEqual({ app: "Dusk Domains", label: `Registered ${name}` });
  });

  it("reads nothing from arguments that don't read exactly, or that name another node", () => {
    const changed = (call, i, value) => {
      const args = hexToBytes(call.data);
      args[args.length + i] = value;
      return registeredNameOf({ ...call, nodeUrl: TESTNET, args });
    };
    for (const args of ["", "zz", ALICE.data.slice(2), `00${ALICE.data}`]) {
      expect(registeredNameOf({ ...ALICE, nodeUrl: TESTNET, args })).toBeNull();
    }
    // "alice" spelled "Alice", or "alicf": not the name its node was made from.
    expect(changed(ALICE, -304 + 32, 0x41)).toBeNull();
    expect(changed(ALICE, -304 + 32 + 4, 0x66)).toBeNull();
    // A length past the label's bytes.
    expect(changed(ALICE, -304 + 32 + 7, 7)).toBeNull();
  });

  it("is only Dusk Domains' register, on its own network", () => {
    const read = (over) => registeredNameOf({ ...ALICE, nodeUrl: TESTNET, args: ALICE.data, ...over });
    expect([read({ fnName: "renew" }), read({ contractId: "ab".repeat(32) }), read({ nodeUrl: "https://nodes.dusk.network" })]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    // Not read yet, or not readable: the words it had.
    for (const registeredName of [undefined, null]) {
      expect(knownCall({ ...ALICE, nodeUrl: TESTNET, registeredName }).label).toBe("Registered a .dusk name");
    }
  });
});
