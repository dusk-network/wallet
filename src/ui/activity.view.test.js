import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import fixture from "../shared/fixtures/activity-testnet.json";
import { historyEntry, parseHistoryEntry } from "@dusk-network/app-core/history";
import { TX_KIND } from "../shared/constants.js";
import { installFakeDom, visibleText } from "./testing/fakeDom.js";
import { homeView } from "./popup/views/home.js";
import { txDetailsView } from "./popup/views/txDetails.js";
import { txStatusWord } from "./popup/views/txDisplay.js";
import { AFTER_ALL_TEXT } from "./popup/views/txRow.js";
import { activityKey } from "./popup/activity.js";

// The token and NFT cards load on their own.
vi.mock("./popup/views/assets.js", () => ({ assetsSectionsView: () => [] }));
// A details view asks for a synced entry's details through this.
const detail = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./popup/activity.js", async (importOriginal) => ({
  ...(await importOriginal()),
  loadActivityDetail: detail.load,
}));
// The profile's verified name, as the header shows it.
vi.mock("../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: vi.fn(async () => "alice.dusk"),
  // The .dusk names of an Activity's counterparties, as the node checks them: none.
  lookupRecipientNames: vi.fn(async () => new Map()),
}));

// Times as a popup in UTC shows them, the day after the fixture's transactions.
process.env.TZ = "UTC";
const NOW = new Date("2026-10-23T09:00:00Z");

const [A] = Object.keys(fixture.accounts);
const NODE = fixture.nodeUrl;
const FAUCET = fixture.accounts[A].receiver[0].events[0].data.sender;

// An account's synced history, as the popup keeps it (ui/popup/activity.js).
function history(account) {
  const raw = [...fixture.accounts[account].sender, ...fixture.accounts[account].receiver];
  const seen = new Map();
  for (const e of raw) {
    const parsed = parseHistoryEntry(account, e);
    const tx = fixture.details[parsed.hash];
    seen.set(
      parsed.hash,
      historyEntry({
        ...parsed,
        value: parsed.value.toString(),
        timestamp: tx.blockTimestamp * 1000,
        success: !tx.err,
        error: tx.err || undefined,
        fee: String(tx.gasSpent * tx.tx.gasPrice),
        gasSpent: String(tx.gasSpent),
        gasPrice: String(tx.tx.gasPrice),
        gasLimit: String(tx.tx.gasLimit),
        fnName: tx.tx.callData?.fnName,
        contractId: tx.tx.callData?.contractId,
        detailsAt: 1,
      })
    );
  }
  return [...seen.values()].sort((a, b) => b.blockHeight - a.blockHeight);
}

