import { describe, expect, it } from "vitest";

import { TX_KIND } from "../../../shared/constants.js";
import { amountText, dateText, dayLabel, describeTx, inFilter, recentText, subText } from "./txRow.js";

process.env.TZ = "UTC";
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
    expect(dayLabel(at("2026-10-24T12:00:00Z"), NOW)).toBe("Sat, 24 Oct");
    expect(dayLabel(at("2025-11-16T23:03:38Z"), NOW)).toBe("Sun, 16 Nov 2025");
    expect(dateText(at("2026-10-26T14:32:59Z"))).toBe("26 Oct 2026, 14:32");
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
      "Unstake from Sozu",
      "Staking · 14:32",
      "",
      "Pending",
    ]);
    expect(read({ kind: TX_KIND.UNSTAKE, status: "unknown" })).toEqual(["stake", "Unstake", "Staking · 14:32", "", "Not confirmed"]);
  });

  it("puts each under one filter, and bridge transfers under All alone", () => {
    const kinds = [
      [{ kind: TX_KIND.TRANSFER, direction: "out" }, "sent"],
      [{ kind: TX_KIND.TRANSFER, direction: "in" }, "received"],
      [{ kind: TX_KIND.STAKE }, "staking"],
      [{ kind: TX_KIND.WITHDRAW_REWARD }, "staking"],
      [{ kind: TX_KIND.SHIELD }, "all"],
    ];
    for (const [tx, only] of kinds) {
      const d = describeTx(tx);
      expect(["all", "sent", "received", "staking"].filter((f) => inFilter(d, f))).toEqual(only === "all" ? ["all"] : ["all", only]);
    }
  });
});
