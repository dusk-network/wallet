import "fake-indexeddb/auto";
import { networks, routes } from "@dusk-network/networks";
import { duskEvmContracts } from "@dusk-network/networks/duskevm";
import { PINNED_RELEASES as releases } from "@duskdomains/sdk/releases";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keptArrivals } from "../shared/bridgeArrival.js";
import { TX_KIND } from "../shared/constants.js";
import { installFakeDom, settle, visibleText } from "./testing/fakeDom.js";
import { recordedEvm, recordedMigration } from "./testing/recordedEvm.js";
import { entryOf } from "../shared/fixtures/rows.js";
import { activityKey } from "./popup/activity.js";
import { dateText } from "./lib/time.js";
import { txDetailsView } from "./popup/views/txDetails.js";

const HASH = "ab".repeat(32);
const NODE = "https://testnet.nodes.dusk.network";

let dom;

beforeEach(() => {
  dom = installFakeDom();
  // No test reaches a chain: one that reads one says what it answers.
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Renders a transaction's details as the popup does, the wallet's other records beside it.
function details(tx, { contacts = [], others = [], hidden = false, own = {} } = {}) {
  const state = { route: "tx", txDetailHash: HASH, txDetailFrom: "home", addressBook: { loaded: true, items: contacts } };
  const actions = { render: vi.fn(async () => {}), showToast: vi.fn() };
  const ov = { nodeUrl: NODE, hideBalances: hidden, txs: [{ hash: HASH, nodeUrl: NODE, ...tx }, ...others], ...own };
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

describe("a name read through a node the wallet doesn't know", () => {
  const CUSTOM = "https://my-node.example:8443";
  const NOTE = "Checked by my-node.example:8443, a node the wallet doesn't know. Check the address too.";
  const OTHER = "z".repeat(90);
  const transfer = { kind: TX_KIND.TRANSFER, to: OTHER, amount: "1000000000", status: "executed" };

  it("says whose word it is in a transaction's details, and nothing on a network's own node or with no name", () => {
    expect(details({ ...transfer, nodeUrl: CUSTOM, toName: "bob.dusk" }, { own: { nodeUrl: CUSTOM } }).note).toBe(NOTE);
    expect(details({ ...transfer, toName: "bob.dusk" }).note).toBe("");
    expect(details({ ...transfer, nodeUrl: CUSTOM }, { own: { nodeUrl: CUSTOM } }).note).toBe("");
  });
});

describe("transaction details", () => {
  it("name your other profile by its public account or shielded address, with the short address and Copy under it", () => {
    const account = "z".repeat(60);
    const address = "s".repeat(90);
    const own = { accounts: ["me", account], addresses: ["mine", address], accountNames: { 1: "Savings" } };
    let view = details({ kind: TX_KIND.TRANSFER, amount: "1000000000", direction: "out", to: account, status: "executed" }, { own });
    expect(view.name).toBe("Savings");
    expect(visibleText(view.body.querySelector(".tx-hero-addr"))).toContain("zzzzzz…zzzzzz");
    view = details({ kind: TX_KIND.TRANSFER, amount: "1000000000", direction: "out", privacy: "shielded", to: address, status: "executed" }, { own });
    expect(view.name).toBe("Savings");
  });

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
    // Lena's, offline: no "about 10 seconds" while nothing can come.
    vi.stubGlobal("navigator", { ...globalThis.navigator, onLine: false });
    view = details({ ...shield, status: "submitted" });
    expect([view.status, view.note]).toEqual(["Pending", "No connection. It's looked up again once you're back online."]);
    vi.stubGlobal("navigator", { ...globalThis.navigator, onLine: true });
    // Completed says it all.
    view = details({ ...shield, status: "executed" });
    expect([view.status, view.note]).toEqual(["Completed", ""]);
  });

  // Lena's: "Why: watcher_unavailable".
  it("says in words why the wallet stopped waiting, never its watcher's code", () => {
    const sent = { kind: TX_KIND.TRANSFER, privacy: "public", to: "acct", amount: "1000000000", profileIndex: 0, status: "unknown" };
    for (const [recoveryReason, words] of [
      ["watcher_unavailable", "The wallet lost its connection to the network while it waited. It looks it up again once it's back."],
      ["handover_unclear", "The connection went as it was sent. The wallet looks it up by its ID."],
    ]) {
      const { body } = details({ ...sent, recoveryReason });
      const text = visibleText(body);
      expect(text).toContain(words);
      expect(text).not.toContain(recoveryReason);
    }
  });

  it("names the contract a call went to under Technical details only, with Copy, and offers no Add token or Import NFT", async () => {
    const contractId = "cd".repeat(32);
    const view = details({
      kind: TX_KIND.CONTRACT_CALL,
      contractId: `0x${contractId}`,
      fnName: "transfer",
      status: "executed",
    });
    expect(view.name).toBe("Call transfer");
    expect(view.body.querySelector(".tx-hero-addr")).toBeNull();
    const contract = view.body.querySelectorAll(".tx-tech .kv").find((row) => row.querySelector(".kv-label").textContent === "Contract");
    // As every Dusk app writes a contract ID: without 0x.
    expect(visibleText(contract)).toBe("Contractcdcdcd…cdcdcd");
    const copy = contract.querySelector("button");
    expect(copy.getAttribute("aria-label")).toBe("Copy contract ID");
    copy.click();
    await settle();
    expect(dom.clipboard.writeText).toHaveBeenCalledWith(contractId);
    expect(view.body.querySelector(".tx-assets")).toBeNull();
    expect(view.body.querySelectorAll("button").map((b) => b.textContent)).not.toEqual(expect.arrayContaining(["Add token"]));
    expect(view.body.querySelectorAll("button").map((b) => b.textContent)).not.toEqual(expect.arrayContaining(["Import NFT"]));
  });

  it("names a call's contract as the network's file does, in the title and beside its ID", () => {
    const { pool } = networks.testnet.sozu.fallbacks;
    const view = details({ kind: TX_KIND.CONTRACT_CALL, contractId: pool, fnName: "exchange_rate", status: "executed" });
    expect([visibleText(view.lead), view.name]).toEqual(["Sozu pool", "Call exchange_rate"]);
    const contract = view.body.querySelectorAll(".tx-tech .kv").find((row) => row.querySelector(".kv-label").textContent === "Contract");
    expect(visibleText(contract)).toBe(`ContractSozu pool · ${pool.slice(0, 6)}…${pool.slice(-6)}`);
    // The "·" stays with the short ID and its Copy, which never break apart.
    const id = contract.querySelector(".contract-id");
    expect([visibleText(id), Boolean(id.querySelector("button.copy-ico"))]).toEqual([`· ${pool.slice(0, 6)}…${pool.slice(-6)}`, true]);
  });

  it("shows a call's function as its memo would be: what reorders it as its code, and flagged", () => {
    const [rlo, pop] = ["\u202e", "\u202c"];
    const view = details({ kind: TX_KIND.CONTRACT_CALL, contractId: "ab".repeat(32), fnName: `pay${rlo}evol_ot${pop}`, status: "executed" });
    const method = view.body.querySelectorAll(".kv").find((row) => row.querySelector(".kv-label").textContent === "Method");
    expect(method.querySelector(".safe-text > span").textContent).toBe("pay\\u202eevol_ot\\u202c");
    expect(method.querySelector(".safe-text__flag")).not.toBeNull();
    expect(view.name).toBe("Call pay\\u202eevol_ot\\u202c");
    expect(visibleText(view.body)).not.toContain(rlo);
  });

  it("says what a Dusk Domains call did, on its own network", () => {
    // The testnet release's store contract, where names are registered.
    const STORE = releases.testnet.contracts.find((c) => c.role === "store").contractId;
    const register = details({ kind: TX_KIND.CONTRACT_CALL, contractId: STORE, fnName: "register", deposit: "10000000000", status: "executed" });
    expect([visibleText(register.lead), register.name]).toEqual(["Dusk Domains", "Registered a .dusk name"]);
    expect(visibleText(register.body.querySelector(".tx-hero-amount"))).toBe("−10 DUSK");
    // By the name it registered, once read; its contract under Technical details alone.
    const named = details({ kind: TX_KIND.CONTRACT_CALL, contractId: STORE, fnName: "register", registeredName: "alice.dusk", status: "executed" });
    expect([named.name, named.body.querySelector(".tx-hero-addr")]).toEqual(["Registered alice.dusk", null]);
    // Its contract named as the explorer names it.
    const contract = named.body.querySelectorAll(".tx-tech .kv").map(visibleText).find((r) => r.startsWith("Contract"));
    expect(contract).toBe(`ContractDusk Domains · ${STORE.slice(0, 6)}…${STORE.slice(-6)}`);
    // A reservation: step 1 of 2, until a registration that reveals it follows.
    const commit = { kind: TX_KIND.CONTRACT_CALL, contractId: STORE, fnName: "commit", status: "executed" };
    expect(details(commit).name).toBe("Name reservation (step 1 of 2)");
    const reservation = "1f".repeat(32);
    const registration = { hash: "cd".repeat(32), nodeUrl: NODE, kind: TX_KIND.CONTRACT_CALL, contractId: STORE, fnName: "register", registeredName: "alice.dusk", reservation, status: "executed", submittedAt: 2 };
    expect(details({ ...commit, reservation, submittedAt: 1 }, { others: [registration] }).name).toBe("Reserved alice.dusk");
    // The same contract ID through a custom node is any contract.
    const ov = { nodeUrl: "https://node.example", txs: [{ hash: HASH, nodeUrl: "https://node.example", kind: TX_KIND.CONTRACT_CALL, contractId: STORE, fnName: "register", status: "executed" }] };
    dom.document.body.replaceChildren(...txDetailsView(ov, { state: { route: "tx", txDetailHash: HASH, addressBook: { loaded: true, items: [] } }, actions: {} }));
    expect(visibleText(dom.document.body.querySelector(".tx-hero-name"))).toBe("Call register");
  });

  it("says where a deposit to DuskEVM went, read from the call the wallet approved", () => {
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
    // "To" the DuskEVM address, Copy beside it, and in full with Copy in the rows.
    expect([visibleText(view.lead), view.name]).toEqual(["Bridge to DuskEVM", "To 0x5A3d…8a01"]);
    expect(view.body.querySelector(".tx-hero-name .mono").textContent).toBe("0x5A3d…8a01");
    expect(view.body.querySelector(".tx-hero-name").getAttribute("title")).toBe(evm);
    expect(view.body.querySelector(".tx-hero-name-line button").getAttribute("aria-label")).toBe("Copy DuskEVM address");
    expect(view.body.querySelector(".tx-hero-addr")).toBeNull();
    expect(view.rows).toContain(`DuskEVM recipient${evm}Copy`);
    expect(view.body.querySelector(".tx-evm-recipient button").getAttribute("aria-label")).toBe("Copy DuskEVM address");
    // Without it, no recipient row; the bridge's contract is under Technical details.
    const old = details(deposit);
    expect(old.body.querySelector(".tx-hero-addr")).toBeNull();
    expect(old.rows.filter((r) => r.startsWith("DuskEVM recipient"))).toEqual([]);
  });

  it("says a deposit to DuskEVM Arrived once it's there, and opens its transaction on DuskEVM's explorer", async () => {
    const evm = "0x5A3d8e1B7c2f4A6b9e0D1C3f5A7b9C2D4e6F8a01";
    const l2 = "0x029e2c6ebfe60452800c97eaa2ac36f40039812679c9cee414ea6a8b1877d61b";
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
    expect(view.status).toBe("Arrived");
    // When it arrived, under when it was sent.
    expect(view.rows.slice(0, 2)).toEqual([`Date${dateText(arrivedAt - 60_000)}`, `Arrived${dateText(arrivedAt)}`]);
    expect(view.rows.at(-1)).toBe("DuskEVM transaction0x029e…d61bCopy");
    dom.window.open = vi.fn(() => ({}));
    view.body.querySelectorAll("button").find((b) => b.textContent === "0x029e…d61b").click();
    await settle();
    expect(dom.window.open).toHaveBeenCalledWith(`${networks.testnet.duskEvm.explorerUrl}/tx/${l2}`, "_blank", "noopener,noreferrer");
    // And from its own button, beside Dusk's explorer.
    const buttons = view.body.querySelectorAll(".tx-explorer-btn");
    expect(buttons.map(visibleText)).toEqual(["View in Dusk explorer", "View in DuskEVM explorer"]);
    dom.window.open.mockClear();
    buttons[1].click();
    await settle();
    expect(dom.window.open).toHaveBeenCalledWith(`${networks.testnet.duskEvm.explorerUrl}/tx/${l2}`, "_blank", "noopener,noreferrer");
    // Its contract keeps the network's name for it under Technical details.
    expect(view.body.querySelectorAll(".tx-tech .kv").map(visibleText).find((r) => r.startsWith("Contract"))).toMatch(/^ContractDuskEVM bridge · /);

    // On its way, it went through: nothing more.
    const onItsWay = details(deposit);
    expect([onItsWay.status, onItsWay.rows.some((r) => r.startsWith("DuskEVM transaction") || r.startsWith("Arrived"))]).toEqual(["Completed", false]);
    expect(onItsWay.body.querySelectorAll(".tx-explorer-btn").map(visibleText)).toEqual(["View in Dusk explorer"]);
  });

  it("names DUSK bridged to BNB Smart Chain and back from Ethereum by their routes, with the bridge's account each went through", () => {
    const MAINNET = "https://nodes.dusk.network";
    const route = (id) => routes(networks.mainnet).find((r) => r.id === id);
    const bsc = route("dusk-to-bsc").account;
    const payouts = route("ethereum-to-dusk").payoutAccount;
    const evm = "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F";
    const on = (tx) => {
      const ov = { nodeUrl: MAINNET, txs: [{ hash: HASH, nodeUrl: MAINNET, status: "executed", ...tx }] };
      dom.document.body.replaceChildren(...txDetailsView(ov, { state: { route: "tx", txDetailHash: HASH, addressBook: { loaded: true, items: [] } }, actions: {} }));
      const body = dom.document.body;
      return {
        lead: visibleText(body.querySelector(".tx-hero-lead")),
        name: visibleText(body.querySelector(".tx-hero-name")),
        via: visibleText(body.querySelector(".tx-hero-addr")),
        rows: body.querySelectorAll(".tx-detail > .group > .kv").map(visibleText),
        copy: body.querySelector(".tx-hero-name-line button")?.getAttribute("aria-label"),
      };
    };
    const sent = on({ kind: TX_KIND.TRANSFER, to: bsc, memo: evm, amount: "2000000000" });
    expect([sent.lead, sent.name, sent.via]).toEqual(["Bridge to BNB Smart Chain", "To BNB Smart Chain", `BSC bridge · ${bsc.slice(0, 6)}…${bsc.slice(-6)}`]);
    // The address there, in full, once: the memo it was sent with.
    expect(sent.rows).toContain(`BNB Smart Chain recipient${evm}Copy`);
    expect(sent.rows.filter((r) => r.startsWith("Memo"))).toEqual([]);
    const back = on({ kind: TX_KIND.TRANSFER, direction: "in", from: payouts, amount: "5000000000" });
    // A payout's memo is the migration it pays: its transaction there, not a memo.
    const migration = `0x${"5e".repeat(32)}`;
    const paid = on({ kind: TX_KIND.TRANSFER, direction: "in", from: payouts, amount: "5000000000", memo: migration });
    expect(paid.rows).toContain(`Ethereum transaction${migration.slice(0, 6)}…${migration.slice(-4)}Copy`);
    expect(paid.rows.filter((r) => r.startsWith("Memo"))).toEqual([]);
    expect([back.lead, back.name, back.via]).toEqual(["Bridge", "From Ethereum", `Ethereum migration payouts · ${payouts.slice(0, 6)}…${payouts.slice(-6)}`]);
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
      return dom.document.body.querySelectorAll(".tx-detail > .group > .kv").map(visibleText);
    };
    const actions = { render: vi.fn(async () => draw()), showToast: vi.fn() };
    const fees = (rows) => rows.filter((row) => row.startsWith("Fee on"));

    // Read from BNB Smart Chain's RPC once the details open: no fee until it answers.
    expect(fees(draw())).toEqual([]);
    await vi.waitFor(() => expect(actions.render).toHaveBeenCalled());
    const rows = draw();
    expect(fees(rows)).toEqual(["Fee on BNB Smart Chain0.00000474855 BNB · approval and migration"]);
    expect(rows).toContain("Sent1,041.53106263 BEP20 DUSK");
    expect(rows).toContain(`BNB Smart Chain transaction${migration.slice(0, 6)}…${migration.slice(-4)}Copy`);
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
      return () => dom.document.body.querySelectorAll(".tx-detail > .group > .kv").map(visibleText);
    };
    const rows = draw(false);
    await vi.waitFor(() => expect(rows()).toContain("You got49.875 stDUSK"));
    expect(rows()).toContain("Rate1 stDUSK = 2 DUSK");
    // What it got hides with the balances; the rate says nothing of what's held.
    const hiddenRows = draw(true);
    await vi.waitFor(() => expect(hiddenRows()).toContain("You got•••• stDUSK"));
    expect(hiddenRows()).toContain("Rate1 stDUSK = 2 DUSK");
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
      return dom.document.body.querySelectorAll(".tx-detail > .group > .kv").map(visibleText).filter((row) => row.startsWith("BNB Smart Chain transaction") || row.startsWith("Memo"));
    };

    expect(rowsWith(true)).toEqual([`Memo0x${"5e".repeat(32)}`]);
    // The same memo as text names the migration.
    expect(rowsWith(false)).toEqual(["BNB Smart Chain transaction0x5e5e…5e5eCopy"]);
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
    expect(visibleText(body.querySelector(".tx-hero-note"))).toBe("The network dropped it before it ran, so no fee was charged. The 3 DUSK stayed in your wallet.");
    expect(rows.filter((r) => /^(Sent|Bridge fee|You receive|Received)/.test(r))).toEqual([]);
    expect(rows).toContain("Network feeNone charged");
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
    const sentAt = Date.now() - 60_000;

    const going = on({ finalizedAt: sentAt });
    expect(going.status).toBe("On its way");
    // Sent, the bridge's fee, the network's, then what arrives, in that order, each exact.
    expect(going.rows.filter((r) => /^(Sent|Bridge fee|Network fee|You receive|Received)/.test(r))).toEqual([
      "Sent3 DUSK",
      "Bridge fee1 DUSK",
      "You receive2 BEP20 DUSK",
    ]);

    const lateAt = Date.now() - 3 * bsc.typicalSeconds * 1000;
    expect(on({ finalizedAt: lateAt }).status).toBe("Taking longer than usual");

    const arrivedAt = sentAt + 30_000;
    keptArrivals().set(HASH, { hash: payout, at: arrivedAt });
    const arrived = on({ finalizedAt: sentAt });
    keptArrivals().delete(HASH);
    expect(arrived.status).toBe("Arrived");
    expect(arrived.rows).toContain(`Arrived${dateText(arrivedAt)}`);
    expect(arrived.rows).toContain("Received2 BEP20 DUSK");
    expect(arrived.rows.some((r) => r.startsWith("You receive"))).toBe(false);
    expect(arrived.rows.at(-1)).toBe(`BNB Smart Chain transaction${payout.slice(0, 6)}…${payout.slice(-4)}Copy`);
    dom.window.open = vi.fn(() => ({}));
    const buttons = arrived.body.querySelectorAll(".tx-explorer-btn");
    expect(buttons.map(visibleText)).toEqual(["View in Dusk explorer", "View in BNB Smart Chain explorer"]);
    buttons[1].click();
    await settle();
    expect(dom.window.open).toHaveBeenCalledWith(`${networks.mainnet.routes.chains.bsc.explorerUrl}/tx/${payout}`, "_blank", expect.anything());

    // Past the week it's looked for, nothing says it's still on its way, or what it pays.
    const old = on({ finalizedAt: Date.now() - 8 * 86_400_000 });
    expect(old.status).toBe("Completed");
    expect(old.rows.some((r) => r.startsWith("You receive"))).toBe(false);

    // Nothing can arrive from what the bridge doesn't pay: no more than its fee, no address, or one that failed.
    for (const tx of [{ amount: "1000000000" }, { memo: "" }]) {
      const none = on({ finalizedAt: sentAt, ...tx });
      expect(none.status).toBe("Completed");
      expect(none.rows.some((r) => r.startsWith("You receive"))).toBe(false);
    }
    const failed = on({ finalizedAt: sentAt, status: "failed" });
    expect(failed.rows.some((r) => r.startsWith("You receive") || r.startsWith("Bridge fee") || r.startsWith("Sent"))).toBe(false);
  });

  it("says one transfer's amounts to the last lux, the network fee between what's sent and what arrives", () => {
    const MAINNET = "https://nodes.dusk.network";
    const bsc = routes(networks.mainnet).find((r) => r.id === "dusk-to-bsc");
    const evm = "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F";
    const on = (tx, { hidden = false } = {}) => {
      const ov = { nodeUrl: MAINNET, hideBalances: hidden, txs: [{ hash: HASH, nodeUrl: MAINNET, status: "executed", kind: TX_KIND.TRANSFER, finalizedAt: Date.now() - 60_000, ...tx }] };
      const state = { route: "tx", txDetailHash: HASH, txDetailFrom: "home", addressBook: { loaded: true, items: [] } };
      dom.document.body.replaceChildren(...txDetailsView(ov, { state, actions: { render: vi.fn(async () => {}), showToast: vi.fn() } }));
      return dom.document.body.querySelectorAll(".tx-detail > .group > .kv").map(visibleText).filter((r) => /^(Sent|Bridge fee|Network fee|You receive|Received)/.test(r));
    };
    expect(on({ to: bsc.account, memo: evm, amount: "3190082082", feePaid: "1859281" })).toEqual([
      "Sent3.190082082 DUSK",
      "Bridge fee1 DUSK",
      "Network fee0.001859281 DUSK",
      "You receive2.190082082 BEP20 DUSK",
    ]);
    // Hide balances hides them all.
    expect(on({ to: bsc.account, memo: evm, amount: "3190082082", feePaid: "1859281" }, { hidden: true })).toEqual([
      "Sent•••• DUSK",
      "Bridge fee•••• DUSK",
      "Network fee•••• DUSK",
      "You receive•••• BEP20 DUSK",
    ]);
    // A transfer that's no bridge's has no such lines but its fee.
    expect(on({ to: evm.replace("0x", ""), amount: "3190082082", feePaid: "1859281" })).toEqual(["Network fee0.001859281 DUSK"]);
  });

  it("says a deposit to DuskEVM's amounts, what arrives until it has", () => {
    const bridge = duskEvmContracts(2).bridge;
    const evm = "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F";
    const deposit = { kind: TX_KIND.CONTRACT_CALL, contractId: bridge, fnName: "depositETHToWithValue", amount: "0", deposit: "500000001", bridgeTo: evm, status: "executed", feePaid: "2500000", finalizedAt: Date.now() - 60_000 };
    const ledger = (view) => view.rows.filter((r) => /^(Sent|Bridge fee|Network fee|You receive|Received)/.test(r));
    expect(ledger(details(deposit))).toEqual(["Sent0.500000001 DUSK", "Network fee0.0025 DUSK", "You receive0.500000001 DUSK"]);
    keptArrivals().set(HASH, { hash: `0x${"7c".repeat(32)}`, at: Date.now() });
    expect(ledger(details(deposit))).toEqual(["Sent0.500000001 DUSK", "Network fee0.0025 DUSK", "Received0.500000001 DUSK"]);
    keptArrivals().delete(HASH);
    // Past the week it's looked for, what it paid stands alone.
    expect(ledger(details({ ...deposit, finalizedAt: Date.now() - 8 * 86_400_000 }))).toEqual(["Sent0.500000001 DUSK", "Network fee0.0025 DUSK"]);
  });

  it("leads with a saved contact's own name, its .dusk name beside the address", () => {
    const to = "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";
    const send = { kind: TX_KIND.TRANSFER, direction: "out", to, toName: "wallet-both.dusk", amount: "500000000", status: "executed" };
    const view = details(send, { contacts: [{ name: "Jan (flour)", address: to }] });
    expect(view.name).toBe("Jan (flour)");
    expect(visibleText(view.body.querySelector(".tx-hero-addr"))).toBe(`wallet-both.dusk · ${to.slice(0, 6)}…${to.slice(-6)}`);
    // Without the contact, the .dusk name leads.
    expect(details(send).name).toBe("wallet-both.dusk");
  });

  it("shows the amount and the fee to the last lux, where a row shows them short, with every Dusk app's labels", () => {
    const send = { kind: TX_KIND.TRANSFER, amount: "1000000000", status: "executed", feePaid: "1856398", gasSpent: "1856398", gasPrice: "1", gasLimit: "2500000" };
    const view = details(send);
    expect(view.rows).toContain("Network fee0.001856398 DUSK");
    const tech = view.body.querySelectorAll(".tx-tech .kv").map(visibleText);
    expect(tech).toContain("Gas used1,856,398 of 2,500,000");
    expect(tech).toContain("Gas price1 LUX");

    const exact = details({ ...send, amount: "53082083", to: "26JfWKvhYdVY71bdSPVLNJ51Buy4GjimCT7zcsoxNQtydDbdoH2AwZaH8W7rjcAc9riAu39Vw9Lx1w7yrkBgotSjWmUdkSyQuaTKDZWVCKp9g1GxiEnnksv3W3onToB5NsNi" });
    expect(visibleText(exact.body.querySelector(".tx-hero-amount"))).toBe("−0.053082083 DUSK");
    // What a failure kept says so to the last lux too, hidden with balances.
    const failed = details({ ...send, amount: "53082083", status: "failed" });
    expect(failed.note).toContain("The 0.053082083 DUSK stayed in your wallet.");
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
    expect(details({ ...send, origin: "https://shop.example" }).rows).toContain("Siteshop.example");
    expect(details({ ...send, origin: "http://127.0.0.1:5354" }).rows).toContain("Sitehttp://127.0.0.1:5354");
    for (const origin of ["Wallet", undefined]) {
      expect(details({ ...send, origin }).rows.filter((r) => r.startsWith("Site")), String(origin)).toEqual([]);
    }
  });

  it("says when a transaction isn't in Activity, and still opens it in the explorer", () => {
    const state = { route: "tx", txDetailHash: "ef".repeat(32), txDetailFrom: "home" };
    dom.document.body.replaceChildren(...txDetailsView({ nodeUrl: NODE, txs: [] }, { state, actions: {} }));
    expect(visibleText(dom.document.body)).toBe(
      "← BackTransactionThis transaction isn't in your activity.Transaction IDefefef…efefefView in Dusk explorer"
    );
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
    expect(await shown({ nodeUrl: "https://nodes.dusk.network", accounts: [A] })).toEqual(["This transaction is on Testnet. You are on Mainnet.", onTestnet]);
    expect(await shown({ nodeUrl: NODE, accounts: [B], selectedAccountIndex: 0 })).toEqual(["This transaction is in Wallet 1.", onTestnet]);
    expect(await shown({ nodeUrl: NODE, accounts: [A, B], selectedAccountIndex: 1 })).toEqual(["This transaction is in another profile.", onTestnet]);

    // Its record gone once the history had it: the history it's kept in says,
    // under the key its writer keeps each network's under.
    kept.clear();
    const { activityOwnerKey, commitActivityStep } = await import("../shared/activityStore.js");
    const { activityNetworkKey } = await import("../shared/activityHistory.js");
    const inHistory = (nodeUrl, account, txHash) => commitActivityStep(activityOwnerKey(activityNetworkKey(nodeUrl), account), [{ hash: txHash, blockHeight: 7 }], () => ({ covered: [[0, 9]] }));
    await inHistory(NODE, B, hash);
    expect(await shown({ nodeUrl: "https://nodes.dusk.network", accounts: [A] })).toEqual(["This transaction is on Testnet. You are on Mainnet.", onTestnet]);
    expect(await shown({ nodeUrl: NODE, accounts: [A] })).toEqual(["This transaction is in Savings.", onTestnet]);
  });

  // Astra's: Devnet's and other nodes' histories are kept by the node's origin, not by name.
  it.each([
    ["Devnet", "https://devnet.nodes.dusk.network", "This transaction is on Devnet. You are on Mainnet."],
    ["a node of its own", "https://my-node.example:8443", "This transaction is on Custom · my-node.example:8443. You are on Mainnet."],
  ])("says where a transaction of %s is from its history, on that node and on another network", async (_, node, elsewhere) => {
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
    expect(await shown({ nodeUrl: node })).toEqual(["This transaction is in another profile.", explorer]);
    expect(await shown({ nodeUrl: "https://nodes.dusk.network" })).toEqual([elsewhere, explorer]);
  });

  it("hides the gas used with Hide balances, as the fee can be worked out from it", () => {
    const view = details({ kind: TX_KIND.TRANSFER, amount: "1000000000", status: "executed", gasSpent: "1856398", gasPrice: "1", gasLimit: "2500000" }, { hidden: true });
    const used = view.body.querySelectorAll(".tx-tech .kv").map(visibleText).find((row) => row.startsWith("Gas used"));
    expect(used).toBe("Gas used••••");
  });

  it("shows a memo in the order it was written, its controls neutralized and flagged", () => {
    const [rlo, pop] = [0x202e, 0x202c].map((c) => String.fromCodePoint(c));
    const { body } = details({ kind: TX_KIND.TRANSFER, amount: "1000000000", status: "executed", memo: `invoice ${rlo}gnp.exe${pop}` });
    const memo = [...body.querySelectorAll(".kv")].find((row) => visibleText(row).startsWith("Memo"));
    expect(memo.querySelector(".safe-text > span").textContent).toBe("invoice \\u202egnp.exe\\u202c");
    expect(visibleText(memo)).not.toContain(rlo);
    expect(memo.querySelector(".safe-text__flag").textContent).toBe("Hidden characters that can change how this reads show here as � or \\u codes.");
  });

  it("shows a plain memo as it is, unflagged, in any script", () => {
    const { body } = details({ kind: TX_KIND.TRANSFER, amount: "1000000000", status: "executed", memo: "فاتورة 12 · Rechnung" });
    const memo = [...body.querySelectorAll(".kv")].find((row) => visibleText(row).startsWith("Memo"));
    // Its characters as they are, a right-to-left word set apart for the screen (app-core 0.7.2's displayText).
    expect(visibleText(memo).replace(/[\u2066\u2068\u2069]/g, "")).toBe("Memoفاتورة 12 · Rechnung");
    expect(memo.querySelector(".safe-text__flag")).toBeNull();
  });
});
