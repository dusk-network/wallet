import { networks } from "@dusk-network/networks";
import { describe, expect, it } from "vitest";

import activity from "./fixtures/activity-testnet.json";
import { calls, reservations } from "./fixtures/dusk-domains-registrations.json";
import { bytesToHex, hexToBytes } from "./bytes.js";
import { contractLabel, knownCall, nameReservationOf, registeredNameOf } from "./knownCalls.js";

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

// Recorded on Testnet: account A reserved shpongle.dusk, then registered it.
describe("a .dusk name's reservation", () => {
  const [A, B] = Object.keys(activity.accounts);
  const reservation = reservations.find((c) => c.name === "shpongle.dusk");
  const registration = calls.find((c) => c.name === "shpongle.dusk");
  const reserved = (over = {}) => nameReservationOf({ ...reservation, nodeUrl: TESTNET, args: reservation.data, ...over });
  const revealed = (over = {}) => nameReservationOf({ ...registration, nodeUrl: TESTNET, args: registration.data, account: A, ...over });

  it("matches the registration that reveals it, for the account that sent both", () => {
    expect(reserved()).toBe(reservation.data);
    expect(revealed()).toBe(reservation.data);
    // As a site sends them too.
    expect([reserved({ args: hexToBytes(reservation.data) }), revealed({ args: `0x${registration.data}` })]).toEqual([reservation.data, reservation.data]);
  });

  it("matches nothing for another account, a registration changed by a byte, or arguments that don't read", () => {
    expect(revealed({ account: B })).toBeNull();
    expect(revealed({ account: "" })).toBeNull();
    const changed = hexToBytes(registration.data);
    changed[changed.length - 304 + 73] ^= 1;
    expect(revealed({ args: bytesToHex(changed) })).toBeNull();
    expect(revealed({ args: "00ff" })).toBeNull();
    expect(reserved({ args: `${reservation.data}00` })).toBeNull();
    // Only Dusk Domains' reservations and registrations, on their own network.
    expect([reserved({ fnName: "renew" }), reserved({ contractId: "ab".repeat(32) }), reserved({ nodeUrl: "https://nodes.dusk.network" })]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("says which name a reservation was for once its registration follows, else that it's step 1 of 2", () => {
    const call = { ...reservation, nodeUrl: TESTNET };
    expect(knownCall({ ...call, reservedName: "shpongle.dusk" })).toEqual({ app: "Dusk Domains", label: "Reserved shpongle.dusk" });
    for (const reservedName of [undefined, null, ""]) {
      expect(knownCall({ ...call, reservedName }).label).toBe("Name reservation (step 1 of 2)");
    }
  });
});

describe("a contract's name", () => {
  it("is the network's name for it, or Dusk Domains for one of its contracts, as the explorer has them", () => {
    expect(contractLabel(ALICE.contractId, TESTNET)).toBe("Dusk Domains");
    expect(contractLabel(`0x${ALICE.contractId.toUpperCase()}`, TESTNET)).toBe("Dusk Domains");
    expect(contractLabel(networks.testnet.sozu.fallbacks.pool, TESTNET)).toBe("Sozu pool");
    // Another contract, or the same ID through another network's node.
    expect(contractLabel("ab".repeat(32), TESTNET)).toBeNull();
    expect(contractLabel(ALICE.contractId, "https://nodes.dusk.network")).toBeNull();
  });
});
