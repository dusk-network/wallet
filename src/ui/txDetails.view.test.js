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
  const boxes = dom.document.body.querySelectorAll(".box");
  return {
    chips: dom.document.body.querySelectorAll(".tx-chips > div").map((pill) => pill.textContent),
    type: dom.document.body.querySelector(".tx-summary .muted").textContent,
    // The plain box under the pills, for the statuses that need a word.
    note: boxes.find((box) => box.className === "box" && !box.querySelector("button"))?.textContent ?? "",
    boxes,
  };
}

describe("transaction details", () => {
  it("names the type once, in the summary, and adds a note only where the status needs one", () => {
    const shield = { kind: TX_KIND.SHIELD, amount: "1000000000" };
    let view = details({ ...shield, status: "mempool" });
    expect(view.chips).toEqual(["Status: In mempool", "Network: Testnet"]);
    expect(view.type).toBe("Shield");
    expect(view.note).toBe("Still waiting to go through. Don't retry yet.");

    expect(details({ ...shield, status: "unknown" }).note).toBe(
      "The wallet stopped waiting for a result. That doesn't mean it failed."
    );
    expect(details({ ...shield, status: "removed" }).note).toBe("Shielded funds may still be reserved locally.");
    // Pending and Executed say it all.
    expect(details({ ...shield, status: "submitted" }).note).toBe("");
    expect(details({ ...shield, status: "executed" }).note).toBe("");
  });

  it("offers a contract's token or NFT with the buttons alone", () => {
    const view = details({
      kind: TX_KIND.CONTRACT_CALL,
      contractId: `0x${"cd".repeat(32)}`,
      fnName: "transfer",
      status: "executed",
    });
    const assets = view.boxes.find((box) => box.querySelector("button"));
    expect(visibleText(assets)).toBe("AssetsAdd tokenImport NFT");
  });
});
