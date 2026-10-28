import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TX_KIND } from "../shared/constants.js";
import { installFakeDom, visibleText } from "./testing/fakeDom.js";
import { txDetailsView } from "./popup/views/txDetails.js";

const HASH = "ab".repeat(32);
const NODE = "https://testnet.nodes.dusk.network";

let dom;

beforeEach(() => {
  dom = installFakeDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Renders a transaction's details as the popup does.
function details(tx) {
  const state = { route: "tx", txDetailHash: HASH, txDetailFrom: "home" };
  const actions = { render: vi.fn(async () => {}), showToast: vi.fn() };
  const ov = { nodeUrl: NODE, txs: [{ hash: HASH, nodeUrl: NODE, ...tx }] };
  dom.document.body.replaceChildren(...txDetailsView(ov, { state, actions }));
  const body = dom.document.body;
  return {
    name: visibleText(body.querySelector(".tx-hero-name")),
    lead: body.querySelector(".tx-hero-lead"),
    status: visibleText(body.querySelector(".tx-hero-status")),
    note: body.querySelector(".tx-hero-note") ? visibleText(body.querySelector(".tx-hero-note")) : "",
    rows: body.querySelectorAll(".tx-detail > .group > .kv").map(visibleText),
    body,
  };
}

describe("transaction details", () => {
  it("names the type once, and adds a note only where the status needs one", () => {
    const shield = { kind: TX_KIND.SHIELD, amount: "1000000000", profileIndex: 0 };
    let view = details({ ...shield, status: "mempool" });
    expect([view.name, view.lead, view.status, view.note]).toEqual([
      "Shield",
      null,
      "Pending",
      "Still waiting to go through. Don't retry yet.",
    ]);
    // Where it moved, from the profile's public balance to its shielded one.
    expect(view.rows.slice(0, 2)).toEqual(["FromProfile 1 · Public", "ToProfile 1 · Shielded"]);

    view = details({ ...shield, status: "unknown" });
    expect([view.status, view.note]).toEqual(["Not confirmed", "The wallet stopped waiting for a result. That doesn't mean it failed."]);
    view = details({ ...shield, status: "removed", privacy: "shielded" });
    expect([view.status, view.note]).toEqual([
      "Dropped",
      "The network dropped it before it ran, so no fee was charged. The 1 DUSK stayed in your wallet. Shielded funds may still be reserved locally.",
    ]);
    view = details({ ...shield, status: "submitted" });
    expect([view.status, view.note]).toEqual(["Pending", "Waiting for a block, usually about 10 seconds."]);
    // Completed says it all.
    view = details({ ...shield, status: "executed" });
    expect([view.status, view.note]).toEqual(["Completed", ""]);
  });

  it("offers a contract's token or NFT with the buttons alone, and names the contract", () => {
    const contractId = "cd".repeat(32);
    const view = details({
      kind: TX_KIND.CONTRACT_CALL,
      contractId: `0x${contractId}`,
      fnName: "transfer",
      status: "executed",
    });
    expect(view.name).toBe("Call transfer");
    expect(visibleText(view.body.querySelector(".tx-hero-addr"))).toBe("0xcdcd…cdcdcd");
    expect(view.body.querySelector(".tx-hero-addr button").getAttribute("aria-label")).toBe("Copy contract ID");
    expect(visibleText(view.body.querySelector(".tx-assets"))).toBe("Add tokenImport NFT");
    // Not for the network's own transfer contract.
    const convert = details({ kind: TX_KIND.CONTRACT_CALL, contractId: `01${"00".repeat(31)}`, fnName: "convert", status: "failed" });
    expect(convert.body.querySelector(".tx-assets")).toBeNull();
  });

  it("says when a transaction isn't in Activity, and still opens it in the explorer", () => {
    const state = { route: "tx", txDetailHash: "ef".repeat(32), txDetailFrom: "home" };
    dom.document.body.replaceChildren(...txDetailsView({ nodeUrl: NODE, txs: [] }, { state, actions: {} }));
    expect(visibleText(dom.document.body)).toBe(
      "← BackTransactionThis transaction isn't in your activity.Transaction IDefefef…efefefView in Dusk explorer"
    );
  });
});
