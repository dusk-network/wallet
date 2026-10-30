import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { networks, routes } from "@dusk-network/networks";
import { PINNED_RELEASES as releases } from "@duskdomains/sdk/releases";

import { keptArrivals } from "../../../shared/bridgeArrival.js";
import { TX_KIND } from "../../../shared/constants.js";
import { rowOf, rowsOf } from "../../../shared/fixtures/rows.js";
import { ACTIVITY_FILTERS, amountText, dateText, dayLabel, describeTx, inFilter, recentText, subText, whenText } from "./txRow.js";

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
    const hash = (n) => n.repeat(64);
    const rows = rowsOf({
      entries: [
        { blockHeight: 7, hash: hash("a"), timestamp: 7000 },
        { blockHeight: 7, detailsAt: undefined, hash: hash("b"), success: undefined, timestamp: undefined },
        { blockHeight: 8, detailsAt: undefined, hash: hash("c"), success: undefined, timestamp: undefined },
      ],
      txs: [{ hash: hash("d"), status: "submitted", submittedAt: 4000 }],
    });
    const at = (n) => rows.find((row) => row.hash === hash(n));
    expect(["a", "b", "c", "d"].map((n) => whenText(at(n), format))).toEqual(["t7000", "t7000", "Syncing…", "t4000"]);
    // Looked up without a time, it doesn't say it's syncing.
    expect(whenText(rowsOf({ entries: [{ blockHeight: 9, timestamp: undefined }] })[0], format)).toBe("");
  });
});

