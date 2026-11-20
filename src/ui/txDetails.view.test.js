import "fake-indexeddb/auto";
import { networks, routes } from "@dusk-network/networks";
import { duskEvmContracts } from "@dusk-network/networks/duskevm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keptArrivals } from "../shared/bridgeArrival.js";
import { TX_KIND } from "../shared/constants.js";
import { REPLACED_TEXT } from "../shared/waitingSends.js";
import { walletLabel } from "../shared/wallets.js";
import { installFakeDom, settle, visibleText } from "./testing/fakeDom.js";
import { recordedEvm, recordedMigration } from "./testing/recordedEvm.js";
import { entryOf } from "../shared/fixtures/rows.js";
import { activityKey, activityRows } from "./popup/activity.js";
import { NOT_SENT_FOLLOWED_TEXT } from "./popup/views/sent.js";
import { txDetailsView } from "./popup/views/txDetails.js";
import { txStatusWord } from "./popup/views/txDisplay.js";
import { AFTER_ALL_TEXT, afterAllUnseen } from "./popup/views/txRow.js";

const HASH = "ab".repeat(32);
const NODE = "https://testnet.nodes.dusk.network";

// The amounts a transaction's rows say, in their order, whatever each row is called.
const amounts = (rows) => rows.map((row) => row.match(/(?:[\d,.]+|••••) (?:BEP20 )?DUSK/)?.[0]).filter(Boolean);

let dom;

