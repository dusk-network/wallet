import { readFile } from "node:fs/promises";
import path from "node:path";
import { duskEvmContracts } from "@dusk-network/networks/duskevm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import fixture from "../shared/fixtures/activity-testnet.json";
import { activityEntry, parseHistoryEntry } from "../shared/activityHistory.js";
import { TX_KIND } from "../shared/constants.js";
import { openUrl } from "../platform/index.js";
import { accessibleName, installFakeDom, screenReaderText, settle, visibleText } from "./testing/fakeDom.js";
import { bracketTitle } from "./components/BracketTitle.js";
import { subnav } from "./components/Subnav.js";
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
vi.mock("../platform/index.js", async (importOriginal) => ({ ...(await importOriginal()), openUrl: vi.fn(async () => true) }));
// The profile's verified name, as the header shows it.
vi.mock("../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: vi.fn(async () => "alice.dusk"),
}));

// Times as a popup in UTC shows them, the day after the fixture's transactions.
process.env.TZ = "UTC";
const NOW = new Date("2026-10-23T09:00:00Z");

const [A, B] = Object.keys(fixture.accounts);
const NODE = fixture.nodeUrl;
const FAUCET = fixture.accounts[A].receiver[0].events[0].data.sender;
const SENDER = fixture.accounts[A].receiver[1].events[0].data.sender;
const short = (address) => `${address.slice(0, 6)}…${address.slice(-6)}`;
const dusk = (n) => (BigInt(n) * 1_000_000_000n).toString();

