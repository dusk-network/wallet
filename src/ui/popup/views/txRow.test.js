import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { networks, routes } from "@dusk-network/networks";

import { TX_KIND } from "../../../shared/constants.js";
import releases from "../../../shared/dusk-domains-releases.json";
import { amountText, blockTimes, dateText, dayLabel, describeTx, inFilter, recentText, subText, whenText } from "./txRow.js";

process.env.TZ = "UTC";
// Times follow the browser's language: British English, with its 24-hour clock.
beforeAll(() => vi.stubGlobal("navigator", { language: "en-GB" }));
afterAll(() => vi.unstubAllGlobals());
const TESTNET = "https://testnet.nodes.dusk.network";
const NOW = Date.parse("2026-10-26T15:00:00Z");
const at = (iso) => Date.parse(iso);

describe("when a row says it happened", () => {
  it("says how long ago on Home, then the time, Yesterday, or the date", () => {
    expect(recentText(NOW - 20_000, NOW)).toBe("Just now");
    expect(recentText(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(recentText(at("2026-10-26T09:05:00Z"), NOW)).toBe("09:05");
    expect(recentText(at("2026-10-25T23:59:00Z"), NOW)).toBe("Yesterday");
    expect(recentText(at("2026-10-24T08:00:00Z"), NOW)).toBe("24 Oct");
    expect(recentText(at("2025-12-14T08:00:00Z"), NOW)).toBe("14 Dec 2025");
  });

  it("titles the Activity view's day groups, and dates the details", () => {
    expect(dayLabel(at("2026-10-26T00:00:00Z"), NOW)).toBe("Today");
    expect(dayLabel(at("2026-10-25T12:00:00Z"), NOW)).toBe("Yesterday");
    expect(dayLabel(at("2026-10-24T12:00:00Z"), NOW)).toBe("Sat 24 Oct");
    expect(dayLabel(at("2025-11-16T23:03:38Z"), NOW)).toBe("Sun 16 Nov 2025");
    // In full, with the time zone it shows in.
    expect(dateText(at("2026-10-26T14:32:59Z"))).toBe("Mon 26 Oct 2026, 14:32 UTC");
  });

  it("names the time zone by its short name, else by its offset", () => {
    // TZ is read when a date is formatted, so each zone's own name shows.
    const cases = [
      ["Europe/Amsterdam", "2026-10-26T12:22:00Z", "Mon 26 Oct 2026, 13:22 CET"],
      ["Europe/Amsterdam", "2026-07-01T12:22:00Z", "Wed 1 Jul 2026, 14:22 CEST"],
      ["America/New_York", "2026-10-26T12:22:00Z", "Mon 26 Oct 2026, 08:22 EDT"],
      ["Asia/Kolkata", "2026-10-26T12:22:00Z", "Mon 26 Oct 2026, 17:52 GMT+5:30"],
    ];
    try {
      for (const [zone, iso, text] of cases) {
        process.env.TZ = zone;
        expect(dateText(at(iso)), zone).toBe(text);
      }
    } finally {
      process.env.TZ = "UTC";
    }
  });
});

describe("a row's time", () => {
  const format = (ms) => `t${ms}`;
  it("is its own, else its block's from another row, else Syncing… for a synced row not looked up yet", () => {
    const rows = [
      { hash: "a", source: "archive", blockHeight: 7, timestamp: 7000, detailsAt: 1 },
      { hash: "b", source: "archive", blockHeight: 7 },
      { hash: "c", source: "archive", blockHeight: 8 },
      { hash: "d", status: "submitted" },
    ];
    const times = blockTimes(rows);
    expect(times).toEqual(new Map([[7, 7000]]));
    expect(rows.map((tx) => whenText(tx, { times, format }))).toEqual(["t7000", "t7000", "Syncing…", ""]);
    // Looked up without a time, it doesn't say it's syncing.
    expect(whenText({ source: "archive", blockHeight: 9, detailsAt: 1 }, { times, format })).toBe("");
  });
});

describe("what a row says", () => {
  const read = (tx) => {
    const d = describeTx({ status: "executed", ...tx });
    return [d.icon, d.name, subText(d, "14:32"), amountText(d.amount, false), d.statusWord];
  };

  it("names tokens, approvals, NFTs and calls by what they did", () => {
    const token = { type: "DRC20", symbol: "TKN", decimals: 2 };
    expect(read({ kind: TX_KIND.CONTRACT_CALL, asset: { ...token, op: "transfer", valueUnits: "12345", to: "a".repeat(40) } })).toEqual([
      "out",
      "aaaaaa…aaaaaa",
      "Sent · 14:32",
      "−123.45 TKN",
      null,
    ]);
    expect(read({ kind: TX_KIND.CONTRACT_CALL, asset: { ...token, op: "approve", isMax: true } })).toEqual([
      "call",
      "Approve TKN",
      "Approval · 14:32",
      "Unlimited TKN",
      null,
    ]);
    expect(read({ kind: TX_KIND.CONTRACT_CALL, asset: { type: "DRC721", symbol: "ART", tokenId: 7, op: "transfer" } })).toEqual([
      "call",
      "ART #7",
      "NFT · 14:32",
      "",
      null,
    ]);
    // Liquid staking's unstake: the DUSK comes back once the chain says so.
    expect(read({ kind: TX_KIND.CONTRACT_CALL, fnName: "sozu_unstake", deposit: "0", amount: "0", status: "submitted" })).toEqual([
      "stake",
      "Unstaked from Sozu",
      "Staking · 14:32",
      "",
      "Pending",
    ]);
    expect(read({ kind: TX_KIND.UNSTAKE, status: "unknown" })).toEqual(["stake", "Unstake", "Staking · 14:32", "", "Not confirmed"]);
  });

  it("names whom a token approval lets spend, and shows an allowance of 0 as a revoke", () => {
    const spender = "c".repeat(40);
    const contactName = (address) => (address === spender ? "Jan (flour)" : "");
    const token = { type: "DRC20", symbol: "TKN", decimals: 2, op: "approve", spender };
    const approve = describeTx({ kind: TX_KIND.CONTRACT_CALL, status: "executed", asset: { ...token, valueUnits: "1234" } }, { contactName });
    expect([approve.lead, approve.name, approve.address, subText(approve, "14:32"), amountText(approve.amount, false)]).toEqual([
      "Approved TKN for",
      "Jan (flour)",
      spender,
      "Approval · 14:32",
      "12.34 TKN",
    ]);
    const revoke = describeTx({ kind: TX_KIND.CONTRACT_CALL, status: "executed", asset: { ...token, valueUnits: "0" } });
    expect([revoke.lead, revoke.name, revoke.isAddress, subText(revoke, "14:32"), amountText(revoke.amount, false)]).toEqual([
      "Revoked TKN for",
      "cccccc…cccccc",
      true,
      "Revoke · 14:32",
      "0 TKN",
    ]);
    // Without a spender on record, the token and what it allows.
    expect(describeTx({ kind: TX_KIND.CONTRACT_CALL, status: "executed", asset: { ...token, spender: undefined, valueUnits: "0" } }).name).toBe("Revoke TKN");
  });

  it("leads with a saved contact's own name, then its .dusk name, else the .dusk name", () => {
    const to = "b".repeat(40);
    const contactName = (address) => (address === to ? "Jan (flour)" : "");
    const send = { kind: TX_KIND.TRANSFER, direction: "out", to, toName: "wallet-both.dusk", amount: "500000000", status: "executed" };
    const d = describeTx(send, { contactName });
    expect([d.name, d.alias, d.address, d.isAddress]).toEqual(["Jan (flour)", "wallet-both.dusk", to, false]);
    // A verified name does the same; a contact named as its name shows it once.
    expect(describeTx({ ...send, toName: undefined, counterpartyName: "wallet-both.dusk" }, { contactName }).alias).toBe("wallet-both.dusk");
    expect(describeTx(send, { contactName: () => "Wallet-Both.dusk" }).alias).toBe("");
    // Without a contact, the .dusk name leads alone.
    expect([describeTx(send).name, describeTx(send).alias]).toEqual(["wallet-both.dusk", ""]);
  });

  it("says what Dusk Domains and Sozu calls did", () => {
    const store = releases.testnet.contracts.find((c) => c.role === "store").contractId;
    const call = (fnName, over = {}) =>
      describeTx({ kind: TX_KIND.CONTRACT_CALL, contractId: store, fnName, status: "executed", ...over }, { nodeUrl: TESTNET });
    const register = call("register", { deposit: "10000000000" });
    expect([register.lead, register.name, subText(register, "14:32"), amountText(register.amount, false), register.category]).toEqual([
      "Dusk Domains",
      "Registered a .dusk name",
      "Dusk Domains · 14:32",
      "−10 DUSK",
      "sent",
    ]);
    expect(call("commit").name).toBe("Reserved a .dusk name");
    // A registration by its name, once read from its call.
    expect(call("register", { registeredName: "alice.dusk" }).name).toBe("Registered alice.dusk");
    // On another network's node, or a custom one, it's any contract.
    expect(call("register", { nodeUrl: "https://nodes.dusk.network" }).name).toBe("Call register");
    expect(describeTx({ kind: TX_KIND.CONTRACT_CALL, contractId: store, fnName: "register" }, { nodeUrl: "https://node.example" }).name).toBe("Call register");
    expect(describeTx({ kind: TX_KIND.CONTRACT_CALL, fnName: "sozu_stake", deposit: "1000000000" }).name).toBe("Staked with Sozu");
  });

  it("names the contracts and accounts the network's file names: a call by its contract, a transfer by whom it paid", () => {
    const MAINNET = "https://nodes.dusk.network";
    const { hub } = networks.mainnet.sozu;
    const hubCall = describeTx({ kind: TX_KIND.CONTRACT_CALL, contractId: `0x${hub.toUpperCase()}`, fnName: "contract" }, { nodeUrl: MAINNET });
    expect([hubCall.lead, hubCall.name]).toEqual(["Sozu hub", "Call contract"]);
    const bsc = routes(networks.mainnet).find((route) => route.kind === "service").account;
    const paid = describeTx({ kind: TX_KIND.TRANSFER, direction: "out", to: bsc, amount: "2000000000" }, { nodeUrl: MAINNET });
    expect([paid.lead, paid.name, paid.address, paid.isAddress]).toEqual(["Sent to", "BSC bridge", bsc, false]);
    // A contact's own name still comes first; another network's file names nothing here.
    expect(describeTx({ kind: TX_KIND.TRANSFER, direction: "out", to: bsc }, { nodeUrl: MAINNET, contactName: () => "Bridge" }).name).toBe("Bridge");
    expect(describeTx({ kind: TX_KIND.TRANSFER, direction: "out", to: bsc }, { nodeUrl: TESTNET }).isAddress).toBe(true);
    expect(describeTx({ kind: TX_KIND.CONTRACT_CALL, contractId: hub, fnName: "contract" }, { nodeUrl: TESTNET }).lead).toBe("");
  });

  it("puts each under one filter: DUSK bridged to DuskEVM under Sent, back from it under Received, a proof under All", () => {
    const BRIDGE = "2257e5f8ff49cf7c9704a14ca35acbf48eb7ade11a079d98d5cd5655eea1b31d";
    const PORTAL = "14eeb3d4021aff09af2c515603a01f8d956a7f6411d11a1b1c0b0561a93fb1b9";
    const kinds = [
      [{ kind: TX_KIND.TRANSFER, direction: "out" }, "sent"],
      [{ kind: TX_KIND.TRANSFER, direction: "in" }, "received"],
      [{ kind: TX_KIND.STAKE }, "staking"],
      [{ kind: TX_KIND.WITHDRAW_REWARD }, "staking"],
      [{ kind: TX_KIND.SHIELD }, "all"],
      [{ kind: TX_KIND.CONTRACT_CALL, contractId: BRIDGE, fnName: "depositETHToWithValue", deposit: "500000000" }, "sent"],
      [{ kind: TX_KIND.CONTRACT_CALL, direction: "in", contractId: PORTAL, amount: "500000000" }, "received"],
      [{ kind: TX_KIND.CONTRACT_CALL, contractId: PORTAL, fnName: "proveWithdrawalTransaction" }, "all"],
    ];
    for (const [tx, only] of kinds) {
      const d = describeTx({ nodeUrl: TESTNET, ...tx });
      expect(["all", "sent", "received", "staking"].filter((f) => inFilter(d, f))).toEqual(only === "all" ? ["all"] : ["all", only]);
    }
  });

  it("says where a deposit to DuskEVM went: To its DuskEVM address", () => {
    const BRIDGE = "2257e5f8ff49cf7c9704a14ca35acbf48eb7ade11a079d98d5cd5655eea1b31d";
    const evm = "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F";
    const deposit = { kind: TX_KIND.CONTRACT_CALL, contractId: BRIDGE, fnName: "depositETHToWithValue", deposit: "500000000", status: "executed", nodeUrl: TESTNET };
    const d = describeTx({ ...deposit, bridgeTo: evm });
    expect([d.lead, d.name, d.address, d.evm, d.isAddress, subText(d, "06:51"), amountText(d.amount, false)]).toEqual([
      "Bridge to DuskEVM",
      "To 0xAB84…C86F",
      evm,
      true,
      false,
      "Bridge to DuskEVM · 06:51",
      "−0.5 DUSK",
    ]);
    // Not read yet, or read as none: To DuskEVM.
    for (const bridgeTo of [undefined, null, "0x12"]) {
      const plain = describeTx({ ...deposit, bridgeTo });
      expect([plain.lead, plain.name, plain.evm, subText(plain, "06:51")]).toEqual(["Bridge", "To DuskEVM", false, "Bridge · 06:51"]);
    }
  });
});
