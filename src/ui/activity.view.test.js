import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import fixture from "../shared/fixtures/activity-testnet.json";
import { activityEntry, parseHistoryEntry } from "../shared/activityHistory.js";
import { installFakeDom, visibleText } from "./testing/fakeDom.js";
import { homeView } from "./popup/views/home.js";
import { txDetailsView } from "./popup/views/txDetails.js";
import { activityKey } from "./popup/activity.js";

// The token and NFT cards load on their own.
vi.mock("./popup/views/assets.js", () => ({ assetsSectionsView: () => [] }));
// A details view asks for a synced entry's details through this.
const detail = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./popup/activity.js", async (importOriginal) => ({
  ...(await importOriginal()),
  loadActivityDetail: detail.load,
}));

const [A] = Object.keys(fixture.accounts);
const NODE = fixture.nodeUrl;

// A's synced history, as the popup keeps it (ui/popup/activity.js).
function history() {
  const raw = [...fixture.accounts[A].sender, ...fixture.accounts[A].receiver];
  const seen = new Map();
  for (const e of raw) {
    const parsed = parseHistoryEntry(A, e);
    const tx = fixture.details[parsed.hash];
    seen.set(
      parsed.hash,
      activityEntry({
        ...parsed,
        value: parsed.value.toString(),
        timestamp: tx.blockTimestamp * 1000,
        success: !tx.err,
        fee: String(tx.gasSpent * tx.tx.gasPrice),
        fnName: tx.tx.callData?.fnName,
        contractId: tx.tx.callData?.contractId,
        detailsAt: 1,
      })
    );
  }
  return [...seen.values()].sort((a, b) => b.blockHeight - a.blockHeight);
}

const FAUCET = fixture.accounts[A].receiver[0].events[0].data.sender;
const SENDER = fixture.accounts[A].receiver[1].events[0].data.sender;

let dom;
beforeEach(() => {
  dom = installFakeDom();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function setup({ local = [], names = new Map(), complete = true, route = "home" } = {}) {
  const ov = { isUnlocked: true, nodeUrl: NODE, accounts: [A], selectedAccountIndex: 0, txs: local };
  const state = {
    route,
    addressBook: { loaded: true, items: [] },
    activity: { key: activityKey(ov), account: A, nodeUrl: NODE, entries: history(), names, loaded: true, complete, limit: 50 },
  };
  const actions = { render: vi.fn(async () => {}), showToast: vi.fn(), send: vi.fn() };
  return { ov, state, actions };
}

const rows = () =>
  dom.document.body.querySelectorAll(".activity-tx-item").map((row) => ({
    title: row.querySelector(".activity-title span").textContent,
    amount: row.querySelector(".activity-amount").textContent,
  }));

describe("Recent activity with the account's history", () => {
  it("shows transfers received, named by their verified .dusk name where one is known", () => {
    const { ov, state, actions } = setup({ names: new Map([[FAUCET, "faucet.dusk"], [SENDER, null]]) });
    dom.document.body.replaceChildren(...homeView(ov, { state, actions }));
    expect(rows()).toEqual([
      { title: "Call register", amount: "-100 DUSK" },
      { title: "Call commit", amount: "—" },
      { title: `Received from ${SENDER.slice(0, 10)}…${SENDER.slice(-8)}`, amount: "+1000 DUSK" },
      { title: "Received from faucet.dusk", amount: "+1100 DUSK" },
    ]);
  });

  it("shows the wallet's pending send first, and names its recipient as typed", () => {
    const pending = {
      hash: "aa".repeat(32),
      kind: "transfer",
      privacy: "public",
      to: FAUCET,
      toName: "faucet.dusk",
      amount: "5000000000",
      status: "submitted",
      submittedAt: Date.now(),
      profileIndex: 0,
    };
    const { ov, state, actions } = setup({ local: [pending] });
    dom.document.body.replaceChildren(...homeView(ov, { state, actions }));
    expect(rows()[0]).toEqual({ title: "Sent to faucet.dusk", amount: "-5 DUSK" });
    expect(dom.document.body.querySelector(".activity-tx-item .activity-status").textContent).toBe("Pending");
  });

  it("offers Show more in the History view while older history is still to come", () => {
    const { ov, state, actions } = setup({ complete: false, route: "activity" });
    dom.document.body.replaceChildren(...homeView(ov, { state, actions }));
    expect(dom.document.body.querySelector(".activity-view-all").textContent).toBe("Show more");
    state.activity.complete = true;
    dom.document.body.replaceChildren(...homeView(ov, { state, actions }));
    expect(dom.document.body.querySelector(".activity-view-all")).toBeNull();
  });
});

describe("the details of a send the archive has without its outcome", () => {
  it("looks its outcome up, as final with its outcome unknown meanwhile", () => {
    const { ov, state, actions } = setup();
    const register = state.activity.entries.find((e) => e.fnName === "register");
    Object.assign(register, { success: null, detailsAt: undefined });
    ov.txs = [{ hash: register.hash, kind: "contract_call", status: "submitted", profileIndex: 0, submittedAt: Date.now() }];
    Object.assign(state, { route: "tx", txDetailHash: register.hash, txDetailFrom: "home" });
    detail.load.mockClear();
    dom.document.body.replaceChildren(...txDetailsView(ov, { state, actions }));
    expect(detail.load).toHaveBeenCalledWith(expect.objectContaining({ state }), register.hash);
    // In a finalized block: not pending, whatever the wallet's watcher last saw.
    expect(visibleText(dom.document.body)).toContain("Status: Unknown");
    expect(visibleText(dom.document.body)).toContain("It is final on chain. Its outcome is still being looked up.");
  });
});

describe("a received transaction's details", () => {
  it("names its sender, with the sender's verified name", () => {
    const { ov, state, actions } = setup({ names: new Map([[FAUCET, "faucet.dusk"]]) });
    const received = state.activity.entries.find((e) => e.counterparty === FAUCET);
    Object.assign(state, { route: "tx", txDetailHash: received.hash, txDetailFrom: "home" });
    dom.document.body.replaceChildren(...txDetailsView(ov, { state, actions }));
    const text = visibleText(dom.document.body);
    expect(dom.document.body.querySelector(".tx-summary").textContent).toBe("Public transfer1100 DUSKFrom: faucet.dusk");
    expect(text).toContain(`Fromfaucet.dusk · ${FAUCET}`);
    expect(text).toContain("Status: Executed");
  });
});
