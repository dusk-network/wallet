import "fake-indexeddb/auto";
import { networks, routes } from "@dusk-network/networks";
import { duskEvmContracts } from "@dusk-network/networks/duskevm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keptArrivals } from "../shared/bridgeArrival.js";
import { TX_KIND } from "../shared/constants.js";
import { installFakeDom, settle, visibleText } from "./testing/fakeDom.js";
import { recordedEvm, recordedMigration } from "./testing/recordedEvm.js";
import { entryOf } from "../shared/fixtures/rows.js";
import { activityKey, activityRows } from "./popup/activity.js";
import { txDetailsView } from "./popup/views/txDetails.js";
import { afterAllUnseen } from "./popup/views/txRow.js";

// Times as a popup in UTC shows them.
process.env.TZ = "UTC";
const HASH = "ab".repeat(32);
const NODE = "https://testnet.nodes.dusk.network";
// Where each network's explorer shows a transaction, as its file says.
const TESTNET_TX = "https://explorer.testnet.dusk.network/transactions/transaction/?id=";
const MAINNET_TX = "https://explorer.dusk.network/transactions/transaction/?id=";
const DEVNET_TX = "https://explorer.devnet.dusk.network/transactions/transaction/?id=";
// The network fee's field, as a sent, a failed or a dropped transaction labels it.
const FEE = /^(network )?fee( charged)?$/i;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A figure exactly as written: not inside a longer number, not signed or bounded unless written so, and not followed by
// more digits, letters or a decimal part (1.0025 ≠ 11.0025, 0.005 ≠ −0.005, 2,000,000 ≠ 2,000,000.5, BNB ≠ BNBX).
const exactly = (text) => new RegExp(`(?<![\\d.,+\\-−<>≤≥~])${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\dA-Za-z]|[.,]\\d)`);
// Values in a sentence, in this order: where a transaction is, then where you are.
const inOrder = (...values) => new RegExp(values.map(escape).join("[\\s\\S]*"));
// The row of a field in a transaction's details, by its label.
const fieldRow = (root, label) => root.querySelectorAll(".kv").find((kv) => (typeof label === "string" ? visibleText(kv.querySelector(".kv-label")) === label : label.test(visibleText(kv.querySelector(".kv-label")))));
// Its fields as they read now: each label, with its value.
const fieldsOf = (root) => Object.fromEntries(root.querySelectorAll(".kv").map((kv) => [visibleText(kv.querySelector(".kv-label")), visibleText(kv.querySelector(".kv-value"))]));
const feeOf = (fields) => Object.entries(fields).find(([label]) => FEE.test(label))?.[1];
// Everything a screen gives away: all its text, shown or not, and each element's title and aria-label.
const everything = (root) => [root.textContent, ...[root, ...root.querySelectorAll("*")].flatMap((el) => [el.getAttribute("title"), el.getAttribute("aria-label")])].filter(Boolean).join("\n");
// The hero's status and its state: is-ok, is-pending, is-bad or is-neutral.
const statusOf = (root) => {
  const status = root.querySelector(".tx-hero-status");
  return { status: status ? visibleText(status) : "", tone: status?.className.split(" ").find((c) => c.startsWith("is-")) };
};
// How many explorer buttons there are, and what each opens, by the chain its label names: `chain`'s, else Dusk's.
const explorers = async (root, chain) => {
  const buttons = root.querySelectorAll(".tx-explorer-btn");
  const opened = {};
  for (const button of buttons) {
    dom.window.open = vi.fn(() => ({}));
    button.click();
    await settle();
    opened[visibleText(button).includes(chain) ? chain : "Dusk"] = dom.window.open.mock.calls;
  }
  return [buttons.length, opened];
};

let dom;

beforeEach(() => {
  dom = installFakeDom();
  // No test reaches a chain: one that reads one says what it answers.
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
});

afterEach(() => {
  vi.useRealTimers();
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
    ...statusOf(body),
    fields: fieldsOf(body),
    body,
  };
}

