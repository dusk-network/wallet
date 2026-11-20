import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TX_KIND } from "../../../shared/constants.js";
import { rowOf } from "../../../shared/fixtures/rows.js";
import { amountText, describeTx, subText } from "./txRow.js";

// Amounts follow the browser's language: British English.
beforeAll(() => vi.stubGlobal("navigator", { language: "en-GB" }));
afterAll(() => vi.unstubAllGlobals());
const TESTNET = "https://testnet.nodes.dusk.network";

describe("what a row says", () => {
  // A record of the wallet's as Activity shows it, on the node it names.
  const describeRecord = (tx, ctx = {}) => {
    const nodeUrl = tx.nodeUrl ?? ctx.nodeUrl ?? TESTNET;
    return describeTx(rowOf(tx, { nodeUrl }), { ...ctx, nodeUrl });
  };
  // What a row says it did, before its name and in the line under it: a grant approves and never revokes, a revoke
  // the other way round.
  const says = (d, word, not) => {
    for (const said of [d.lead, subText(d, "14:32")]) {
      expect(said).toMatch(word);
      expect(said).not.toMatch(not);
    }
  };

  it("names whom a token approval lets spend, and shows an allowance of 0 as a revoke", () => {
    const spender = "c".repeat(40);
    const contactName = (address) => (address === spender ? "Jan (flour)" : "");
    const token = { type: "DRC20", symbol: "TKN", decimals: 2, op: "approve", spender };
    const approve = describeRecord({ kind: TX_KIND.CONTRACT_CALL, status: "executed", asset: { ...token, valueUnits: "1234" } }, { contactName });
    // Whom it lets spend, as the contact it is, by the spender's whole address; and how much of which token.
    expect([approve.name, approve.address, amountText(approve.amount, false)]).toEqual(["Jan (flour)", spender, "12.34 TKN"]);
    says(approve, /approv/i, /revok/i);
    const revoke = describeRecord({ kind: TX_KIND.CONTRACT_CALL, status: "executed", asset: { ...token, valueUnits: "0" } });
    expect([revoke.name, revoke.address, revoke.isAddress, amountText(revoke.amount, false)]).toEqual(["cccccc…cccccc", spender, true, "0 TKN"]);
    says(revoke, /revok/i, /approv/i);
    // Without a spender on record, the token and what it allows.
    const unnamed = describeRecord({ kind: TX_KIND.CONTRACT_CALL, status: "executed", asset: { ...token, spender: undefined, valueUnits: "0" } });
    expect(unnamed.name).toMatch(/revok/i);
    expect(unnamed.name).not.toMatch(/approv/i);
    expect(unnamed.name).toContain("TKN");
  });
});
