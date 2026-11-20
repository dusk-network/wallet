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

  it("names whom a token approval lets spend, and shows an allowance of 0 as a revoke", () => {
    const spender = "c".repeat(40);
    const contactName = (address) => (address === spender ? "Jan (flour)" : "");
    const token = { type: "DRC20", symbol: "TKN", decimals: 2, op: "approve", spender };
    // A grant, to the contact it is, by the spender's whole address; how much of which token.
    const approve = describeRecord({ kind: TX_KIND.CONTRACT_CALL, status: "executed", asset: { ...token, valueUnits: "1234" } }, { contactName });
    expect([approve.lead, approve.name, approve.address, subText(approve, "14:32"), amountText(approve.amount, false)]).toEqual([
      "Approved TKN for",
      "Jan (flour)",
      spender,
      "Approval · 14:32",
      "12.34 TKN",
    ]);
    // An allowance of 0 takes it back: a revoke, never a grant.
    const revoke = describeRecord({ kind: TX_KIND.CONTRACT_CALL, status: "executed", asset: { ...token, valueUnits: "0" } });
    expect([revoke.lead, revoke.name, revoke.address, revoke.isAddress, subText(revoke, "14:32"), amountText(revoke.amount, false)]).toEqual([
      "Revoked TKN for",
      "cccccc…cccccc",
      spender,
      true,
      "Revoke · 14:32",
      "0 TKN",
    ]);
    for (const said of [revoke.lead, subText(revoke, "14:32")]) expect(said).not.toMatch(/approv/i);
    // Without a spender on record, the token and what it allows.
    expect(describeRecord({ kind: TX_KIND.CONTRACT_CALL, status: "executed", asset: { ...token, spender: undefined, valueUnits: "0" } }).name).toBe("Revoke TKN");
  });
});