let dom;
beforeEach(() => {
  dom = installFakeDom();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

// The popup on Home, or on a transaction's details once its route says so, drawn again by every render as app.js does.
function setup({ local = [] } = {}) {
  const ov = { isUnlocked: true, nodeUrl: NODE, accounts: [A], selectedAccountIndex: 0, txs: local };
  const state = {
    route: "home",
    addressBook: { loaded: true, items: [] },
    activity: { key: activityKey(ov), account: A, nodeUrl: NODE, entries: history(A), names: new Map(), loaded: true, complete: true, limit: 50 },
  };
  const draw = () => dom.document.body.replaceChildren(...(state.route === "tx" ? txDetailsView : homeView)(ov, { state, actions }));
  const actions = { render: vi.fn(async () => draw()), showToast: vi.fn(), send: vi.fn() };
  draw();
  return { ov, state, actions, draw };
}

const body = () => dom.document.body;
// Activity's rows, as they read.
const rows = () => body().querySelectorAll(".tx-row, .activity-tx-item").map((row) => visibleText(row));

describe("Activity's rows", () => {
  it("say a status only while it isn't final: the wallet's pending send, named as typed", () => {
    const pending = {
      hash: "aa".repeat(32),
      kind: TX_KIND.TRANSFER,
      privacy: "public",
      to: FAUCET,
      toName: "faucet.dusk",
      amount: "5000000000",
      status: "submitted",
      submittedAt: NOW.getTime() - 20_000,
      profileIndex: 0,
    };
    // Its row: the one that sent 5 DUSK.
    const own = () => rows().find((row) => row.includes("−5 DUSK"));
    setup({ local: [pending] });
    expect(own()).toContain("faucet.dusk");
    expect(own()).toContain(txStatusWord("submitted"));
    // Completed rows say nothing about it.
    for (const row of rows().filter((r) => r !== own())) expect(row).not.toContain(txStatusWord("executed"));

    // Saved as a contact: its own name, with the .dusk name it was sent to.
    const view = setup({ local: [pending] });
    view.state.addressBook = { loaded: true, items: [{ name: "Faucet (test)", address: FAUCET }] };
    view.draw();
    expect(own()).toContain("Faucet (test)");
    expect(own()).toContain("faucet.dusk");
    expect(own()).toContain(txStatusWord("submitted"));
  });

  // Lena's: after Don't send, a payment that went out anyway was a plain Sent row after a few seconds, and she
  // thought her "no" had been ignored. Marked till it's opened once.
  it("mark one that went out after Don't send, till it's opened once", () => {
    const went = {
      hash: "af".repeat(32),
      kind: TX_KIND.TRANSFER,
      privacy: "public",
      to: FAUCET,
      toName: "faucet.dusk",
      amount: "5000000000",
      status: "executed",
      submittedAt: NOW.getTime() - 20_000,
      profileIndex: 0,
      wentAfterAll: NOW.getTime() - 10_000,
    };
    // Its row: the one that sent 5 DUSK.
    const own = () => body().querySelectorAll(".tx-row").find((row) => visibleText(row).includes("−5 DUSK"));
    const view = setup({ local: [went] });
    expect(visibleText(own())).toContain(AFTER_ALL_TEXT);
    // Opened, it's said there; then a row as any other.
    own().querySelector("button.tx-open").click();
    expect(visibleText(body().querySelector(".tx-hero-status"))).toBe(AFTER_ALL_TEXT);
    view.ov.txs = [{ ...went, afterAllSeen: NOW.getTime() }];
    view.state.route = "home";
    view.draw();
    expect(visibleText(own())).not.toContain(AFTER_ALL_TEXT);
  });
});

describe("a synced entry whose outcome isn't looked up yet", () => {
  // A's register call, final on chain, before its details came.
  const unfetched = (view) => {
    const entry = view.state.activity.entries.find((e) => e.fnName === "register");
    Object.assign(entry, { success: null, timestamp: null, detailsAt: undefined });
    return entry;
  };
  // Its row: the one that paid 100 DUSK.
  const row = () => visibleText(body().querySelectorAll(".tx-row").find((r) => visibleText(r).includes("−100 DUSK")));
  const unknown = txStatusWord("unknown", { final: true });

  it("says its outcome is unknown, neither completed nor pending", () => {
    const view = setup();
    unfetched(view);
    view.draw();
    expect(row()).toContain(unknown);
    expect(row()).not.toContain(txStatusWord("executed"));
    expect(row()).not.toContain(txStatusWord("submitted"));
  });

  it("opens on an unknown outcome, says it is being looked up, and looks it up", () => {
    const view = setup();
    const entry = unfetched(view);
    Object.assign(view.state, { route: "tx", txDetailHash: entry.hash, txDetailFrom: "home" });
    detail.load.mockClear();
    view.draw();
    expect(detail.load).toHaveBeenCalledWith(expect.objectContaining({ state: view.state }), entry.hash);
    expect(visibleText(body().querySelector(".tx-hero-status"))).toBe(unknown);
    expect(visibleText(body().querySelector(".tx-hero-note"))).not.toBe("");
  });

  it("takes the wallet's own pending send it has as final, its outcome unknown, and looks it up too", () => {
    const view = setup();
    const entry = unfetched(view);
    view.ov.txs = [{ hash: entry.hash, kind: TX_KIND.CONTRACT_CALL, status: "submitted", profileIndex: 0, submittedAt: NOW.getTime() - 20_000 }];
    Object.assign(view.state, { route: "tx", txDetailHash: entry.hash, txDetailFrom: "home" });
    detail.load.mockClear();
    view.draw();
    expect(detail.load).toHaveBeenCalledWith(expect.objectContaining({ state: view.state }), entry.hash);
    // In a finalized block: not pending, whatever the wallet's watcher last saw.
    expect(visibleText(body().querySelector(".tx-hero-status"))).toBe(unknown);
    expect(visibleText(body().querySelector(".tx-hero-note"))).not.toBe("");
    // And its row the same.
    view.state.route = "home";
    view.draw();
    expect(row()).toContain(unknown);
    expect(row()).not.toContain(txStatusWord("submitted"));
  });
});