describe("a name read through a node the wallet doesn't know", () => {
  const CUSTOM = "https://my-node.example:8443";
  const OTHER = "z".repeat(90);
  const transfer = { kind: TX_KIND.TRANSFER, to: OTHER, amount: "1000000000", status: "executed" };

  it("says whose word it is in a transaction's details, and nothing on a network's own node or with no name", () => {
    const { note } = details({ ...transfer, nodeUrl: CUSTOM, toName: "bob.dusk" }, { own: { nodeUrl: CUSTOM } });
    // The node, by its name, and that the wallet doesn't know it.
    expect(note).toMatch(exactly("my-node.example:8443"));
    expect(note).toMatch(/doesn't know/i);
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
        note: body.querySelector(".tx-hero-note") ? visibleText(body.querySelector(".tx-hero-note")) : "",
        fee: feeOf(fieldsOf(body)),
        buttons: body.querySelectorAll(".tx-unsent-actions button"),
      };
    };
    let view = show({ ...stake, status: "unsent", signedTx: "ab12" });
    expect([view.status, view.buttons.length]).toEqual(["Not sent yet", 2]);
    // Nothing has left, never that it may have gone.
    expect(view.note).toMatch(/nothing has left/i);
    expect(view.note).not.toMatch(/may have gone/i);
    // No fee charged: its fee field has no amount.
    expect(view.fee).toBeTruthy();
    expect(view.fee).not.toMatch(/[1-9]/);
    expect(visibleText(view.body)).not.toContain("Pending");
    view.buttons[0].click();
    await settle();
    expect(actions.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_RESEND_TX", hash: HASH });
    expect(actions.render).toHaveBeenCalled();

    view = show({ ...stake, status: "unsent", signedTx: "ab12" });
    view.buttons[1].click();
    await settle();
    expect(actions.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_DROP_TX", hash: HASH });
    // Astra's: its hand-over had no clear answer, so it may still arrive; said so, never that nothing left.
    expect(actions.showToast.mock.lastCall[0]).toMatch(/still arrives/i);
    expect(actions.showToast.mock.lastCall[0]).not.toMatch(/nothing left/i);
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
    expect(actions.showToast.mock.lastCall[0]).toMatch(/may have gone out/i);
    expect(actions.showToast.mock.lastCall[0]).not.toMatch(/fail|couldn't|not sent/i);
    // Chosen not to be sent, and arrived after all: Completed, and said so; one that simply went says nothing.
    view = show({ ...stake, status: "executed", wentAfterAll: Date.now(), afterAllSeen: Date.now() });
    expect(view.status).toBe("Completed");
    expect(view.note).toMatch(/went out after/i);
    expect(show({ ...stake, status: "executed" }).note).toBe("");

    state.route = "tx";
    state.txDetailHash = HASH;
    view = show({ ...stake, status: "not_sent" });
    expect([view.status, view.buttons]).toEqual(["Not sent", []]);
    expect(view.note).toMatch(/took its place/i);
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
    expect(show()).toEqual(["Sent after you chose not to send", expect.stringMatching(exactly("20:41"))]);
    // Opened: it's kept as seen, and this look still says it.
    await vi.waitFor(async () => expect((await txs.getTxMeta(HASH))?.afterAllSeen).toEqual(expect.any(Number)));
    expect(show({ afterAllSeen: Date.now() })[0]).toBe("Sent after you chose not to send");
    // The next look: Completed, with what happened, and when, in its note.
    state.afterAllOpen = null;
    expect(show({ afterAllSeen: Date.now() })).toEqual(["Completed", expect.stringMatching(exactly("20:41"))]);
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
    expect(note).toMatch(/went out after/i);
    expect(note).not.toMatch(/\d/);
    // Back in Activity, the overview not read again: no longer marked.
    state.afterAllOpen = null;
    expect(afterAllUnseen(activityRows(ov, state).find((row) => row.hash === HASH))).toBe(false);
  });

  it("shows a call's function as its memo would be: what reorders it as its code, and flagged", () => {
    const [rlo, pop] = ["\u202e", "\u202c"];
    const view = details({ kind: TX_KIND.CONTRACT_CALL, contractId: "ab".repeat(32), fnName: `pay${rlo}evol_ot${pop}`, status: "executed" });
    const method = fieldRow(view.body, "Method");
    expect(method.querySelector(".safe-text > span").textContent).toBe("pay\\u202eevol_ot\\u202c");
    expect(method.querySelector(".safe-text__flag")).not.toBeNull();
    expect(view.name).toMatch(/(?:^|\s)pay\\u202eevol_ot\\u202c$/);
    expect(visibleText(view.body)).not.toContain(rlo);
  });

  it("says where a deposit to DuskEVM went, read from the call the wallet approved", async () => {
    const evm = "0x5A3d8e1B7c2f4A6b9e0D1C3f5A7b9C2D4e6F8a01";
    const deposit = {
      kind: TX_KIND.CONTRACT_CALL,
      contractId: duskEvmContracts(2).bridge,
      fnName: "depositETHToWithValue",
      amount: "0",
      deposit: "500000000",
      status: "executed",
    };
    const view = details({ ...deposit, bridgeTo: evm });
    // To the DuskEVM address, short where it's named; in full in its own field, the chain's own.
    expect(view.body.querySelector(".tx-hero-name .mono").textContent).toBe("0x5A3d…8a01");
    expect(view.body.querySelector(".tx-hero-addr")).toBeNull();
    const recipient = view.body.querySelector(".tx-evm-recipient");
    expect(visibleText(recipient.querySelector(".kv-label"))).toMatch(/^DuskEVM\b/);
    expect(visibleText(recipient.querySelector(".kv-value .mono"))).toBe(evm);
    // Each Copy beside it copies all of it.
    for (const copy of [view.body.querySelector(".tx-hero-name-line button"), recipient.querySelector("button")]) {
      dom.clipboard.writeText.mockClear();
      copy.click();
      await settle();
      expect(dom.clipboard.writeText).toHaveBeenCalledWith(evm);
    }
    // Without it, no recipient: no address it went to.
    const old = details(deposit);
    expect(old.body.querySelector(".tx-hero-addr")).toBeNull();
    expect(old.body.querySelector(".tx-hero-name .mono")).toBeNull();
    expect(old.body.querySelector(".tx-evm-recipient")).toBeNull();
  });

  it("says a deposit to DuskEVM Arrived once it's there, and opens its transaction on DuskEVM's explorer", async () => {
    const evm = "0x5A3d8e1B7c2f4A6b9e0D1C3f5A7b9C2D4e6F8a01";
    const l2 = "0x029e2c6ebfe60452800c97eaa2ac36f40039812679c9cee414ea6a8b1877d61b";
    const l2Url = `https://explorer.testnet.evm.dusk.network/tx/${l2}`;
    const deposit = {
      kind: TX_KIND.CONTRACT_CALL,
      contractId: duskEvmContracts(2).bridge,
      fnName: "depositETHToWithValue",
      amount: "0",
      deposit: "500000000",
      bridgeTo: evm,
      status: "executed",
    };
    const arrivedAt = Date.UTC(2026, 9, 27, 5, 52, 13);
    // Found there, and kept (bridgeArrival.js).
    keptArrivals().set(HASH, { hash: l2, at: arrivedAt });
    const view = details({ ...deposit, timestamp: arrivedAt - 60_000 });
    keptArrivals().delete(HASH);
    expect([view.status, view.tone]).toEqual(["Arrived", "is-ok"]);
    expect(view.status).not.toMatch(/not arrived/i);
    // When it arrived, under when it was sent.
    expect([view.fields.Date, view.fields.Arrived]).toEqual(["Tue 27 Oct 2026, 05:51 UTC", "Tue 27 Oct 2026, 05:52 UTC"]);
    // Its transaction there: opened on DuskEVM's explorer, and copied in full.
    const there = fieldRow(view.body, "DuskEVM transaction");
    expect(visibleText(there.querySelector(".tx-id"))).toBe("0x029e…d61b");
    dom.window.open = vi.fn(() => ({}));
    there.querySelector(".tx-id").click();
    await settle();
    expect(dom.window.open.mock.calls).toEqual([[l2Url, "_blank", "noopener,noreferrer"]]);
    there.querySelector(".mini-btn").click();
    await settle();
    expect(dom.clipboard.writeText).toHaveBeenLastCalledWith(l2);
    // And from its own button, beside Dusk's explorer's, which opens it on Dusk.
    expect(await explorers(view.body, "DuskEVM")).toEqual([
      2,
      { Dusk: [[`${TESTNET_TX}${HASH}`, "_blank", "noopener,noreferrer"]], DuskEVM: [[l2Url, "_blank", "noopener,noreferrer"]] },
    ]);
    // Its contract keeps the network's name for it under Technical details.
    expect(view.fields.Contract).toMatch(/^DuskEVM bridge(?!\w)/);

    // Not there yet: it went through, and nothing more.
    const onItsWay = details(deposit);
    expect(onItsWay.status).toBe("Completed");
    expect([onItsWay.fields.Arrived, onItsWay.fields["DuskEVM transaction"]]).toEqual([undefined, undefined]);
    expect(await explorers(onItsWay.body, "DuskEVM")).toEqual([1, { Dusk: [[`${TESTNET_TX}${HASH}`, "_blank", "noopener,noreferrer"]] }]);
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
      return fieldsOf(dom.document.body);
    };
    const actions = { render: vi.fn(async () => draw()), showToast: vi.fn() };
    const FEE_THERE = "Fee on BNB Smart Chain";

    // Read from BNB Smart Chain's RPC once the details open: no fee until it answers.
    expect(draw()[FEE_THERE]).toBeUndefined();
    await vi.waitFor(() => expect(actions.render).toHaveBeenCalled());
    const fields = draw();
    // What the approval and the migration paid there, together; and what was sent there.
    expect(fields[FEE_THERE]).toMatch(exactly("0.00000474855 BNB"));
    expect(fields.Sent).toBe("1,041.53106263 BEP20 DUSK");
    // The migration's transaction there, copied in full.
    const there = fieldRow(dom.document.body, "BNB Smart Chain transaction");
    expect(visibleText(there.querySelector(".tx-id"))).toBe(`${migration.slice(0, 6)}…${migration.slice(-4)}`);
    there.querySelector(".mini-btn").click();
    await settle();
    expect(dom.clipboard.writeText).toHaveBeenLastCalledWith(migration);
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
      return () => fieldsOf(dom.document.body);
    };
    const fields = draw(false);
    await vi.waitFor(() => expect(fields()["You got"]).toBe("49.875 stDUSK"));
    expect(fields().Rate).toBe("1 stDUSK = 2 DUSK");
    // What it got hides with the balances, anywhere; the rate says nothing of what's held.
    const hiddenFields = draw(true);
    await vi.waitFor(() => expect(hiddenFields()["You got"]).toBe("•••• stDUSK"));
    expect(everything(dom.document.body)).not.toMatch(exactly("49.875"));
    expect(hiddenFields().Rate).toBe("1 stDUSK = 2 DUSK");
  });

  it("takes a payout's memo of bytes for no migration, though it reads as one", () => {
    // Codex's: 32 bytes read as 0x and 64 hex digits.
    const MAINNET = "https://nodes.dusk.network";
    const route = routes(networks.mainnet).find((r) => r.id === "bsc-to-dusk");
    const ov = { accounts: ["me".padEnd(64, "x")], isUnlocked: true, nodeUrl: MAINNET, selectedAccountIndex: 0, txs: [] };
    // As the archive's history gives it: the memo's bytes as 0x hex, marked as bytes.
    const payout = (memoBinary) => entryOf({ counterparty: route.payoutAccount, direction: "in", hash: HASH, memo: `0x${"5e".repeat(32)}`, memoBinary, value: "5000000000" }, MAINNET);
    const fieldsWith = (memoBinary) => {
      const state = { route: "tx", txDetailHash: HASH, addressBook: { loaded: true, items: [] }, activity: { entries: [payout(memoBinary)], history: { fillDetails: vi.fn(async () => {}), needsDetails: vi.fn(() => false) }, key: activityKey(ov) } };
      dom.document.body.replaceChildren(...txDetailsView(ov, { state, actions: {} }));
      const fields = fieldsOf(dom.document.body);
      const there = fieldRow(dom.document.body, "BNB Smart Chain transaction");
      return [fields.Memo, there ? visibleText(there.querySelector(".tx-id")) : undefined];
    };

    // Its memo, in full, and no migration's transaction.
    expect(fieldsWith(true)).toEqual([`0x${"5e".repeat(32)}`, undefined]);
    // The same memo as text names the migration: its transaction there, and no memo.
    expect(fieldsWith(false)).toEqual([undefined, "0x5e5e…5e5e"]);
  });

  it("shows no ledger for a bridge transfer the network dropped: it never ran", () => {
    const MAINNET = "https://nodes.dusk.network";
    const bsc = routes(networks.mainnet).find((r) => r.id === "dusk-to-bsc");
    const dropped = { hash: HASH, nodeUrl: MAINNET, status: "removed", kind: TX_KIND.TRANSFER, to: bsc.account, memo: "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F", amount: "3000000000", submittedAt: Date.now() - 60_000 };
    const state = { route: "tx", txDetailHash: HASH, txDetailFrom: "home", addressBook: { loaded: true, items: [] } };
    const ov = { nodeUrl: MAINNET, txs: [dropped] };
    dom.document.body.replaceChildren(...txDetailsView(ov, { state, actions: { render: vi.fn(async () => {}), showToast: vi.fn() } }));
    const body = dom.document.body;
    const fields = fieldsOf(body);
    expect(statusOf(body).status).toBe("Dropped");
    // Its 3 DUSK stayed in the wallet.
    const note = visibleText(body.querySelector(".tx-hero-note"));
    expect(note).toMatch(exactly("3 DUSK"));
    expect(note).toMatch(/stayed/i);
    // Nothing sent, taken by the bridge or to arrive.
    expect(["Sent", "Bridge fee", "You receive", "Received"].filter((label) => label in fields)).toEqual([]);
    // No fee charged: its fee field has no amount.
    expect(feeOf(fields)).toBeTruthy();
    expect(feeOf(fields)).not.toMatch(/[1-9]/);
  });

  it("follows DUSK bridged to BNB Smart Chain to its end: on its way, late, then what arrived and where", async () => {
    // Noon on 20 November 2026.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 10, 20, 12, 0, 0));
    const MAINNET = "https://nodes.dusk.network";
    const bsc = routes(networks.mainnet).find((r) => r.id === "dusk-to-bsc");
    const evm = "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F";
    const payout = `0x${"7c".repeat(32)}`;
    const payoutUrl = `https://bscscan.com/tx/${payout}`;
    const on = (tx) => {
      const ov = { nodeUrl: MAINNET, txs: [{ hash: HASH, nodeUrl: MAINNET, status: "executed", kind: TX_KIND.TRANSFER, to: bsc.account, memo: evm, amount: "3000000000", ...tx }] };
      const state = { route: "tx", txDetailHash: HASH, txDetailFrom: "home", addressBook: { loaded: true, items: [] } };
      dom.document.body.replaceChildren(...txDetailsView(ov, { state, actions: { render: vi.fn(async () => {}), showToast: vi.fn() } }));
      const body = dom.document.body;
      return { body, ...statusOf(body), fields: fieldsOf(body) };
    };
    // Its amounts: what was sent, the bridge's fee, and what arrives or arrived.
    const ledger = ({ fields }) => [fields.Sent, fields["Bridge fee"], fields["You receive"], fields.Received];
    const sentAt = Date.now() - 60_000;

    const going = on({ finalizedAt: sentAt });
    expect([going.status, going.tone]).toEqual(["On its way", "is-pending"]);
    expect(ledger(going)).toEqual(["3 DUSK", "1 DUSK", "2 BEP20 DUSK", undefined]);

    const late = on({ finalizedAt: Date.now() - 3 * bsc.typicalSeconds * 1000 });
    expect([late.status, late.tone]).toEqual(["Taking longer than usual", "is-pending"]);

    const arrivedAt = sentAt + 30_000;
    keptArrivals().set(HASH, { hash: payout, at: arrivedAt });
    const arrived = on({ finalizedAt: sentAt });
    keptArrivals().delete(HASH);
    expect([arrived.status, arrived.tone]).toEqual(["Arrived", "is-ok"]);
    expect(arrived.status).not.toMatch(/not arrived/i);
    // What was sent and the bridge's fee as before, what arrived no longer to come, and when.
    expect(ledger(arrived)).toEqual(["3 DUSK", "1 DUSK", undefined, "2 BEP20 DUSK"]);
    expect(arrived.fields.Arrived).toBe("Fri 20 Nov 2026, 11:59 UTC");
    // Where: its transaction there, opened there from its field and from its own button; Dusk's button opens Dusk's.
    const there = fieldRow(arrived.body, "BNB Smart Chain transaction");
    expect(visibleText(there.querySelector(".tx-id"))).toBe(`${payout.slice(0, 6)}…${payout.slice(-4)}`);
    dom.window.open = vi.fn(() => ({}));
    there.querySelector(".tx-id").click();
    await settle();
    expect(dom.window.open.mock.calls).toEqual([[payoutUrl, "_blank", "noopener,noreferrer"]]);
    expect(await explorers(arrived.body, "BNB Smart Chain")).toEqual([
      2,
      { Dusk: [[`${MAINNET_TX}${HASH}`, "_blank", "noopener,noreferrer"]], "BNB Smart Chain": [[payoutUrl, "_blank", "noopener,noreferrer"]] },
    ]);

    // Past the week it's looked for, nothing says it's still on its way, or what it pays.
    const old = on({ finalizedAt: Date.now() - 8 * 86_400_000 });
    expect(old.status).toBe("Completed");
    expect(ledger(old)).toEqual(["3 DUSK", "1 DUSK", undefined, undefined]);

    // Nothing can arrive from what the bridge doesn't pay: no more than its fee, no address, or one that failed.
    for (const tx of [{ amount: "1000000000" }, { memo: "" }]) {
      const none = on({ finalizedAt: sentAt, ...tx });
      expect(none.status).toBe("Completed");
      expect(none.fields["You receive"]).toBeUndefined();
    }
    const failed = on({ finalizedAt: sentAt, status: "failed" });
    expect(failed.status).toBe("Failed");
    expect(ledger(failed)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("says one transfer's amounts to the last lux, the network fee between what's sent and what arrives", () => {
    const MAINNET = "https://nodes.dusk.network";
    const bsc = routes(networks.mainnet).find((r) => r.id === "dusk-to-bsc");
    const evm = "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F";
    const on = (tx, { hidden = false } = {}) => {
      const ov = { nodeUrl: MAINNET, hideBalances: hidden, txs: [{ hash: HASH, nodeUrl: MAINNET, status: "executed", kind: TX_KIND.TRANSFER, finalizedAt: Date.now() - 60_000, ...tx }] };
      const state = { route: "tx", txDetailHash: HASH, txDetailFrom: "home", addressBook: { loaded: true, items: [] } };
      dom.document.body.replaceChildren(...txDetailsView(ov, { state, actions: { render: vi.fn(async () => {}), showToast: vi.fn() } }));
      const fields = fieldsOf(dom.document.body);
      return [fields.Sent, fields["Bridge fee"], feeOf(fields), fields["You receive"]];
    };
    const bridged = { to: bsc.account, memo: evm, amount: "3190082082", feePaid: "1859281" };
    // Sent, the bridge's fee, the network's, then what arrives.
    expect(on(bridged)).toEqual(["3.190082082 DUSK", "1 DUSK", "0.001859281 DUSK", "2.190082082 BEP20 DUSK"]);
    // Hide balances hides them all, anywhere.
    expect(on(bridged, { hidden: true })).toEqual(["•••• DUSK", "•••• DUSK", "•••• DUSK", "•••• BEP20 DUSK"]);
    for (const figure of ["3.190082082", "0.001859281", "2.190082082"]) expect(everything(dom.document.body)).not.toMatch(exactly(figure));
    // A transfer that's no bridge's has no such fields but its fee.
    expect(on({ to: evm.replace("0x", ""), amount: "3190082082", feePaid: "1859281" })).toEqual([undefined, undefined, "0.001859281 DUSK", undefined]);
  });

  it("says a deposit to DuskEVM's amounts, what arrives until it has", () => {
    const bridge = duskEvmContracts(2).bridge;
    const evm = "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F";
    const deposit = { kind: TX_KIND.CONTRACT_CALL, contractId: bridge, fnName: "depositETHToWithValue", amount: "0", deposit: "500000001", bridgeTo: evm, status: "executed", feePaid: "2500000", finalizedAt: Date.now() - 60_000 };
    const ledger = ({ fields }) => [fields.Sent, feeOf(fields), fields["You receive"], fields.Received];
    expect(ledger(details(deposit))).toEqual(["0.500000001 DUSK", "0.0025 DUSK", "0.500000001 DUSK", undefined]);
    keptArrivals().set(HASH, { hash: `0x${"7c".repeat(32)}`, at: Date.now() });
    expect(ledger(details(deposit))).toEqual(["0.500000001 DUSK", "0.0025 DUSK", undefined, "0.500000001 DUSK"]);
    keptArrivals().delete(HASH);
    // Past the week it's looked for, what it paid stands alone.
    expect(ledger(details({ ...deposit, finalizedAt: Date.now() - 8 * 86_400_000 }))).toEqual(["0.500000001 DUSK", "0.0025 DUSK", undefined, undefined]);
  });

  it("shows the amount and the fee to the last lux, where a row shows them short", () => {
    const send = { kind: TX_KIND.TRANSFER, amount: "1000000000", status: "executed", feePaid: "1856398", gasSpent: "1856398", gasPrice: "1", gasLimit: "2500000" };
    const view = details(send);
    expect(feeOf(view.fields)).toBe("0.001856398 DUSK");
    // The gas it used of its limit, and its price.
    expect(view.fields["Gas used"]).toMatch(/^1,856,398\D+2,500,000$/);
    expect(view.fields["Gas price"]).toBe("1 LUX");

    const exact = details({ ...send, amount: "53082083", to: "26JfWKvhYdVY71bdSPVLNJ51Buy4GjimCT7zcsoxNQtydDbdoH2AwZaH8W7rjcAc9riAu39Vw9Lx1w7yrkBgotSjWmUdkSyQuaTKDZWVCKp9g1GxiEnnksv3W3onToB5NsNi" });
    expect(visibleText(exact.body.querySelector(".tx-hero-amount"))).toBe("−0.053082083 DUSK");
    // What a failure kept says so to the last lux too, hidden with balances.
    const failed = details({ ...send, amount: "53082083", status: "failed" });
    expect(failed.note).toMatch(exactly("0.053082083 DUSK"));
    expect(failed.note).toMatch(/stayed/i);
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

  it("hides the gas used with Hide balances, as the fee can be worked out from it", () => {
    const view = details({ kind: TX_KIND.TRANSFER, amount: "1000000000", status: "executed", feePaid: "1856398", gasSpent: "1856398", gasPrice: "1", gasLimit: "2500000" }, { hidden: true });
    expect([view.fields["Gas used"], feeOf(view.fields)]).toEqual(["••••", "•••• DUSK"]);
    // Nor anywhere else: not in a tooltip, nor to a screen reader.
    for (const figure of ["1,856,398", "1856398", "0.001856398"]) expect(everything(view.body)).not.toMatch(exactly(figure));
  });

  it("names the site a transaction came from, and none for the wallet's own", () => {
    const send = { kind: TX_KIND.TRANSFER, amount: "1000000000", status: "executed" };
    expect(details({ ...send, origin: "https://shop.example" }).fields.Site).toBe("shop.example");
    // One served over http, with its http.
    expect(details({ ...send, origin: "http://127.0.0.1:5354" }).fields.Site).toBe("http://127.0.0.1:5354");
    for (const origin of ["Wallet", undefined]) {
      expect(details({ ...send, origin }).fields.Site, String(origin)).toBeUndefined();
    }
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
    const onTestnet = `${TESTNET_TX}${hash}`;
    // Where it is, then where you are.
    expect(await shown({ nodeUrl: "https://nodes.dusk.network", accounts: [A] })).toEqual([expect.stringMatching(inOrder("Testnet", "Mainnet")), onTestnet]);
    expect(await shown({ nodeUrl: NODE, accounts: [B], selectedAccountIndex: 0 })).toEqual([expect.stringMatching(exactly("Wallet 1")), onTestnet]);
    expect(await shown({ nodeUrl: NODE, accounts: [A, B], selectedAccountIndex: 1 })).toEqual([expect.stringMatching(/another profile/i), onTestnet]);

    // Its record gone once the history had it: the history it's kept in says,
    // under the key its writer keeps each network's under.
    kept.clear();
    const { activityOwnerKey, commitActivityStep } = await import("../shared/activityStore.js");
    const { activityNetworkKey } = await import("../shared/activityHistory.js");
    const inHistory = (nodeUrl, account, txHash) => commitActivityStep(activityOwnerKey(activityNetworkKey(nodeUrl), account), [{ hash: txHash, blockHeight: 7 }], () => ({ covered: [[0, 9]] }));
    await inHistory(NODE, B, hash);
    expect(await shown({ nodeUrl: "https://nodes.dusk.network", accounts: [A] })).toEqual([expect.stringMatching(inOrder("Testnet", "Mainnet")), onTestnet]);
    expect(await shown({ nodeUrl: NODE, accounts: [A] })).toEqual([expect.stringMatching(exactly("Savings")), onTestnet]);
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
      expect(await open({ nodeUrl: NODE })).toEqual([expect.stringMatching(inOrder("my-node.example:8443", "Testnet")), `${TESTNET_TX}${txHash}`]);
      // It signs for Mainnet now: the chain its record says, never the one it signs for now.
      noteChainId(CUSTOM, networks.mainnet.chainId);
      const [where, opened] = await open({ nodeUrl: CUSTOM, chainId: networks.mainnet.chainId });
      expect([where, opened]).toEqual([expect.stringMatching(inOrder("Testnet", "my-node.example:8443")), `${TESTNET_TX}${txHash}`]);
      expect(where).not.toContain("Mainnet");
    } finally {
      noteChainId(CUSTOM, null);
    }
  });

  // Astra's: Devnet's and other nodes' histories are kept by the node's origin, not by name.
  it.each([
    ["Devnet", "https://devnet.nodes.dusk.network", "Devnet", DEVNET_TX],
    ["a node of its own", "https://my-node.example:8443", "my-node.example:8443", null],
  ])("says where a transaction of %s is from its history, on that node and on another network", async (_, node, name, explorerTx) => {
    const A = "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
    const B = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
    const txHash = `${node.length % 10}f`.repeat(32);
    const { activityOwnerKey, commitActivityStep } = await import("../shared/activityStore.js");
    const { activityNetworkKey } = await import("../shared/activityHistory.js");
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
    // Its explorer, where its node has one.
    const explorer = explorerTx ? `${explorerTx}${txHash}` : null;
    // On that node, Profile 1 open: Profile 2's.
    expect(await shown({ nodeUrl: node })).toEqual([expect.stringMatching(/another profile/i), explorer]);
    // On Mainnet: that node's network, then Mainnet.
    expect(await shown({ nodeUrl: "https://nodes.dusk.network" })).toEqual([expect.stringMatching(inOrder(name, "Mainnet")), explorer]);
  });

  it("shows a memo in the order it was written, its controls neutralized and flagged", () => {
    const [rlo, pop] = [0x202e, 0x202c].map((c) => String.fromCodePoint(c));
    const { body } = details({ kind: TX_KIND.TRANSFER, amount: "1000000000", status: "executed", memo: `invoice ${rlo}gnp.exe${pop}` });
    const memo = fieldRow(body, "Memo");
    expect(memo.querySelector(".safe-text > span").textContent).toBe("invoice \\u202egnp.exe\\u202c");
    expect(visibleText(memo)).not.toContain(rlo);
    expect(memo.querySelector(".safe-text__flag")?.textContent).toBeTruthy();
  });
});