// An account's synced history, as the popup keeps it (ui/popup/activity.js).
function history(account) {
  const raw = [...fixture.accounts[account].sender, ...fixture.accounts[account].receiver];
  const seen = new Map();
  for (const e of raw) {
    const parsed = parseHistoryEntry(account, e);
    const tx = fixture.details[parsed.hash];
    seen.set(
      parsed.hash,
      activityEntry({
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
  openUrl.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// The popup on `route`, drawn again by every render as app.js does.
function setup({ account = A, local = [], names = new Map(), complete = true, route = "home", hidden = false } = {}) {
  const ov = { isUnlocked: true, nodeUrl: NODE, accounts: [account], selectedAccountIndex: 0, txs: local, hideBalances: hidden };
  const state = {
    route,
    addressBook: { loaded: true, items: [] },
    activity: { key: activityKey(ov), account, nodeUrl: NODE, entries: history(account), names, loaded: true, complete, limit: 50 },
  };
  const draw = () => dom.document.body.replaceChildren(...(state.route === "tx" ? txDetailsView : homeView)(ov, { state, actions }));
  const actions = { render: vi.fn(async () => draw()), showToast: vi.fn(), send: vi.fn() };
  draw();
  return { ov, state, actions, draw };
}

const body = () => dom.document.body;
// Activity's rows, as they read.
const rows = () => body().querySelectorAll(".tx-row, .activity-tx-item").map((row) => visibleText(row));
const button = (name) => body().querySelectorAll("button").find((b) => visibleText(b).trim() === name || accessibleName(b) === name);

describe("Activity's rows", () => {
  it("lead with the other side's name, else its short address with Copy, and say when", async () => {
    setup({ names: new Map([[FAUCET, "faucet.dusk"], [SENDER, null]]) });
    expect(rows()).toEqual([
      "Registered a .dusk nameDusk Domains · Yesterday−100 DUSK",
      "Name reservation (step 1 of 2)Dusk Domains · Yesterday",
      `${short(SENDER)}Received · Yesterday+1,000 DUSK`,
      "faucet.duskReceived · Yesterday+1,100 DUSK",
    ]);
    // The address shows in mono, and Copy copies all of it.
    const row = body().querySelectorAll(".tx-row")[2];
    expect(row.querySelector(".tx-name").className).toBe("tx-name mono");
    const copy = row.querySelector("button.tx-copy");
    expect(accessibleName(copy)).toBe("Copy address");
    copy.click();
    await settle();
    expect(dom.clipboard.writeText).toHaveBeenLastCalledWith(SENDER);
    // Opening a row says what it holds.
    expect(accessibleName(body().querySelector(".tx-row button.tx-open"))).toBe("Registered a .dusk name, Dusk Domains · Yesterday, −100 DUSK");
  });

  it("name a .dusk name's reservation by the registration that follows it, once both calls are read", () => {
    const { state, draw } = setup();
    const R = "1f".repeat(32);
    state.activity.entries = state.activity.entries.map((e) =>
      e.fnName === "register" ? { ...e, registeredName: "shpongle.dusk", reservation: R } : e.fnName === "commit" ? { ...e, reservation: R } : e
    );
    draw();
    expect(rows().slice(0, 2)).toEqual(["Registered shpongle.duskDusk Domains · Yesterday−100 DUSK", "Reserved shpongle.duskDusk Domains · Yesterday"]);
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
    expect(rows()[0]).toBe("faucet.duskSent · Just now−5 DUSKPending");
    // Completed rows say nothing about it.
    expect(rows().slice(1).join("\n")).not.toMatch(/Completed|Finalized|Executed/);

    // Saved as a contact, its own name leads, the .dusk name after it.
    const view = setup({ local: [pending] });
    view.state.addressBook = { loaded: true, items: [{ name: "Faucet (test)", address: FAUCET }] };
    view.draw();
    expect(rows()[0]).toBe("Faucet (test) · faucet.duskSent · Just now−5 DUSKPending");
    expect(body().querySelector(".tx-row .tx-alias").textContent).toBe(" · faucet.dusk");
    expect(accessibleName(body().querySelector(".tx-row button.tx-open"))).toBe("Faucet (test) · faucet.dusk, Sent · Just now, −5 DUSK, Pending");
  });

  it("say a failed one sent nothing, with the fee paid, its amount muted and unsigned", () => {
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
    setup({ local: [failed] });
    expect(rows()[0]).toBe(`${short(FAUCET)}Failed · nothing sent · fee 0.0037 DUSK paid200 DUSK`);
    expect(body().querySelector(".tx-row .tx-amount").className).toBe("tx-amount is-muted");
    expect(body().querySelector(".tx-row .tx-sub span").className).toBe("tx-status--bad");
    expect(accessibleName(body().querySelector(".tx-row button.tx-open"))).toBe(
      `${short(FAUCET)}, Failed · nothing sent · fee 0.0037 DUSK paid, 200 DUSK`
    );
    // Hide balances hides the fee too, as it does the amount.
    setup({ local: [failed], hidden: true });
    expect(rows()[0]).toBe(`${short(FAUCET)}Failed · nothing sent · fee •••• DUSK paid•••• DUSK`);
    expect(accessibleName(body().querySelector(".tx-row button.tx-open"))).toBe(`${short(FAUCET)}, Failed · nothing sent · fee hidden, amount hidden`);
    // Without a fee charged, it says so, a fee of 0 included.
    setup({ local: [{ ...failed, feePaid: undefined }] });
    expect(rows()[0]).toBe(`${short(FAUCET)}Failed · nothing sent · no fee200 DUSK`);
    setup({ local: [{ ...failed, feePaid: "0" }] });
    expect(rows()[0]).toBe(`${short(FAUCET)}Failed · nothing sent · no fee200 DUSK`);
  });

  it("show a fee paid as its details do, rounded to the nearest, not up", () => {
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
    expect(rows()[0]).toBe(`${short(FAUCET)}Failed · nothing sent · fee 0.0018 DUSK paid1 DUSK`);
    Object.assign(view.state, { route: "tx", txDetailHash: failed.hash, txDetailFrom: "home" });
    view.draw();
    expect(visibleText(body())).toContain("Fee charged0.0018 DUSK");
  });

  it("hide their amounts with Hide balances, on Home and in the full list", () => {
    const { state, draw } = setup({ hidden: true });
    const amounts = () => body().querySelectorAll(".tx-amount, .activity-amount").map((el) => [visibleText(el), screenReaderText(el)]);
    expect(amounts()).toEqual(Array(3).fill(["•••• DUSK", "hidden DUSK"]));
    state.route = "activity";
    draw();
    expect(amounts()).toEqual(Array(3).fill(["•••• DUSK", "hidden DUSK"]));
    expect(accessibleName(body().querySelector(".tx-row button.tx-open"))).toBe("Registered a .dusk name, Dusk Domains · 16:45, amount hidden");
  });

  it("label bridge transfers, and mark shielded ones", () => {
    const { bridge, portal } = duskEvmContracts(2);
    const at = Date.parse("2026-10-23T07:00:30Z");
    const local = [
      { hash: "c1".repeat(32), kind: TX_KIND.CONTRACT_CALL, contractId: bridge, fnName: "depositETHToWithValue", deposit: dusk(5), status: "executed", submittedAt: at, profileIndex: 0 },
      { hash: "c2".repeat(32), kind: TX_KIND.TRANSFER, direction: "in", from: portal, amount: dusk(2), status: "executed", timestamp: at - 1000, profileIndex: 0 },
      { hash: "c3".repeat(32), kind: TX_KIND.TRANSFER, direction: "in", privacy: "shielded", source: "shielded", amount: dusk(3), status: "executed", timestamp: at - 2000 },
    ];
    setup({ local });
    expect(rows().slice(0, 3)).toEqual([
      "To DuskEVMBridge · 07:00−5 DUSK",
      "From DuskEVMBridge · 07:00+2 DUSK",
      "ReceivedShielded · 07:00+3 DUSK",
    ]);
  });
});

describe("Home's Activity", () => {
  it("links to no outside history, and See all opens the full list", () => {
    const { state } = setup();
    const buttons = body().querySelectorAll("button").map((b) => visibleText(b).trim());
    expect(buttons.filter((t) => /History/.test(t))).toEqual([]);
    expect(body().innerHTML).not.toMatch(/duskscan/i);
    button("See all").click();
    expect(state.route).toBe("activity");
  });
});

describe("the Activity view", () => {
  it("groups by day under the All, Sent, Received, Staking and Bridge filters", () => {
    const { state, draw } = setup({ account: B, route: "activity" });
    const filters = () => body().querySelectorAll(".filter-chip").map((b) => [visibleText(b), b.getAttribute("aria-pressed")]);
    const days = () => body().querySelectorAll(".tx-day-label").map(visibleText);
    expect(filters()).toEqual([["All", "true"], ["Sent", "false"], ["Received", "false"], ["Staking", "false"], ["Bridge", "false"]]);
    expect(days().slice(0, 4)).toEqual(["Yesterday", "Wed 21 Oct", "Fri 18 Sep", "Fri 17 Jul"]);
    expect(days()).toContain("Sun 16 Nov 2025");

    button("Staking").click();
    expect(state.activityFilter).toBe("staking");
    expect(filters()[3]).toEqual(["Staking", "true"]);
    expect(rows()).toEqual([
      "Claim rewardsStaking · 00:59+62,166.5879 DUSK",
      "UnstakeStaking · 00:59+500,000 DUSK",
      "Claim rewardsStaking · 17:54+239,121.4534 DUSK",
      "Staked with SozuStaking · 20:10−50 DUSK",
      "Staked with SozuStaking · 14:00−1,000 DUSK",
      "Claim rewardsStaking · 13:35+1,609,142.7584 DUSK",
    ]);
    expect(days()).toEqual(["Wed 21 Oct", "Fri 18 Sep", "Wed 17 Jun", "Sun 31 May"]);

    button("Received").click();
    expect(rows().every((text) => /Received · /.test(text))).toBe(true);
    button("Sent").click();
    expect(rows().some((text) => /Received|Staking · /.test(text))).toBe(false);
    // No bridge transfers here.
    button("Bridge").click();
    expect([rows(), visibleText(body().querySelector(".tx-empty"))]).toEqual([[], "No bridge transfers yet."]);
    state.activityFilter = "all";
    draw();
  });

  it("offers Show more while older history is still to come, and the account on Dusk's explorer", async () => {
    const { state, draw } = setup({ complete: false, route: "activity" });
    expect(button("Show more")).toBeTruthy();
    state.activity.complete = true;
    draw();
    expect(button("Show more")).toBeUndefined();
    button("View in Dusk explorer").click();
    await settle();
    expect(openUrl).toHaveBeenCalledWith(`https://apps.testnet.dusk.network/explorer/accounts/?key=${A}`);
  });
});

describe("a transaction's details", () => {
  const sent = {
    hash: "3e6a0ec6".padEnd(56, "0") + "7eae84ba",
    kind: TX_KIND.TRANSFER,
    privacy: "public",
    to: FAUCET,
    toName: "faucet.dusk",
    amount: dusk(25),
    memo: "Order 1042",
    status: "executed",
    feePaid: "3700000",
    gasSpent: "3700000",
    gasLimit: "10000000",
    gasPrice: "1",
    blockHeight: "4658100",
    submittedAt: Date.parse("2026-10-22T14:32:00Z"),
    executedAt: Date.parse("2026-10-22T14:32:10Z"),
    profileIndex: 0,
  };
  const open = (opts, hash) => {
    const view = setup({ ...opts, route: "tx" });
    Object.assign(view.state, { txDetailHash: hash, txDetailFrom: "activity" });
    view.draw();
    return view;
  };

  it("leads with who, how much and its status, then its date, memo, fee, profile and ID", async () => {
    const { state } = open({ local: [sent] }, sent.hash);
    await settle();
    expect(visibleText(body().querySelector(".tx-hero"))).toBe("Sent tofaucet.dusk" + `${short(FAUCET)}−25 DUSKCompleted`);
    expect(body().querySelectorAll(".tx-detail > .group > .kv").map(visibleText)).toEqual([
      "DateThu 22 Oct 2026, 14:32 UTC",
      "MemoOrder 1042",
      "Network fee0.0037 DUSK",
      "Fromalice.dusk · Public",
      "Transaction ID3e6a0e…ae84baCopy",
    ]);
    // The ID opens Dusk's explorer; Copy and the address's copy say what they copy.
    const explorerUrl = `https://apps.testnet.dusk.network/explorer/transactions/transaction/?id=${sent.hash}`;
    button(`Transaction 3e6a0e…ae84ba, open in Dusk explorer`).click();
    await settle();
    expect(openUrl).toHaveBeenLastCalledWith(explorerUrl);
    button("Copy transaction ID").click();
    await settle();
    expect(dom.clipboard.writeText).toHaveBeenLastCalledWith(sent.hash);
    button("Copy address").click();
    await settle();
    expect(dom.clipboard.writeText).toHaveBeenLastCalledWith(FAUCET);
    // Block, gas and finality wait under Technical details.
    const tech = body().querySelector("details.tx-tech");
    expect(tech.open).toBe(false);
    expect(visibleText(tech.querySelector("summary"))).toBe("Technical details");
    expect(tech.querySelectorAll(".kv").map(visibleText)).toEqual([
      "NetworkTestnet",
      "Block4,658,100",
      "Gas used3,700,000 of 10,000,000",
      "Gas price1 LUX",
      "Fee paid0.0037 DUSK",
      "SubmittedThu 22 Oct 2026, 14:32 UTC",
    ]);
    button("View in Dusk explorer").click();
    await settle();
    expect(openUrl).toHaveBeenLastCalledWith(explorerUrl);
    // Back says so, and goes back where it came from.
    button("← Back").click();
    expect(state.route).toBe("activity");
  });

  it("hides the amount with Hide balances, but not the fee", () => {
    open({ local: [sent], hidden: true }, sent.hash);
    expect(visibleText(body())).not.toContain("25 DUSK");
    expect(visibleText(body())).toContain("Network fee0.0037 DUSK");
    expect([visibleText(body().querySelector(".tx-hero-amount")), screenReaderText(body().querySelector(".tx-hero-amount"))]).toEqual([
      "•••• DUSK",
      "hidden DUSK",
    ]);
  });

  it("names a received transfer's sender, and the profile it reached; the chain says it's final", async () => {
    const view = setup({ names: new Map([[FAUCET, "faucet.dusk"]]) });
    const received = view.state.activity.entries.find((e) => e.counterparty === FAUCET);
    Object.assign(view.state, { route: "tx", txDetailHash: received.hash, txDetailFrom: "home" });
    view.draw();
    await settle();
    expect(visibleText(body().querySelector(".tx-hero"))).toBe(`Received fromfaucet.dusk${short(FAUCET)}+1,100 DUSKCompleted`);
    const text = body().querySelectorAll(".kv").map(visibleText);
    expect(text).toContain("Toalice.dusk · Public");
    expect(text).toContain("FinalityFinal");
    // Its fee was the sender's.
    expect(text.some((t) => t.startsWith("Network fee"))).toBe(false);
  });

  it("says why one didn't go through in plain words, and what it cost", () => {
    const failed = { ...sent, status: "failed", error: "Panic: phoenix is not enabled in the VM" };
    open({ local: [failed] }, failed.hash);
    expect(visibleText(body().querySelector(".tx-hero-status"))).toBe("Failed");
    expect(visibleText(body().querySelector(".tx-hero-note"))).toBe(
      "Shielded transactions are paused on the network. The 25 DUSK stayed in your wallet."
    );
    // The chain's own words wait under Technical details.
    expect(body().querySelectorAll("details.tx-tech .kv").map(visibleText)).toContain("ErrorPanic: phoenix is not enabled in the VM");
    // Nothing left: the amount shows muted, without a sign.
    expect([visibleText(body().querySelector(".tx-hero-amount")), body().querySelector(".tx-hero-amount").className]).toEqual([
      "25 DUSK",
      "tx-hero-amount is-muted",
    ]);
    expect(visibleText(body())).toContain("Fee charged0.0037 DUSK");
    open({ local: [failed], hidden: true }, failed.hash);
    expect(visibleText(body().querySelector(".tx-hero-note"))).toBe(
      "Shielded transactions are paused on the network. The amount stayed in your wallet."
    );
    // An error without plain words keeps its own, shortened.
    open({ local: [{ ...failed, error: "Panic: DRC20Phoenix: paused" }] }, failed.hash);
    expect(visibleText(body().querySelector(".tx-hero-note"))).toBe("Panic: DRC20Phoenix: paused. The 25 DUSK stayed in your wallet.");

    const pending = { ...sent, status: "mempool", feePaid: undefined, gasSpent: undefined };
    open({ local: [pending] }, pending.hash);
    expect(visibleText(body().querySelector(".tx-hero-status"))).toBe("Pending");
    expect(visibleText(body().querySelector(".tx-hero-note"))).toBe("Still waiting to go through. Don't retry yet.");
    expect(visibleText(body())).toContain("Network feeUp to 0.01 DUSK");

    const dropped = { ...pending, status: "removed" };
    open({ local: [dropped] }, dropped.hash);
    expect(visibleText(body().querySelector(".tx-hero-status"))).toBe("Dropped");
    expect(visibleText(body().querySelector(".tx-hero-note"))).toBe(
      "The network dropped it before it ran, so no fee was charged. The 25 DUSK stayed in your wallet."
    );
    expect(visibleText(body())).toContain("Network feeNone charged");
  });
});

describe("a synced entry whose outcome isn't looked up yet", () => {
  // A's register call, final on chain, before its details came.
  const unfetched = (view) => {
    const entry = view.state.activity.entries.find((e) => e.fnName === "register");
    Object.assign(entry, { success: null, timestamp: null, detailsAt: undefined });
    return entry;
  };

  it("says Syncing… where its time goes, or its block's time once another row of that block has it", () => {
    const view = setup();
    const entry = unfetched(view);
    const line = () =>
      visibleText(body().querySelectorAll(".tx-row").find((r) => visibleText(r).startsWith("Registered a .dusk name")).querySelector(".tx-sub"));
    view.draw();
    expect(line()).toBe("Dusk Domains · Syncing…");
    view.state.route = "activity";
    view.draw();
    expect(line()).toBe("Dusk Domains · Syncing…");

    // Another entry of the same block has come with its time.
    const other = view.state.activity.entries.find((e) => e !== entry && e.timestamp);
    entry.blockHeight = other.blockHeight;
    view.draw();
    expect(line()).toBe(`Dusk Domains · ${new Date(other.timestamp).toISOString().slice(11, 16)}`);
  });

  it("says Unknown, muted, not Completed or Pending", () => {
    const view = setup();
    unfetched(view);
    view.draw();
    const row = body().querySelectorAll(".tx-row").find((r) => visibleText(r).startsWith("Registered a .dusk name"));
    expect(visibleText(row)).toMatch(/Unknown$/);
    expect(row.querySelector(".tx-right .tx-status").className).toBe("tx-status tx-status--neutral");
    expect(row.className).not.toMatch(/is-pending/);
  });

  it("opens on Unknown, says it is being looked up, and looks it up", () => {
    const view = setup();
    const entry = unfetched(view);
    Object.assign(view.state, { route: "tx", txDetailHash: entry.hash, txDetailFrom: "home" });
    detail.load.mockClear();
    view.draw();
    expect(detail.load).toHaveBeenCalledWith(expect.objectContaining({ state: view.state }), entry.hash);
    const status = body().querySelector(".tx-hero-status");
    expect([visibleText(status), status.className]).toEqual(["Unknown", "tx-hero-status is-neutral"]);
    expect(visibleText(body().querySelector(".tx-hero-note"))).toBe("It is final on chain. Its outcome is still being looked up.");
  });

  it("takes the wallet's own pending send it has as final, Unknown, and looks it up too", () => {
    const view = setup();
    const entry = unfetched(view);
    view.ov.txs = [{ hash: entry.hash, kind: TX_KIND.CONTRACT_CALL, status: "submitted", profileIndex: 0, submittedAt: NOW.getTime() - 20_000 }];
    Object.assign(view.state, { route: "tx", txDetailHash: entry.hash, txDetailFrom: "home" });
    detail.load.mockClear();
    view.draw();
    expect(detail.load).toHaveBeenCalledWith(expect.objectContaining({ state: view.state }), entry.hash);
    // In a finalized block: not pending, whatever the wallet's watcher last saw.
    const status = body().querySelector(".tx-hero-status");
    expect([visibleText(status), status.className]).toEqual(["Unknown", "tx-hero-status is-neutral"]);
    expect(visibleText(body().querySelector(".tx-hero-note"))).toBe("It is final on chain. Its outcome is still being looked up.");
    // And its row the same.
    view.state.route = "home";
    view.draw();
    const row = body().querySelectorAll(".tx-row").find((r) => visibleText(r).startsWith("Registered a .dusk name"));
    expect(row.querySelector(".tx-right .tx-status").className).toBe("tx-status tx-status--neutral");
  });
});

// The look the explorer and the web wallet share: heads and labels in the
// ledger's type, the chain's blue on what leads somewhere.

const css = () => readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");
// A rule's body, by its selector as the stylesheet writes it.
const rule = (sheet, selector) => sheet.split("\n}").find((block) => `\n${block}`.includes(`\n${selector} {`)) ?? "";
const blue = () => body().querySelectorAll(".chain-link");

describe("a section's head", () => {
  it("reads as [ ACTIVITY ], its brackets drawn and not read", () => {
    const head = bracketTitle({ text: "Activity" });
    expect(head.localName).toBe("h2");
    expect(visibleText(head)).toBe("[Activity]");
    expect(screenReaderText(head)).toBe("Activity");
    expect(head.querySelectorAll(".bracket-title__bracket").map((b) => [b.textContent, b.getAttribute("aria-hidden")])).toEqual([
      ["[", "true"],
      ["]", "true"],
    ]);
  });

  it("is in the ledger's type, in Söhne Mono, with brackets in the muted text colour", async () => {
    const sheet = await css();
    const head = rule(sheet, ".bracket-title");
    expect(head).toContain("font-family: var(--font-mono);");
    expect(head).toContain("letter-spacing: var(--ledger-tracking);");
    expect(head).toContain("text-transform: uppercase;");
    expect(rule(sheet, ".bracket-title__bracket")).toContain("color: var(--text-muted);");
    // Söhne Mono, the extension's own, as the web wallet and the explorer set it.
    expect(sheet).toMatch(/--font-mono: "Soehne Mono", ui-monospace,/);
  });
});

describe("a head with a link beside it", () => {
  it("sets the two on one baseline, as See all beside [ ACTIVITY ]", async () => {
    const head = rule(await css(), ".section-head");
    expect(head).toContain("align-items: baseline;");
    expect(head).not.toContain("align-items: center;");
    setup({ route: "home" });
    const row = body().querySelector(".home-activity .section-head");
    expect(row.children.map((child) => child.className)).toEqual(["bracket-title", "see-all chain-link"]);
  });
});

describe("a sub-page's title", () => {
  it("stays plain, without brackets, in the text font", async () => {
    const title = subnav({ title: "Staking", onBack: () => {} }).querySelector(".subnav-title");
    expect(title.localName).toBe("h1");
    expect(title.textContent).toBe("Staking");
    expect(title.children).toHaveLength(0);
    const plain = rule(await css(), ".subnav-title");
    expect(plain).not.toContain("text-transform");
    expect(plain).not.toContain("--font-mono");
  });
});

describe("the labels of balances and stakes", () => {
  it("are in the ledger's type; day groups keep sentence case", async () => {
    const sheet = await css();
    for (const label of [".balance-label__text", ".balance-split-label", ".stake-lbl"]) {
      const body = rule(sheet, label);
      expect(body, label).toContain("font-family: var(--font-mono);");
      expect(body, label).toContain("font-size: var(--ledger-size);");
      expect(body, label).toContain("text-transform: uppercase;");
    }
    expect(rule(sheet, "h2.tx-day-label")).not.toContain("text-transform");
    setup({ route: "activity" });
    expect(body().querySelectorAll("h2.tx-day-label").map((day) => day.textContent)[0]).toBe("Yesterday");
  });
});

describe("an ellipsis", () => {
  it("is one character in everything the wallet writes, as every Dusk app writes it", async () => {
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(path.resolve(process.cwd(), "src"), { recursive: true })).filter(
      (file) => file.endsWith(".js") && !file.endsWith(".test.js") && !file.includes("vendor")
    );
    const dots = [];
    for (const file of files) {
      const source = await readFile(path.resolve(process.cwd(), "src", file), "utf8");
      // Three dots after a word, closing a string: "Saving...".
      for (const [found] of source.matchAll(/\w\.\.\.["'`]/g)) dots.push(`${file}: ${found}`);
    }
    expect(dots).toEqual([]);
  });
});

describe("the chain's blue", () => {
  it("is only on what leads somewhere: See all, the explorer and a transaction's ID", async () => {
    const view = setup({ route: "home" });
    // Home: See all, which opens Activity. A row opens its details: a row, not a link.
    expect(blue().map(visibleText)).toEqual(["See all"]);
    expect(body().querySelectorAll(".tx-row .chain-link")).toHaveLength(0);
    blue()[0].click();
    await settle();
    expect(view.state.route).toBe("activity");

    // Activity: the account on Dusk's explorer.
    expect(blue().map(visibleText)).toEqual(["View in Dusk explorer"]);
    blue()[0].click();
    await settle();
    expect(openUrl).toHaveBeenCalledTimes(1);

    // A transaction's details: its ID, which opens it on the explorer. Copy acts, so it isn't blue.
    Object.assign(view.state, { route: "tx", txDetailHash: view.state.activity.entries[0].hash, txDetailFrom: "home" });
    view.draw();
    expect(blue().map((el) => el.className)).toEqual(["text-btn tx-id chain-link"]);
    blue()[0].click();
    await settle();
    expect(openUrl).toHaveBeenCalledTimes(2);
  });

  it("keeps an underline at rest on a link in a row's text, such as Run a node: its blue alone isn't enough", async () => {
    const sheet = await css();
    const inline = rule(sheet, "button.chain-link.text-btn--inline:not(:disabled)");
    expect(inline).toContain("text-decoration-line: underline;");
    expect(inline).not.toContain("--chain-blue");
    // Other links still show theirs only under the pointer.
    expect(sheet).toMatch(/button\.chain-link:not\(:disabled\),\nbutton\.chain-link:not\(:disabled\):hover \{\n  color: var\(--chain-blue\);\n  text-decoration-line: none;/);
  });

  it("is set only through .chain-link, on buttons that aren't disabled", async () => {
    const sheet = await css();
    const blocks = sheet.split("\n}").filter((block) => block.includes("var(--chain-blue)"));
    expect(blocks).toHaveLength(1);
    const selectors = blocks[0]
      .slice(0, blocks[0].indexOf("{"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(",")
      .map((selector) => selector.trim());
    expect(selectors).toEqual(["button.chain-link:not(:disabled)", "button.chain-link:not(:disabled):hover"]);
  });
});