describe("what a row says", () => {
  // A record of the wallet's as Activity shows it, on the node it names.
  const describeRecord = (tx, ctx = {}) => {
    const nodeUrl = tx.nodeUrl ?? ctx.nodeUrl ?? TESTNET;
    return describeTx(rowOf(tx, { nodeUrl }), { ...ctx, nodeUrl });
  };
  const read = (tx) => {
    const d = describeRecord({ status: "executed", ...tx });
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
    const pool = networks.testnet.sozu.fallbacks.pool;
    expect(read({ kind: TX_KIND.CONTRACT_CALL, contractId: pool, nodeUrl: TESTNET, fnName: "sozu_unstake", deposit: "0", amount: "0", status: "submitted" })).toEqual([
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
    const approve = describeRecord({ kind: TX_KIND.CONTRACT_CALL, status: "executed", asset: { ...token, valueUnits: "1234" } }, { contactName });
    expect([approve.lead, approve.name, approve.address, subText(approve, "14:32"), amountText(approve.amount, false)]).toEqual([
      "Approved TKN for",
      "Jan (flour)",
      spender,
      "Approval · 14:32",
      "12.34 TKN",
    ]);
    const revoke = describeRecord({ kind: TX_KIND.CONTRACT_CALL, status: "executed", asset: { ...token, valueUnits: "0" } });
    expect([revoke.lead, revoke.name, revoke.isAddress, subText(revoke, "14:32"), amountText(revoke.amount, false)]).toEqual([
      "Revoked TKN for",
      "cccccc…cccccc",
      true,
      "Revoke · 14:32",
      "0 TKN",
    ]);
    // Without a spender on record, the token and what it allows.
    expect(describeRecord({ kind: TX_KIND.CONTRACT_CALL, status: "executed", asset: { ...token, spender: undefined, valueUnits: "0" } }).name).toBe("Revoke TKN");
  });

  it("leads with a saved contact's own name, then its .dusk name, else the .dusk name", () => {
    const to = "b".repeat(40);
    const contactName = (address) => (address === to ? "Jan (flour)" : "");
    const send = { kind: TX_KIND.TRANSFER, direction: "out", to, toName: "wallet-both.dusk", amount: "500000000", status: "executed" };
    const d = describeRecord(send, { contactName });
    expect([d.name, d.alias, d.address, d.isAddress]).toEqual(["Jan (flour)", "wallet-both.dusk", to, false]);
    // A verified name does the same, and comes before the name typed; a
    // contact named as its name shows it once.
    const verified = (tx) => describeTx(rowsOf({ names: new Map([[to, "wallet-both.dusk"]]), txs: [{ hash: "ee".repeat(32), ...tx }] })[0], { contactName, nodeUrl: TESTNET });
    expect(verified({ ...send, toName: undefined }).alias).toBe("wallet-both.dusk");
    expect(verified({ ...send, toName: "typed.dusk" }).alias).toBe("wallet-both.dusk");
    expect(describeRecord(send, { contactName: () => "Wallet-Both.dusk" }).alias).toBe("");
    // Without a contact, the .dusk name leads alone.
    expect([describeRecord(send).name, describeRecord(send).alias]).toEqual(["wallet-both.dusk", ""]);
  });

  it("says what Dusk Domains and Sozu calls did", () => {
    const store = releases.testnet.contracts.find((c) => c.role === "store").contractId;
    const call = (fnName, over = {}) =>
      describeRecord({ kind: TX_KIND.CONTRACT_CALL, contractId: store, fnName, status: "executed", ...over }, { nodeUrl: TESTNET });
    const register = call("register", { deposit: "10000000000" });
    expect([register.lead, register.name, subText(register, "14:32"), amountText(register.amount, false), register.category]).toEqual([
      "Dusk Domains",
      "Registered a .dusk name",
      "Dusk Domains · 14:32",
      "−10 DUSK",
      "sent",
    ]);
    // A reservation by the name its registration revealed, once one follows; until then, step 1 of 2.
    expect(call("commit").name).toBe("Name reservation (step 1 of 2)");
    const reservation = "1f".repeat(32);
    const both = rowsOf({
      txs: [
        { contractId: store, fnName: "commit", hash: "c1".repeat(32), kind: TX_KIND.CONTRACT_CALL, reservation, status: "executed", submittedAt: 1 },
        { contractId: store, fnName: "register", hash: "c2".repeat(32), kind: TX_KIND.CONTRACT_CALL, registeredName: "alice.dusk", reservation, status: "executed", submittedAt: 2 },
      ],
    });
    expect(both.map((row) => describeTx(row, { nodeUrl: TESTNET }).name)).toEqual(["Registered alice.dusk", "Reserved alice.dusk"]);
    // A registration by its name, once read from its call.
    expect(call("register", { registeredName: "alice.dusk" }).name).toBe("Registered alice.dusk");
    // On another network's node, or a custom one, it's any contract.
    expect(call("register", { nodeUrl: "https://nodes.dusk.network" }).name).toBe("Call register");
    expect(describeRecord({ kind: TX_KIND.CONTRACT_CALL, contractId: store, fnName: "register" }, { nodeUrl: "https://node.example" }).name).toBe("Call register");
    // Sozu's: a stake or an unstake on its network's pool, not the same function on another contract.
    const pool = { kind: TX_KIND.CONTRACT_CALL, contractId: networks.testnet.sozu.fallbacks.pool, fnName: "sozu_stake", deposit: "1000000000" };
    expect(describeRecord(pool, { nodeUrl: TESTNET }).name).toBe("Staked with Sozu");
    expect(describeRecord({ ...pool, contractId: "ab".repeat(32) }, { nodeUrl: TESTNET }).name).toBe("Call sozu_stake");
    expect(describeRecord(pool, { nodeUrl: "https://node.example" }).name).toBe("Call sozu_stake");
    // A records change, whether it changes some or replaces them all.
    for (const fnName of ["mutate_records", "replace_records"]) expect(call(fnName).name).toBe("Changed a .dusk name's records");
  });

  it("names the contracts and accounts the network's file names: a call by its contract, a transfer by whom it paid", () => {
    const MAINNET = "https://nodes.dusk.network";
    const { hub } = networks.mainnet.sozu;
    const hubCall = describeRecord({ kind: TX_KIND.CONTRACT_CALL, contractId: `0x${hub.toUpperCase()}`, fnName: "contract" }, { nodeUrl: MAINNET });
    expect([hubCall.lead, hubCall.name, subText(hubCall, "14:32")]).toEqual(["Sozu hub", "Call contract", "Sozu hub · 14:32"]);
    const bsc = routes(networks.mainnet).find((route) => route.kind === "service").account;
    const paid = describeRecord({ kind: TX_KIND.TRANSFER, direction: "out", to: bsc, amount: "2000000000" }, { nodeUrl: MAINNET });
    // The bridge's account, which the payment went through, as the file names it.
    expect([paid.lead, paid.name, paid.via]).toEqual(["Bridge to BNB Smart Chain", "To BNB Smart Chain", { name: "BSC bridge", address: bsc, isAddress: false }]);
    // A contact's own name still comes first; another network's file names nothing here.
    expect(describeRecord({ kind: TX_KIND.TRANSFER, direction: "out", to: bsc }, { nodeUrl: MAINNET, contactName: () => "Bridge" }).via.name).toBe("Bridge");
    expect(describeRecord({ kind: TX_KIND.TRANSFER, direction: "out", to: bsc }, { nodeUrl: TESTNET }).isAddress).toBe(true);
    expect(describeRecord({ kind: TX_KIND.CONTRACT_CALL, contractId: hub, fnName: "contract" }, { nodeUrl: TESTNET }).lead).toBe("");
  });

  it("puts each under one filter: DUSK bridged to DuskEVM, back from it and a proof under Bridge, not Sent or Received", () => {
    const BRIDGE = "2257e5f8ff49cf7c9704a14ca35acbf48eb7ade11a079d98d5cd5655eea1b31d";
    const PORTAL = "14eeb3d4021aff09af2c515603a01f8d956a7f6411d11a1b1c0b0561a93fb1b9";
    const kinds = [
      [{ kind: TX_KIND.TRANSFER, direction: "out" }, "sent"],
      [{ kind: TX_KIND.TRANSFER, direction: "in" }, "received"],
      [{ kind: TX_KIND.STAKE }, "staking"],
      [{ kind: TX_KIND.WITHDRAW_REWARD }, "staking"],
      [{ kind: TX_KIND.SHIELD }, "all"],
      [{ kind: TX_KIND.CONTRACT_CALL, contractId: BRIDGE, fnName: "depositETHToWithValue", deposit: "500000000" }, "bridge"],
      [{ kind: TX_KIND.CONTRACT_CALL, direction: "in", contractId: PORTAL, amount: "500000000" }, "bridge"],
      [{ kind: TX_KIND.CONTRACT_CALL, contractId: PORTAL, fnName: "proveWithdrawalTransaction" }, "bridge"],
    ];
    expect(ACTIVITY_FILTERS.map((f) => f.label)).toEqual(["All", "Sent", "Received", "Staking", "Bridge"]);
    for (const [tx, only] of kinds) {
      const d = describeRecord({ nodeUrl: TESTNET, ...tx });
      expect(ACTIVITY_FILTERS.map((f) => f.id).filter((f) => inFilter(d, f))).toEqual(only === "all" ? ["all"] : ["all", only]);
    }
  });

  it("puts DUSK bridged to and from BNB Smart Chain and Ethereum under Bridge, named by their routes, not under Sent or Received", () => {
    const MAINNET = "https://nodes.dusk.network";
    const [bscOut, bscIn, ethIn] = [
      routes(networks.mainnet).find((route) => route.kind === "service").account,
      routes(networks.mainnet).find((route) => route.id === "bsc-to-dusk").payoutAccount,
      routes(networks.mainnet).find((route) => route.id === "ethereum-to-dusk").payoutAccount,
    ];
    const evm = "0xab84edffd745af9420ac74fec73121fbee9fc86f";
    const filters = (d) => ACTIVITY_FILTERS.map((f) => f.id).filter((f) => inFilter(d, f));
    // To BNB Smart Chain: the bridge's account, the address there in the memo.
    const out = describeRecord({ kind: TX_KIND.TRANSFER, direction: "out", to: bscOut, memo: evm, amount: "2000000000", status: "executed" }, { nodeUrl: MAINNET });
    expect([out.lead, out.name, subText(out, "17:22"), amountText(out.amount, false), out.recipient, out.evmChain, out.via.name, filters(out)]).toEqual([
      "Bridge to BNB Smart Chain",
      "To BNB Smart Chain",
      "Bridge · 17:22",
      "−2 DUSK",
      evm,
      "BNB Smart Chain",
      "BSC bridge",
      ["all", "bridge"],
    ]);
    // The wallet's own send, which has no direction, too; one to yourself isn't one.
    expect(describeRecord({ kind: TX_KIND.TRANSFER, to: bscOut, memo: evm, amount: "2000000000" }, { nodeUrl: MAINNET }).lead).toBe("Bridge to BNB Smart Chain");
    expect(describeRecord({ kind: TX_KIND.TRANSFER, direction: "self", to: bscOut, amount: "1" }, { nodeUrl: MAINNET }).name).toBe("To yourself");
    // From BNB Smart Chain and from Ethereum: their routes' payout accounts.
    for (const [from, chain, payer] of [
      [bscIn, "BNB Smart Chain", "BSC bridge"],
      [ethIn, "Ethereum", "Ethereum migration payouts"],
    ]) {
      const back = describeRecord({ kind: TX_KIND.TRANSFER, direction: "in", from, amount: "5000000000", status: "executed" }, { nodeUrl: MAINNET });
      expect([back.lead, back.name, subText(back, "17:19"), amountText(back.amount, false), back.via.name, filters(back)]).toEqual([
        "Bridge",
        `From ${chain}`,
        "Bridge · 17:19",
        "+5 DUSK",
        payer,
        ["all", "bridge"],
      ]);
    }
    // Testnet's route to Sepolia, by the chain it names; any other account is a send or a receipt.
    const sepolia = routes(networks.testnet).find((route) => route.kind === "service").account;
    expect(describeRecord({ kind: TX_KIND.TRANSFER, direction: "out", to: sepolia, memo: evm, amount: "1" }, { nodeUrl: TESTNET }).lead).toBe("Bridge to Sepolia");
    expect(filters(describeRecord({ kind: TX_KIND.TRANSFER, direction: "out", to: bscIn, amount: "1" }, { nodeUrl: TESTNET }))).toEqual(["all", "sent"]);
    expect(filters(describeRecord({ kind: TX_KIND.TRANSFER, direction: "in", from: bscOut, amount: "1" }, { nodeUrl: TESTNET }))).toEqual(["all", "received"]);
  });

  it("calls a shield through the transfer contract a shield, and one that failed an attempt", () => {
    const TRANSFER = "0100000000000000000000000000000000000000000000000000000000000000";
    const convert = { kind: TX_KIND.CONTRACT_CALL, direction: "out", contractId: TRANSFER, fnName: "convert", source: "archive", nodeUrl: TESTNET };
    const failed = describeRecord({ ...convert, status: "failed", feePaid: "50000000" });
    expect([failed.lead, failed.name, failed.icon, subText(failed, "19:30")]).toEqual([
      "",
      "Shield attempt (failed)",
      "shield",
      "Failed · nothing sent · fee 0.05 DUSK paid",
    ]);
    const done = describeRecord({ ...convert, status: "executed", deposit: "20000000000" });
    expect([done.name, subText(done, "19:30"), amountText(done.amount, false)]).toEqual(["Shield", "Public to shielded · 19:30", "20 DUSK"]);
    // Another contract's convert is any call.
    expect(describeRecord({ ...convert, contractId: "ab".repeat(32), status: "failed" }).name).toBe("Call convert");

    // This wallet's own shield keeps its kind: sent from here, or merged with the chain's record of it.
    const own = { hash: "f0".repeat(32), kind: TX_KIND.SHIELD, privacy: "public", amount: "20000000000", status: "submitted", submittedAt: 1, nodeUrl: TESTNET };
    expect(describeRecord({ ...own, status: "failed", feePaid: "50000000" }).name).toBe("Shield attempt (failed)");
    expect(describeRecord({ ...own, status: "executed" }).name).toBe("Shield");
    const chain = { hash: own.hash, blockHeight: 4_600_000, contractId: TRANSFER, fnName: "convert", success: false, error: "Panic", fee: "50000000" };
    const [merged] = rowsOf({ entries: [chain], txs: [own] });
    expect([merged.kind, merged.status, describeTx(merged, { nodeUrl: TESTNET }).name]).toEqual([TX_KIND.SHIELD, "failed", "Shield attempt (failed)"]);
    // An unshield that failed keeps its name.
    expect(describeRecord({ kind: TX_KIND.UNSHIELD, status: "failed" }).name).toBe("Unshield");
  });

  it("says where a deposit to DuskEVM went: To its DuskEVM address", () => {
    const BRIDGE = "2257e5f8ff49cf7c9704a14ca35acbf48eb7ade11a079d98d5cd5655eea1b31d";
    const evm = "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F";
    const deposit = { kind: TX_KIND.CONTRACT_CALL, contractId: BRIDGE, fnName: "depositETHToWithValue", deposit: "500000000", status: "executed", nodeUrl: TESTNET };
    const d = describeRecord({ ...deposit, bridgeTo: evm });
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
      const plain = describeRecord({ ...deposit, bridgeTo });
      expect([plain.lead, plain.name, plain.evm, subText(plain, "06:51")]).toEqual(["Bridge", "To DuskEVM", false, "Bridge · 06:51"]);
    }
  });

  it("says Arrived once a deposit to DuskEVM is there, with its transaction there, and nothing before", () => {
    const BRIDGE = "2257e5f8ff49cf7c9704a14ca35acbf48eb7ade11a079d98d5cd5655eea1b31d";
    const evm = "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F";
    const l2 = `0x${"29".repeat(32)}`;
    const hash = "c1".repeat(32);
    const deposit = { kind: TX_KIND.CONTRACT_CALL, contractId: BRIDGE, fnName: "depositETHToWithValue", deposit: "500000000", bridgeTo: evm, hash, status: "executed", nodeUrl: TESTNET };
    // On its way: no word, as any transaction that went through.
    expect([describeRecord(deposit).statusWord, describeRecord(deposit).arrival]).toEqual([null, null]);

    // Found there, and kept (bridgeArrival.js).
    keptArrivals().set(hash, { hash: l2, at: 1 });
    try {
      const there = describeRecord(deposit);
      expect([there.statusWord, there.tone, there.arrival, subText(there, "06:51")]).toEqual(["Arrived", "ok", l2, "Bridge to DuskEVM · 06:51"]);
      // Only a deposit that went through to a DuskEVM address arrives.
      expect(describeRecord({ ...deposit, bridgeTo: undefined }).arrival).toBeNull();
      expect(describeRecord({ ...deposit, status: "failed" }).statusWord).toBe("Failed");
    } finally {
      keptArrivals().delete(hash);
    }
  });
});
