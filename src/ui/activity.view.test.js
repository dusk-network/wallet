import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import fixture from "../shared/fixtures/activity-testnet.json";
import { historyEntry, parseHistoryEntry } from "@dusk-network/app-core/history";
import { TX_KIND } from "../shared/constants.js";
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
const SENDER = fixture.accounts[A].receiver[1].events[0].data.sender;
const dusk = (n) => (BigInt(n) * 1_000_000_000n).toString();
const short = (address) => `${address.slice(0, 6)}…${address.slice(-6)}`;
// The network fee's field, as a sent, a failed or a dropped transaction labels it.
const FEE = /^(network )?fee( charged)?$/i;
// A figure exactly as written: not inside a longer number, not signed or bounded unless written so, and not followed by
// more digits, letters or a decimal part (1.0025 ≠ 11.0025, 0.005 ≠ −0.005, 2,000,000 ≠ 2,000,000.5, BNB ≠ BNBX).
const exactly = (text) => new RegExp(`(?<![\\d.,+\\-−<>≤≥~])(?<![+\\-−<>≤≥~]\\s)${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\dA-Za-z]|[.,]\\d)`);
// Everything a screen gives away: all its text, shown or not, and each element's title and aria-label.
const everything = (root) => [root.textContent, ...[root, ...root.querySelectorAll("*")].flatMap((el) => [el.getAttribute("title"), el.getAttribute("aria-label")])].filter(Boolean).join("\n");

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
function setup({ local = [], hidden = false } = {}) {
  const ov = { isUnlocked: true, nodeUrl: NODE, accounts: [A], selectedAccountIndex: 0, txs: local, hideBalances: hidden };
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
// A row as it reads, each part from its own element: the name, the address or .dusk name beside it, the line under
// it, its marks, its amount and its status; and its state, failed or pending.
const partsOf = (row) => {
  const text = (selector) => (row.querySelector(selector) ? visibleText(row.querySelector(selector)) : "");
  const [name, alias] = [text(".tx-name"), text(".tx-alias")];
  return {
    row,
    name: alias ? name.slice(0, -alias.length) : name,
    alias: alias.replace(/^\W+/, ""),
    sub: text(".tx-sub"),
    alike: text(".tx-alike"),
    afterAll: text(".tx-after-all"),
    amount: text(".tx-amount"),
    status: text(".tx-status") || text(".tx-sub > span"),
    failed: row.className.split(" ").includes("is-failed"),
    pending: row.className.split(" ").includes("is-pending"),
  };
};
const rows = () => body().querySelectorAll(".tx-row").map(partsOf);
// The row that moved this amount, as it shows it.
const rowWith = (amount) => rows().find((row) => row.amount === amount);
// A transaction's details: each field's label, with its value.
const fieldsOf = (root) => Object.fromEntries(root.querySelectorAll(".kv").map((kv) => [visibleText(kv.querySelector(".kv-label")), visibleText(kv.querySelector(".kv-value"))]));

describe("Activity's rows", () => {
  // Sofia's: Activity named the one in a Cyrillic а as plain "Estudio Marta", with no address.
  it("mark a contact whose name looks like another's, with its address", () => {
    const { state, draw } = setup();
    state.addressBook.items = [
      { name: "Estudio M\u0430rta", address: SENDER },
      { name: "Estudio Marta", address: A.replace(/.$/, "x") },
    ];
    draw();
    const row = rowWith("+1,000 DUSK");
    expect([row.name, row.alias, row.alike]).toEqual(["Estudio M\u0430rta", short(SENDER), "Looks like another contact"]);
    // A name like no other's has no mark.
    state.addressBook.items = [{ name: "Estudio M\u0430rta", address: SENDER }];
    draw();
    expect(rowWith("+1,000 DUSK").alike).toBe("");
  });

  it("name a contact saved with hidden characters by their codes, never turned around", () => {
    // Marek's: an override at the start made a stranger's account read as "Profile 2".
    const { state, draw } = setup();
    state.addressBook.items = [{ name: "\u202e2 eliforP", address: SENDER }];
    draw();
    expect(rowWith("+1,000 DUSK").name).toBe("\\u202e2 eliforP");
    // Nowhere as it would read: on the screen, to a screen reader or in a tooltip.
    expect(everything(body())).not.toContain("\u202e");
  });

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
    setup({ local: [pending] });
    const own = rowWith("−5 DUSK");
    expect([own.name, own.status, own.pending]).toEqual(["faucet.dusk", "Pending", true]);
    // Completed rows say nothing about it.
    for (const row of rows().filter((r) => r.row !== own.row)) expect([row.status, row.pending]).toEqual(["", false]);

    // Saved as a contact: its own name, with the .dusk name it was sent to.
    const view = setup({ local: [pending] });
    view.state.addressBook = { loaded: true, items: [{ name: "Faucet (test)", address: FAUCET }] };
    view.draw();
    const named = rowWith("−5 DUSK");
    expect([named.name, named.alias, named.status]).toEqual(["Faucet (test)", "faucet.dusk", "Pending"]);
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
    const view = setup({ local: [went] });
    expect(rowWith("−5 DUSK").afterAll).toBe("Sent after you chose not to send");
    // Opened, it's said there; then a row as any other.
    rowWith("−5 DUSK").row.querySelector("button.tx-open").click();
    expect(visibleText(body().querySelector(".tx-hero-status"))).toBe("Sent after you chose not to send");
    view.ov.txs = [{ ...went, afterAllSeen: NOW.getTime() }];
    view.state.route = "home";
    view.draw();
    expect(rowWith("−5 DUSK").afterAll).toBe("");
  });

  it("say a failed one sent nothing, with the fee paid, its amount unsigned", () => {
    const failed = {
      hash: "bb".repeat(32),
      kind: TX_KIND.TRANSFER,
      privacy: "public",
      to: FAUCET,
      amount: dusk(200),
      status: "failed",
      error: "Out of gas",
      feePaid: "3700000",
      submittedAt: NOW.getTime() - 3_600_000,
      profileIndex: 0,
    };
    const failedRow = () => {
      const found = rows().filter((row) => row.failed);
      expect(found).toHaveLength(1);
      return found[0];
    };
    setup({ local: [failed] });
    let row = failedRow();
    // Failed, never Completed; the fee it paid, and its amount without a sign: nothing left.
    expect([row.status, row.amount]).toEqual(["Failed", "200 DUSK"]);
    expect(row.status).not.toMatch(/completed/i);
    expect(row.sub).toMatch(exactly("0.0037 DUSK"));
    // Hide balances hides the fee too, as it does the amount, wherever the row says them.
    setup({ local: [failed], hidden: true });
    row = failedRow();
    expect([row.status, row.amount]).toEqual(["Failed", "•••• DUSK"]);
    expect(row.sub).not.toMatch(/\d/);
    // Not anywhere, signed, joined to its unit or in a tooltip: nothing of either figure at all.
    for (const figure of ["0.0037", "200"]) expect(everything(row.row)).not.toContain(figure);
    // Without a fee charged, no fee, a fee of 0 included.
    for (const feePaid of [undefined, "0"]) {
      setup({ local: [{ ...failed, feePaid }] });
      row = failedRow();
      expect([row.status, row.amount]).toEqual(["Failed", "200 DUSK"]);
      expect(row.sub, String(feePaid)).not.toMatch(/\d/);
    }
  });

  it("show a fee paid rounded to the nearest, not up, and its details to the last lux", () => {
    const failed = {
      hash: "bc".repeat(32),
      kind: TX_KIND.TRANSFER,
      privacy: "public",
      to: FAUCET,
      amount: dusk(1),
      status: "failed",
      // 0.001840001 DUSK: 0.0018 to the nearest, 0.0019 rounded up.
      feePaid: "1840001",
      gasLimit: "2500000",
      gasPrice: "1",
      submittedAt: NOW.getTime() - 3_600_000,
      profileIndex: 0,
    };
    const view = setup({ local: [failed] });
    const row = rows().find((r) => r.failed);
    expect([row.status, row.amount]).toEqual(["Failed", "1 DUSK"]);
    expect(row.sub).toMatch(exactly("0.0018 DUSK"));
    expect(row.sub).not.toContain("0.0019");
    Object.assign(view.state, { route: "tx", txDetailHash: failed.hash, txDetailFrom: "home" });
    view.draw();
    const fee = Object.entries(fieldsOf(body())).find(([label]) => FEE.test(label))?.[1];
    expect(fee).toBe("0.001840001 DUSK");
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
  const row = () => rowWith("−100 DUSK");
  // The details' status, and its state: is-neutral for one nothing waits on.
  const hero = () => {
    const status = body().querySelector(".tx-hero-status");
    return [visibleText(status), status.className.split(" ").find((c) => c.startsWith("is-"))];
  };
  // Its note: final on chain, its outcome being looked up; never that the wallet stopped waiting for it.
  const lookedUp = () => {
    const note = visibleText(body().querySelector(".tx-hero-note"));
    expect(note).toMatch(/looked up/i);
    expect(note).not.toMatch(/stopped waiting/i);
  };

  it("says its outcome is unknown, neither completed nor pending", () => {
    const view = setup();
    unfetched(view);
    view.draw();
    expect([row().status, row().pending]).toEqual(["Unknown", false]);
  });

  it("opens on an unknown outcome, says it is being looked up, and looks it up", () => {
    const view = setup();
    const entry = unfetched(view);
    Object.assign(view.state, { route: "tx", txDetailHash: entry.hash, txDetailFrom: "home" });
    detail.load.mockClear();
    view.draw();
    expect(detail.load).toHaveBeenCalledWith(expect.objectContaining({ state: view.state }), entry.hash);
    expect(hero()).toEqual(["Unknown", "is-neutral"]);
    lookedUp();
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
    expect(hero()).toEqual(["Unknown", "is-neutral"]);
    lookedUp();
    // And its row the same.
    view.state.route = "home";
    view.draw();
    expect([row().status, row().pending]).toEqual(["Unknown", false]);
  });
});