beforeEach(() => {
  dom = installFakeDom();
  // No test reaches a chain: one that reads one says what it answers.
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Renders a transaction's details as the popup does.
function details(tx, { hidden = false, own = {} } = {}) {
  const state = { route: "tx", txDetailHash: HASH, txDetailFrom: "home", addressBook: { loaded: true, items: [] } };
  const actions = { render: vi.fn(async () => {}), showToast: vi.fn() };
  const ov = { nodeUrl: NODE, hideBalances: hidden, txs: [{ hash: HASH, nodeUrl: NODE, ...tx }], ...own };
  dom.document.body.replaceChildren(...txDetailsView(ov, { state, actions }));
  const body = dom.document.body;
  return {
    name: visibleText(body.querySelector(".tx-hero-name")),
    note: body.querySelector(".tx-hero-note") ? visibleText(body.querySelector(".tx-hero-note")) : "",
    rows: body.querySelectorAll(".tx-detail > .group > .kv").map(visibleText),
    body,
  };
}

describe("a name read through a node the wallet doesn't know", () => {
  const CUSTOM = "https://my-node.example:8443";
  const OTHER = "z".repeat(90);
  const transfer = { kind: TX_KIND.TRANSFER, to: OTHER, amount: "1000000000", status: "executed" };

  it("says whose word it is in a transaction's details, and nothing on a network's own node or with no name", () => {
    expect(details({ ...transfer, nodeUrl: CUSTOM, toName: "bob.dusk" }, { own: { nodeUrl: CUSTOM } }).note).toMatch(/my-node\.example:8443/);
    expect(details({ ...transfer, toName: "bob.dusk" }).note).toBe("");
    expect(details({ ...transfer, nodeUrl: CUSTOM }, { own: { nodeUrl: CUSTOM } }).note).toBe("");
  });
});

describe("transaction details", () => {
  // Chen's, R01: "Not confirmed yet" for good, with nothing to tap, though the network never had it.
  it("says one the network never had isn't sent yet, with Send it now and Don't send, and one another took the place of wasn't sent, with neither", async () => {
    const stake = { kind: TX_KIND.STAKE, amount: "1000000000", profileIndex: 0, privacy: "public", source: "sent", account: "acct", nonce: "4" };
    const state = { route: "tx", txDetailHash: HASH, txDetailFrom: "activity", addressBook: { loaded: true, items: [] } };
    const answers = { DUSK_UI_RESEND_TX: { ok: true, result: { hash: HASH } }, DUSK_UI_DROP_TX: { ok: true, result: { dropped: true, followed: true } } };
    const actions = { render: vi.fn(async () => {}), showToast: vi.fn(), send: vi.fn(async (message) => answers[message.type]) };
    const show = (tx) => {
      dom.document.body.replaceChildren(...txDetailsView({ nodeUrl: NODE, txs: [{ hash: HASH, nodeUrl: NODE, ...tx }] }, { state, actions }));
      const body = dom.document.body;
      return {
        body,
        status: visibleText(body.querySelector(".tx-hero-status")),
        note: visibleText(body.querySelector(".tx-hero-note")),
        fees: body.querySelectorAll(".tx-detail > .group > .kv").map(visibleText).filter((row) => /fee/i.test(row)),
        buttons: body.querySelectorAll(".tx-unsent-actions button"),
      };
    };
    let view = show({ ...stake, status: "unsent", signedTx: "ab12" });
    expect([view.status, view.buttons.length]).toEqual([txStatusWord("unsent"), 2]);
    expect(view.note).not.toBe("");
    // No fee charged: its fee row has no amount.
    expect(view.fees).toHaveLength(1);
    expect(view.fees[0]).not.toMatch(/[1-9]/);
    expect(visibleText(view.body)).not.toContain(txStatusWord("submitted"));
    view.buttons[0].click();
    await settle();
    expect(actions.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_RESEND_TX", hash: HASH });
    expect(actions.render).toHaveBeenCalled();

    view = show({ ...stake, status: "unsent", signedTx: "ab12" });
    view.buttons[1].click();
    await settle();
    expect(actions.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_DROP_TX", hash: HASH });
    // Astra's: its hand-over had no clear answer, so it may still arrive; said so, never that nothing left.
    expect(actions.showToast).toHaveBeenLastCalledWith(NOT_SENT_FOLLOWED_TEXT);
    expect([state.route, state.txDetailHash]).toEqual(["activity", null]);

    // Send it now handed it over, and its answer was lost: it may have gone, and is looked up, never said to have failed.
    state.route = "tx";
    state.txDetailHash = HASH;
    answers.DUSK_UI_RESEND_TX = { error: { code: -32603, message: "Failed to fetch", data: { sent: "unknown", hash: HASH } } };
    view = show({ ...stake, status: "unsent", signedTx: "ab12" });
    actions.showToast.mockClear();
    view.buttons[0].click();
    await settle();
    expect(actions.showToast).toHaveBeenCalledTimes(1);
    expect(actions.showToast.mock.lastCall[0]).not.toContain("Failed to fetch");
    // Chosen not to be sent, and arrived after all: Completed, and said so.
    view = show({ ...stake, status: "executed", wentAfterAll: Date.now(), afterAllSeen: Date.now() });
    expect(view.status).toBe(txStatusWord("executed"));
    expect(view.note).not.toBe("");

    state.route = "tx";
    state.txDetailHash = HASH;
    view = show({ ...stake, status: "not_sent" });
    expect([view.status, view.note, view.buttons]).toEqual([txStatusWord("not_sent"), REPLACED_TEXT, []]);
  });

  // Lena's: she said Don't send, it went out anyway, and its screen turned into a plain green "Sent at …": she
  // thought her "no" had been ignored. Said so on its screen, with when it went, till it's opened once.
  it("says a payment went out after you chose not to send it, and when, till it's opened once", async () => {
    // Where the transaction store lives outside the extension.
    const kept = new Map();
    vi.stubGlobal("localStorage", { getItem: (k) => kept.get(String(k)) ?? null, setItem: (k, v) => kept.set(String(k), String(v)), removeItem: (k) => kept.delete(String(k)), key: (i) => [...kept.keys()][i] ?? null, get length() { return kept.size; } });
    const txs = await import("../shared/txStore.js");
    const landed = new Date(2026, 10, 17, 20, 41).getTime();
    // When it went, as its block says (finalizedAt).
    const sent = { kind: TX_KIND.TRANSFER, privacy: "public", to: "acct", amount: "10000000", profileIndex: 0, status: "executed", submittedAt: landed - 60_000, finalizedAt: landed, wentAfterAll: landed + 5_000 };
    await txs.putTxMeta(HASH, { ...sent, walletId: "w", nodeUrl: NODE });
    const state = { route: "tx", txDetailHash: HASH, txDetailFrom: "activity", addressBook: { loaded: true, items: [] } };
    const actions = { render: vi.fn(async () => {}), showToast: vi.fn() };
    const show = (over = {}) => {
      dom.document.body.replaceChildren(...txDetailsView({ nodeUrl: NODE, txs: [{ hash: HASH, nodeUrl: NODE, ...sent, ...over }] }, { state, actions }));
      const body = dom.document.body;
      return [visibleText(body.querySelector(".tx-hero-status")), visibleText(body.querySelector(".tx-hero-note"))];
    };
    expect(show()).toEqual([AFTER_ALL_TEXT, expect.stringMatching(/20:41/)]);
    // Opened: it's kept as seen, and this look still says it.
    await vi.waitFor(async () => expect((await txs.getTxMeta(HASH))?.afterAllSeen).toEqual(expect.any(Number)));
    expect(show({ afterAllSeen: Date.now() })[0]).toBe(AFTER_ALL_TEXT);
    // The next look: Completed, with what happened, and when, in its note.
    state.afterAllOpen = null;
    expect(show({ afterAllSeen: Date.now() })).toEqual([txStatusWord("executed"), expect.stringMatching(/20:41/)]);
  });

  // Round 40's review: "It went out at …" said when the wallet handed it over or saw it go, which can be long after,
  // or before Don't send; and back in Activity from its screen, its row was still marked till the overview was read again.
  it("says when it went only as its block says, and its row's mark goes as it's opened", async () => {
    const kept = new Map();
    vi.stubGlobal("localStorage", { getItem: (k) => kept.get(String(k)) ?? null, setItem: (k, v) => kept.set(String(k), String(v)), removeItem: (k) => kept.delete(String(k)), key: (i) => [...kept.keys()][i] ?? null, get length() { return kept.size; } });
    const seenLate = new Date(2026, 10, 18, 9, 12).getTime();
    const record = { hash: HASH, nodeUrl: NODE, kind: TX_KIND.TRANSFER, privacy: "public", to: "acct", amount: "10000000", profileIndex: 0, status: "executed", submittedAt: seenLate - 3_600_000, executedAt: seenLate, wentAfterAll: seenLate };
    const ov = { nodeUrl: NODE, txs: [record] };
    const state = { route: "tx", txDetailHash: HASH, txDetailFrom: "activity", addressBook: { loaded: true, items: [] } };
    expect(afterAllUnseen(activityRows(ov, state).find((row) => row.hash === HASH))).toBe(true);
    dom.document.body.replaceChildren(...txDetailsView(ov, { state, actions: { render: vi.fn(async () => {}), showToast: vi.fn() } }));
    // Said, with no time: its block gives none.
    const note = visibleText(dom.document.body.querySelector(".tx-hero-note"));
    expect(note).not.toBe("");
    expect(note).not.toMatch(/\d/);
    // Back in Activity, the overview not read again: no longer marked.
    state.afterAllOpen = null;
    expect(afterAllUnseen(activityRows(ov, state).find((row) => row.hash === HASH))).toBe(false);
  });

  it("shows a call's function as its memo would be: what reorders it as its code, and flagged", () => {
    const [rlo, pop] = ["‮", "‬"];
    const view = details({ kind: TX_KIND.CONTRACT_CALL, contractId: "ab".repeat(32), fnName: `pay${rlo}evol_ot${pop}`, status: "executed" });
    const method = view.body.querySelectorAll(".kv").find((row) => visibleText(row).includes("pay\\u202e"));
    expect(method.querySelector(".safe-text > span").textContent).toBe("pay\\u202eevol_ot\\u202c");
    expect(method.querySelector(".safe-text__flag")).not.toBeNull();
    expect(view.name).toContain("pay\\u202eevol_ot\\u202c");
    expect(visibleText(view.body)).not.toContain(rlo);
  });

  it("says what a migration paid on its own chain once that chain answers, its approval too, to the wei", async () => {
    // Nandini's: the extension showed no fee there at all for a way back.
    const MAINNET = "https://nodes.dusk.network";
    const route = routes(networks.mainnet).find((r) => r.id === "bsc-to-dusk");
    const chain = recordedEvm(route.chain.rpcUrl);
    vi.stubGlobal("fetch", chain.fetch);
    const { migration, payout } = recordedMigration;
    const tx = { hash: HASH, nodeUrl: MAINNET, status: "executed", kind: TX_KIND.TRANSFER, direction: "in", from: route.payoutAccount, amount: payout.value, memo: migration };
    const state = { route: "tx", txDetailHash: HASH, txDetailFrom: "home", addressBook: { loaded: true, items: [] } };
    const draw = () => {
      dom.document.body.replaceChildren(...txDetailsView({ nodeUrl: MAINNET, txs: [tx] }, { state, actions }));
      return dom.document.body.querySelectorAll(".tx-detail > .group > .kv").map(visibleText).join("\n");
    };
    const actions = { render: vi.fn(async () => draw()), showToast: vi.fn() };

    // Read from BNB Smart Chain's RPC once the details open: no fee until it answers.
    expect(draw()).not.toMatch(/\d BNB\b/);
    await vi.waitFor(() => expect(actions.render).toHaveBeenCalled());
    const rows = draw();
    // What the approval and the migration paid there, together.
    expect(rows).toMatch(/0\.00000474855 BNB/);
    expect(rows).toMatch(/1,041\.53106263 BEP20 DUSK/);
    expect(rows).toContain(`${migration.slice(0, 6)}…${migration.slice(-4)}`);
    // Asked again a minute on at most, not each time the details draw.
    const asked = chain.calls.length;
    draw();
    expect(chain.calls.length).toBe(asked);
  });

  it("says what a stake with Sozu got in stDUSK, to the lux, and what one stDUSK was worth, once the pool's event is read", async () => {
    // Lena's: the web wallet says it, and the extension said none.
    const { pool } = networks.testnet.sozu.fallbacks;
    const u64 = (n) => Array.from({ length: 8 }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, "0")).join("");
    // The pool's deposit event: amount, fee, stake and supply, then the account it names.
    const deposit = `${[100_000_000_000n, 250_000_000n, 2_000_000_000_000n, 1_000_000_000_000n].map(u64).join("")}01${"ab".repeat(193)}${"00".repeat(6)}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: { h0: { json: [{ origin: HASH, events: [{ target: pool, topic: "deposit", data: deposit }] }] } } }), { headers: { "content-type": "application/json" } }))
    );
    const draw = (hidden) => {
      const ov = { accounts: ["me".padEnd(64, "x")], isUnlocked: true, nodeUrl: NODE, selectedAccountIndex: 0, txs: [], hideBalances: hidden };
      const stake = entryOf({ hash: HASH, kind: "contract_call", contractId: pool, counterparty: pool, fnName: "sozu_stake", value: "100000000000", blockHeight: 4_700_000 });
      const state = { route: "tx", txDetailHash: HASH, addressBook: { loaded: true, items: [] }, activity: { entries: [stake], history: { fillDetails: vi.fn(async () => {}), needsDetails: vi.fn(() => false) }, key: activityKey(ov) } };
      const actions = { render: vi.fn(async () => paint()), showToast: vi.fn() };
      const paint = () => dom.document.body.replaceChildren(...txDetailsView(ov, { state, actions }));
      paint();
      return () => dom.document.body.querySelectorAll(".tx-detail > .group > .kv").map(visibleText).join("\n");
    };
    const rows = draw(false);
    await vi.waitFor(() => expect(rows()).toMatch(/49\.875 stDUSK/));
    expect(rows()).toMatch(/1 stDUSK = 2 DUSK/);
    // What it got hides with the balances; the rate says nothing of what's held.
    const hiddenRows = draw(true);
    await vi.waitFor(() => expect(hiddenRows()).toMatch(/•••• stDUSK/));
    expect(hiddenRows()).not.toMatch(/49\.875/);
    expect(hiddenRows()).toMatch(/1 stDUSK = 2 DUSK/);
  });

  it("takes a payout's memo of bytes for no migration, though it reads as one", () => {
    // Codex's: 32 bytes read as 0x and 64 hex digits.
    const MAINNET = "https://nodes.dusk.network";
    const route = routes(networks.mainnet).find((r) => r.id === "bsc-to-dusk");
    const ov = { accounts: ["me".padEnd(64, "x")], isUnlocked: true, nodeUrl: MAINNET, selectedAccountIndex: 0, txs: [] };
    // As the archive's history gives it: the memo's bytes as 0x hex, marked as bytes.
    const payout = (memoBinary) => entryOf({ counterparty: route.payoutAccount, direction: "in", hash: HASH, memo: `0x${"5e".repeat(32)}`, memoBinary, value: "5000000000" }, MAINNET);
    const rowsWith = (memoBinary) => {
      const state = { route: "tx", txDetailHash: HASH, addressBook: { loaded: true, items: [] }, activity: { entries: [payout(memoBinary)], history: { fillDetails: vi.fn(async () => {}), needsDetails: vi.fn(() => false) }, key: activityKey(ov) } };
      dom.document.body.replaceChildren(...txDetailsView(ov, { state, actions: {} }));
      return dom.document.body.querySelectorAll(".tx-detail > .group > .kv").map(visibleText).join("\n");
    };

    // Its memo, in full, and no migration's transaction.
    expect(rowsWith(true)).toContain(`0x${"5e".repeat(32)}`);
    expect(rowsWith(true)).not.toContain("0x5e5e…5e5e");
    // The same memo as text names the migration: its transaction there.
    expect(rowsWith(false)).toContain("0x5e5e…5e5e");
    expect(rowsWith(false)).not.toContain(`0x${"5e".repeat(32)}`);
  });

  it("shows no ledger for a bridge transfer the network dropped: it never ran", () => {
    const MAINNET = "https://nodes.dusk.network";
    const bsc = routes(networks.mainnet).find((r) => r.id === "dusk-to-bsc");
    const dropped = { hash: HASH, nodeUrl: MAINNET, status: "removed", kind: TX_KIND.TRANSFER, to: bsc.account, memo: "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F", amount: "3000000000", submittedAt: Date.now() - 60_000 };
    const state = { route: "tx", txDetailHash: HASH, txDetailFrom: "home", addressBook: { loaded: true, items: [] } };
    const ov = { nodeUrl: MAINNET, txs: [dropped] };
    dom.document.body.replaceChildren(...txDetailsView(ov, { state, actions: { render: vi.fn(async () => {}), showToast: vi.fn() } }));
    const body = dom.document.body;
    const rows = body.querySelectorAll(".tx-detail > .group > .kv").map(visibleText);
    // Its 3 DUSK stayed in the wallet.
    expect(visibleText(body.querySelector(".tx-hero-note"))).toMatch(/(?<![\d.,])3 DUSK/);
    // Nothing sent, taken by the bridge or to arrive.
    expect(amounts(rows)).toEqual([]);
    // No fee charged: its fee row has no amount.
    const fees = rows.filter((row) => /fee/i.test(row));
    expect(fees).toHaveLength(1);
    expect(fees[0]).not.toMatch(/[1-9]/);
  });

  it("follows DUSK bridged to BNB Smart Chain to its end: on its way, late, then what arrived and where", async () => {
    const MAINNET = "https://nodes.dusk.network";
    const bsc = routes(networks.mainnet).find((r) => r.id === "dusk-to-bsc");
    const evm = "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F";
    const payout = `0x${"7c".repeat(32)}`;
    const on = (tx) => {
      const ov = { nodeUrl: MAINNET, txs: [{ hash: HASH, nodeUrl: MAINNET, status: "executed", kind: TX_KIND.TRANSFER, to: bsc.account, memo: evm, amount: "3000000000", ...tx }] };
      const state = { route: "tx", txDetailHash: HASH, txDetailFrom: "home", addressBook: { loaded: true, items: [] } };
      dom.document.body.replaceChildren(...txDetailsView(ov, { state, actions: { render: vi.fn(async () => {}), showToast: vi.fn() } }));
      const body = dom.document.body;
      return {
        body,
        status: visibleText(body.querySelector(".tx-hero-status")),
        rows: body.querySelectorAll(".tx-detail > .group > .kv").map(visibleText),
      };
    };
    const completed = txStatusWord("executed");
    const sentAt = Date.now() - 60_000;

    const going = on({ finalizedAt: sentAt });
    // Sent, the bridge's fee, then what arrives, in that order, each exact.
    expect(amounts(going.rows)).toEqual(["3 DUSK", "1 DUSK", "2 BEP20 DUSK"]);

    const lateAt = Date.now() - 3 * bsc.typicalSeconds * 1000;
    const late = on({ finalizedAt: lateAt });

    const arrivedAt = sentAt + 30_000;
    keptArrivals().set(HASH, { hash: payout, at: arrivedAt });
    const arrived = on({ finalizedAt: sentAt });
    keptArrivals().delete(HASH);
    // On its way, late and arrived: each said as its own, none as a plain Completed.
    expect(new Set([going.status, late.status, arrived.status, completed]).size).toBe(4);
    // What arrived, and its transaction there, which opens that chain's explorer.
    expect(amounts(arrived.rows)).toEqual(["3 DUSK", "1 DUSK", "2 BEP20 DUSK"]);
    expect(arrived.rows.join("\n")).toContain(`${payout.slice(0, 6)}…${payout.slice(-4)}`);
    dom.window.open = vi.fn(() => ({}));
    for (const button of arrived.body.querySelectorAll(".tx-explorer-btn")) button.click();
    await settle();
    expect(dom.window.open).toHaveBeenCalledWith(`${networks.mainnet.routes.chains.bsc.explorerUrl}/tx/${payout}`, "_blank", expect.anything());

    // Past the week it's looked for, nothing says it's still on its way, or what it pays.
    const old = on({ finalizedAt: Date.now() - 8 * 86_400_000 });
    expect(old.status).toBe(completed);
    expect(amounts(old.rows)).toEqual(["3 DUSK", "1 DUSK"]);

    // Nothing can arrive from what the bridge doesn't pay: no more than its fee, no address, or one that failed.
    for (const tx of [{ amount: "1000000000" }, { memo: "" }]) {
      const none = on({ finalizedAt: sentAt, ...tx });
      expect(none.status).toBe(completed);
      expect(none.rows.join("\n")).not.toMatch(/BEP20 DUSK/);
    }
    const failed = on({ finalizedAt: sentAt, status: "failed" });
    expect(amounts(failed.rows)).toEqual([]);
  });

  it("says one transfer's amounts to the last lux, the network fee between what's sent and what arrives", () => {
    const MAINNET = "https://nodes.dusk.network";
    const bsc = routes(networks.mainnet).find((r) => r.id === "dusk-to-bsc");
    const evm = "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F";
    const on = (tx, { hidden = false } = {}) => {
      const ov = { nodeUrl: MAINNET, hideBalances: hidden, txs: [{ hash: HASH, nodeUrl: MAINNET, status: "executed", kind: TX_KIND.TRANSFER, finalizedAt: Date.now() - 60_000, ...tx }] };
      const state = { route: "tx", txDetailHash: HASH, txDetailFrom: "home", addressBook: { loaded: true, items: [] } };
      dom.document.body.replaceChildren(...txDetailsView(ov, { state, actions: { render: vi.fn(async () => {}), showToast: vi.fn() } }));
      return amounts(dom.document.body.querySelectorAll(".tx-detail > .group > .kv").map(visibleText));
    };
    // Sent, the bridge's fee, the network's, then what arrives.
    expect(on({ to: bsc.account, memo: evm, amount: "3190082082", feePaid: "1859281" })).toEqual(["3.190082082 DUSK", "1 DUSK", "0.001859281 DUSK", "2.190082082 BEP20 DUSK"]);
    // Hide balances hides them all.
    expect(on({ to: bsc.account, memo: evm, amount: "3190082082", feePaid: "1859281" }, { hidden: true })).toEqual(["•••• DUSK", "•••• DUSK", "•••• DUSK", "•••• BEP20 DUSK"]);
    // A transfer that's no bridge's has no such lines but its fee.
    expect(on({ to: evm.replace("0x", ""), amount: "3190082082", feePaid: "1859281" })).toEqual(["0.001859281 DUSK"]);
  });

  it("says a deposit to DuskEVM's amounts, what arrives until it has", () => {
    const bridge = duskEvmContracts(2).bridge;
    const evm = "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F";
    const deposit = { kind: TX_KIND.CONTRACT_CALL, contractId: bridge, fnName: "depositETHToWithValue", amount: "0", deposit: "500000001", bridgeTo: evm, status: "executed", feePaid: "2500000", finalizedAt: Date.now() - 60_000 };
    // Sent, the network's fee, then what arrives, or arrived.
    expect(amounts(details(deposit).rows)).toEqual(["0.500000001 DUSK", "0.0025 DUSK", "0.500000001 DUSK"]);
    keptArrivals().set(HASH, { hash: `0x${"7c".repeat(32)}`, at: Date.now() });
    expect(amounts(details(deposit).rows)).toEqual(["0.500000001 DUSK", "0.0025 DUSK", "0.500000001 DUSK"]);
    keptArrivals().delete(HASH);
    // Past the week it's looked for, what it paid stands alone.
    expect(amounts(details({ ...deposit, finalizedAt: Date.now() - 8 * 86_400_000 }).rows)).toEqual(["0.500000001 DUSK", "0.0025 DUSK"]);
  });

  it("shows the amount and the fee to the last lux, where a row shows them short", () => {
    const send = { kind: TX_KIND.TRANSFER, amount: "1000000000", status: "executed", feePaid: "1856398", gasSpent: "1856398", gasPrice: "1", gasLimit: "2500000" };
    const view = details(send);
    expect(view.rows.join("\n")).toMatch(/0\.001856398 DUSK/);
    // The gas it used of its limit, and its price.
    const tech = view.body.querySelectorAll(".tx-tech .kv").map(visibleText).join("\n");
    expect(tech).toMatch(/1,856,398\D+2,500,000/);
    expect(tech).toMatch(/(?<![\d.,])1 LUX/);

    const exact = details({ ...send, amount: "53082083", to: "26JfWKvhYdVY71bdSPVLNJ51Buy4GjimCT7zcsoxNQtydDbdoH2AwZaH8W7rjcAc9riAu39Vw9Lx1w7yrkBgotSjWmUdkSyQuaTKDZWVCKp9g1GxiEnnksv3W3onToB5NsNi" });
    expect(visibleText(exact.body.querySelector(".tx-hero-amount"))).toBe("−0.053082083 DUSK");
    // What a failure kept says so to the last lux too, hidden with balances.
    const failed = details({ ...send, amount: "53082083", status: "failed" });
    expect(failed.note).toMatch(/0\.053082083 DUSK/);
    // A token's amount, which a row cuts at 6 decimals.
    const token = details({
      kind: TX_KIND.CONTRACT_CALL,
      fnName: "transfer",
      contractId: "ab".repeat(32),
      amount: "0",
      status: "executed",
      asset: { type: "DRC20", op: "transfer", symbol: "TKN", decimals: 9, valueUnits: "1234567891", to: "26JfWKvhYdVY71bdSPVLNJ51Buy4GjimCT7zcsoxNQtydDbdoH2AwZaH8W7rjcAc9riAu39Vw9Lx1w7yrkBgotSjWmUdkSyQuaTKDZWVCKp9g1GxiEnnksv3W3onToB5NsNi" },
    });
    expect(visibleText(token.body.querySelector(".tx-hero-amount"))).toBe("−1.234567891 TKN");
    // Hidden with balances all the same.
    expect(visibleText(details({ ...send, amount: "53082083" }, { hidden: true }).body.querySelector(".tx-hero-amount"))).toBe("•••• DUSK");
  });

  it("names the site a transaction came from, and none for the wallet's own", () => {
    const send = { kind: TX_KIND.TRANSFER, amount: "1000000000", status: "executed" };
    const none = details(send).rows;
    // One row more, naming the site; one served over http, with its http.
    const shop = details({ ...send, origin: "https://shop.example" }).rows;
    expect(shop).toHaveLength(none.length + 1);
    expect(shop.join("\n")).toContain("shop.example");
    expect(details({ ...send, origin: "http://127.0.0.1:5354" }).rows.join("\n")).toContain("http://127.0.0.1:5354");
    expect(details({ ...send, origin: "Wallet" }).rows).toEqual(none);
  });

  // Astra's: a notice tapped after a switch opened its transaction where it isn't, the explorer on the wrong network.
  it("says where a transaction of another network, wallet or profile is, and opens it in its own network's explorer", async () => {
    // Where the transaction store lives outside the extension.
    const kept = new Map();
    vi.stubGlobal("localStorage", { getItem: (k) => kept.get(String(k)) ?? null, setItem: (k, v) => kept.set(String(k), String(v)), removeItem: (k) => kept.delete(String(k)) });
    const { putTxMeta } = await import("../shared/txStore.js");
    const A = "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
    const B = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
    const hash = "cd".repeat(32);
    await putTxMeta(hash, { walletId: A, nodeUrl: NODE, chainId: networks.testnet.chainId, profileIndex: 0, kind: TX_KIND.TRANSFER, status: "executed" });
    const wallets = [
      { key: "wa", n: 1, name: "", walletId: A, accounts: [A] },
      { key: "wb", n: 2, name: "Savings", walletId: B, accounts: [B] },
    ];
    dom.window.open = vi.fn(() => ({}));
    const shown = async (ov) => {
      const state = { route: "tx", txDetailHash: hash, txDetailFrom: "home" };
      const actions = { render: vi.fn(async () => {}) };
      dom.document.body.replaceChildren(...txDetailsView({ txs: [], wallets, ...ov }, { state, actions }));
      await vi.waitFor(() => expect(actions.render).toHaveBeenCalled());
      dom.document.body.replaceChildren(...txDetailsView({ txs: [], wallets, ...ov }, { state, actions }));
      const body = dom.document.body;
      body.querySelector(".tx-explorer-btn").click();
      await settle();
      return [visibleText(body.querySelector(".tx-missing")), dom.window.open.mock.lastCall?.[0]];
    };
    const { explorerTxUrl } = await import("../shared/explorer.js");
    const onTestnet = explorerTxUrl(NODE, hash);
    expect(onTestnet).toContain("testnet");
    // On Mainnet: on Testnet, both named.
    let [where, opened] = await shown({ nodeUrl: "https://nodes.dusk.network", accounts: [A] });
    expect([where, opened]).toEqual([expect.stringContaining("Testnet"), onTestnet]);
    expect(where).toContain("Mainnet");
    expect(await shown({ nodeUrl: NODE, accounts: [B], selectedAccountIndex: 0 })).toEqual([expect.stringContaining(walletLabel(wallets[0])), onTestnet]);
    expect(await shown({ nodeUrl: NODE, accounts: [A, B], selectedAccountIndex: 1 })).toEqual([expect.stringMatching(/profile/i), onTestnet]);

    // Its record gone once the history had it: the history it's kept in says,
    // under the key its writer keeps each network's under.
    kept.clear();
    const { activityOwnerKey, commitActivityStep } = await import("../shared/activityStore.js");
    const { activityNetworkKey } = await import("../shared/activityHistory.js");
    const inHistory = (nodeUrl, account, txHash) => commitActivityStep(activityOwnerKey(activityNetworkKey(nodeUrl), account), [{ hash: txHash, blockHeight: 7 }], () => ({ covered: [[0, 9]] }));
    await inHistory(NODE, B, hash);
    [where, opened] = await shown({ nodeUrl: "https://nodes.dusk.network", accounts: [A] });
    expect([where, opened]).toEqual([expect.stringContaining("Testnet"), onTestnet]);
    expect(where).toContain("Mainnet");
    expect(await shown({ nodeUrl: NODE, accounts: [A] })).toEqual([expect.stringContaining(walletLabel(wallets[1])), onTestnet]);
  });

  // Astra's: a node of one's own pinned to Testnet, then to Mainnet: an older send of
  // another wallet's opened on it went to Mainnet's explorer.
  it("keeps the chain a send's record says for a node that signs for another now", async () => {
    const CUSTOM = "https://my-node.example:8443";
    const A = "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
    const kept = new Map();
    vi.stubGlobal("localStorage", { getItem: (k) => kept.get(String(k)) ?? null, setItem: (k, v) => kept.set(String(k), String(v)), removeItem: (k) => kept.delete(String(k)) });
    const { noteChainId } = await import("../shared/nodeNetwork.js");
    const { putTxMeta } = await import("../shared/txStore.js");
    const { explorerTxUrl } = await import("../shared/explorer.js");
    const txHash = "7a".repeat(32);
    // Sent from another wallet while the node signed for Testnet.
    await putTxMeta(txHash, { walletId: "another wallet", nodeUrl: CUSTOM, chainId: networks.testnet.chainId, profileIndex: 0, kind: TX_KIND.TRANSFER, status: "executed" });
    const open = async (ov) => {
      dom.window.open = vi.fn(() => ({}));
      const state = { route: "tx", txDetailHash: txHash, txDetailFrom: "home" };
      const actions = { render: vi.fn(async () => {}) };
      dom.document.body.replaceChildren(...txDetailsView({ txs: [], accounts: [A], selectedAccountIndex: 0, ...ov }, { state, actions }));
      await vi.waitFor(() => expect(actions.render).toHaveBeenCalled());
      dom.document.body.replaceChildren(...txDetailsView({ txs: [], accounts: [A], selectedAccountIndex: 0, ...ov }, { state, actions }));
      dom.document.body.querySelector(".tx-explorer-btn").click();
      await settle();
      return [visibleText(dom.document.body.querySelector(".tx-missing")), dom.window.open.mock.lastCall?.[0]];
    };
    try {
      // On Testnet's own node, what the node signs for not known here: called by its own name.
      noteChainId(CUSTOM, null);
      let [where, opened] = await open({ nodeUrl: NODE });
      expect([where, opened]).toEqual([expect.stringContaining("my-node.example:8443"), explorerTxUrl(NODE, txHash)]);
      expect(where).toContain("Testnet");
      // It signs for Mainnet now: the chain its record says, never the one it signs for now.
      noteChainId(CUSTOM, networks.mainnet.chainId);
      [where, opened] = await open({ nodeUrl: CUSTOM, chainId: networks.mainnet.chainId });
      expect([where, opened]).toEqual([expect.stringContaining("Testnet"), explorerTxUrl(NODE, txHash)]);
      expect(where).toContain("my-node.example:8443");
      expect(where).not.toContain("Mainnet");
    } finally {
      noteChainId(CUSTOM, null);
    }
  });

  // Astra's: Devnet's and other nodes' histories are kept by the node's origin, not by name.
  it.each([
    ["Devnet", "https://devnet.nodes.dusk.network", "Devnet"],
    ["a node of its own", "https://my-node.example:8443", "my-node.example:8443"],
  ])("says where a transaction of %s is from its history, on that node and on another network", async (_, node, name) => {
    const A = "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
    const B = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
    const txHash = `${node.length % 10}f`.repeat(32);
    const { activityOwnerKey, commitActivityStep } = await import("../shared/activityStore.js");
    const { activityNetworkKey } = await import("../shared/activityHistory.js");
    const { explorerTxUrl } = await import("../shared/explorer.js");
    // Profile 2's history on that node.
    await commitActivityStep(activityOwnerKey(activityNetworkKey(node), B), [{ hash: txHash, blockHeight: 7 }], () => ({ covered: [[0, 9]] }));
    dom.window.open = vi.fn(() => ({}));
    const shown = async (ov) => {
      const state = { route: "tx", txDetailHash: txHash, txDetailFrom: "home" };
      const actions = { render: vi.fn(async () => {}) };
      dom.document.body.replaceChildren(...txDetailsView({ txs: [], accounts: [A, B], selectedAccountIndex: 0, ...ov }, { state, actions }));
      await vi.waitFor(() => expect(actions.render).toHaveBeenCalled());
      dom.document.body.replaceChildren(...txDetailsView({ txs: [], accounts: [A, B], selectedAccountIndex: 0, ...ov }, { state, actions }));
      const button = dom.document.body.querySelector(".tx-explorer-btn");
      dom.window.open.mockClear();
      button?.click();
      await settle();
      return [visibleText(dom.document.body.querySelector(".tx-missing")), dom.window.open.mock.lastCall?.[0] ?? null];
    };
    const explorer = explorerTxUrl(node, txHash);
    // On that node, Profile 1 open: Profile 2's, and its explorer, where the node has one.
    expect(await shown({ nodeUrl: node })).toEqual([expect.stringMatching(/profile/i), explorer]);
    // On Mainnet: that node's network, and Mainnet, named.
    const [elsewhere, opened] = await shown({ nodeUrl: "https://nodes.dusk.network" });
    expect([elsewhere, opened]).toEqual([expect.stringContaining(name), explorer]);
    expect(elsewhere).toContain("Mainnet");
  });

  it("shows a memo in the order it was written, its controls neutralized and flagged", () => {
    const [rlo, pop] = [0x202e, 0x202c].map((c) => String.fromCodePoint(c));
    const { body } = details({ kind: TX_KIND.TRANSFER, amount: "1000000000", status: "executed", memo: `invoice ${rlo}gnp.exe${pop}` });
    const memo = [...body.querySelectorAll(".kv")].find((row) => visibleText(row).includes("invoice"));
    expect(memo.querySelector(".safe-text > span").textContent).toBe("invoice \\u202egnp.exe\\u202c");
    expect(visibleText(memo)).not.toContain(rlo);
    expect(memo.querySelector(".safe-text__flag")?.textContent).toBeTruthy();
  });
});
