import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { parseHistoryEntry } from "@dusk-network/app-core/history";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import fixture from "../../shared/fixtures/activity-testnet.json";
import registrations from "../../shared/fixtures/dusk-domains-registrations.json";
import deposit from "../../shared/fixtures/duskevm-deposit-history.json";
import { fakeArchive } from "../../shared/fixtures/fakeArchive.js";
import { describeTx } from "./views/txRow.js";

const names = vi.hoisted(() => ({ lookupRecipientNames: vi.fn() }));
vi.mock("../../shared/duskNames.js", () => names);

const [A, B] = Object.keys(fixture.accounts);
const NODE = fixture.nodeUrl;
const FAUCET = fixture.accounts[A].receiver[0].events[0].data.sender;
const SENDER = fixture.accounts[A].receiver[1].events[0].data.sender;

let activity;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  names.lookupRecipientNames.mockReset();
  names.lookupRecipientNames.mockImplementation(async (accounts) => new Map(accounts.map((a) => [a, a === FAUCET ? "faucet.dusk" : null])));
  activity = await import("./activity.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const overview = (account = A, over = {}) => ({ isUnlocked: true, nodeUrl: NODE, accounts: [account], selectedAccountIndex: 0, txs: [], ...over });

async function until(check, ms = 5_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// One popup: its state, its render, and the account's sync being done.
async function popup(ov = overview(), route = "home") {
  const state = { route };
  const render = vi.fn(async () => {});
  activity.ensureActivity(ov, { state, render });
  await until(() => state.activity?.loaded && !state.activity.syncing && state.activity.checked.size > 0);
  return { state, render };
}

describe("ensureActivity", () => {
  it("syncs once per popup and account, and names the counterparties in one lookup", async () => {
    const node = fakeArchive();
    const { state, render } = await popup();
    const requests = node.log.length;

    expect(state.activity.entries.map((e) => e.blockHeight)).toEqual([4658012, 4658000, 4657992, 4655845]);
    expect(names.lookupRecipientNames).toHaveBeenCalledTimes(1);
    expect(names.lookupRecipientNames.mock.calls[0][0].sort()).toEqual([FAUCET, SENDER].sort());
    expect(state.activity.names).toEqual(new Map([[FAUCET, "faucet.dusk"], [SENDER, null]]));
    // Steps redraw, a moment apart.
    await until(() => render.mock.calls.length > 0);

    // Later renders of the same account start nothing.
    activity.ensureActivity(overview(), { state, render });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(node.log.length).toBe(requests);

    const rows = activity.activityRows(overview(), state);
    expect(rows.find((r) => r.counterparty === FAUCET)).toMatchObject({ counterpartyName: "faucet.dusk", direction: "in" });
  });

  it("paints the kept history and names before the archive answers", async () => {
    const node = fakeArchive();
    await popup();
    // The names the first popup checked are kept.
    const kept = await import("../../shared/activityStore.js");
    await until(async () => (await kept.getCounterpartyNames("testnet", [FAUCET])).has(FAUCET));
    const requests = node.log.length;
    node.down = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // The next popup, with the archive gone and the names' lookup not back.
    names.lookupRecipientNames.mockImplementation(() => new Promise(() => {}));
    const state = { route: "home" };
    const render = vi.fn(async () => {});
    activity.ensureActivity(overview(), { state, render });
    await until(() => state.activity.loaded);
    expect(state.activity.entries).toHaveLength(4);
    // The names checked a moment ago are still good to show.
    await until(() => state.activity.names.get(FAUCET) === "faucet.dusk");
    await until(() => !state.activity.syncing && state.activity.error);
    expect(state.activity.entries).toHaveLength(4);
    expect(node.log.length).toBe(requests);
  });

  it("redraws only the views that show activity", async () => {
    fakeArchive();
    const { render } = await popup(overview(), "send");
    expect(render).not.toHaveBeenCalled();
  });

  it("starts over for another account, and drops the last one's late answers", async () => {
    fakeArchive();
    const state = { route: "home" };
    const render = vi.fn(async () => {});
    activity.ensureActivity(overview(A), { state, render });
    const first = state.activity;
    activity.ensureActivity(overview(B), { state, render });
    expect(state.activity).not.toBe(first);
    await until(() => state.activity.loaded && !state.activity.syncing);
    expect(state.activity.account).toBe(B);
    expect(activity.activityRows(overview(B), state).length).toBeGreaterThan(0);
    // Rows are only ever the overview's account's.
    expect(activity.activityRows(overview(A), state)).toEqual([]);
  });

  it("names every row it shows, a block the page cuts through whole", async () => {
    // Derived: A received 49 transfers from SENDER, each in its own block,
    // and below them one block with one from SENDER and one from FAUCET.
    const [faucet, sender] = fixture.accounts[A].receiver;
    const at = (entry, height, n) => ({ ...entry, block_height: height, origin: n.toString(16).padStart(64, "0") });
    const top = fixture.head.last_finalized_block[0] - 100;
    const receiver = [at(faucet, top - 10_000, 1), at(sender, top - 10_000, 2), ...Array.from({ length: 49 }, (_, i) => at(sender, top - 48 + i, 3 + i))];
    fakeArchive({ accounts: { [A]: { sender: [], receiver } } });
    const { state } = await popup();
    expect(state.activity.entries).toHaveLength(activity.ACTIVITY_PAGE + 1);
    expect(activity.activityRows(overview(), state).find((r) => r.hash === receiver[0].origin)).toMatchObject({ counterpartyName: "faucet.dusk" });
  });
});

describe("Show more", () => {
  it("goes on below a block the first page showed whole, however big", async () => {
    // Derived: 10 transfers on top, each in its own block, then 100 in one
    // block, then 30 older ones.
    const [, sender] = fixture.accounts[A].receiver;
    const at = (height, n) => ({ ...sender, block_height: height, origin: n.toString(16).padStart(64, "0") });
    const top = fixture.head.last_finalized_block[0] - 100;
    // Oldest first, as the archive lists them.
    const receiver = [
      ...Array.from({ length: 30 }, (_, i) => at(top - 59 + i, 300 + i)),
      ...Array.from({ length: 100 }, (_, i) => at(top - 20, 100 + i)),
      ...Array.from({ length: 10 }, (_, i) => at(top - 9 + i, 1 + i)),
    ];
    fakeArchive({ accounts: { [A]: { sender: [], receiver } } });
    // A popup syncs once: enough of them to keep the whole history.
    let shown = await popup();
    for (let i = 0; i < 5 && !shown.state.activity.complete; i += 1) shown = await popup();
    const { state, render } = shown;

    // The first page: the 10, then the 100 of the block it cuts through.
    expect(state.activity.complete).toBe(true);
    expect(state.activity.entries).toHaveLength(110);
    await activity.showMoreActivity({ state, render });
    await until(() => !state.activity.syncing && state.activity.entries.length > 110);
    expect(state.activity.entries).toHaveLength(140);
  });
});

describe("a custom node whose network is learned later", () => {
  it("is another activity once its chain is known, so it reads on that network", async () => {
    const { noteChainId } = await import("../../shared/nodeNetwork.js");
    const ov = overview(A, { nodeUrl: "https://node.example" });
    const unknown = activity.activityKey(ov);
    noteChainId("https://node.example", 2);
    expect(activity.activityKey(ov)).not.toBe(unknown);
  });
});

describe("a deposit to DuskEVM", () => {
  const H = deposit.entry.block_height;
  const archive = () => fakeArchive({ accounts: { [deposit.account]: { sender: [deposit.entry], receiver: [] } }, details: deposit.details, finalized: H + 100 });
  const rowOf = (state) => activity.activityRows(overview(deposit.account), state).find((r) => r.hash === deposit.entry.origin);

  it("shows the DuskEVM address it paid, read from its call", async () => {
    archive();
    const state = { route: "home" };
    activity.ensureActivity(overview(deposit.account), { state, render: vi.fn(async () => {}) });
    await until(() => rowOf(state)?.bridge?.to === deposit.recipient && !state.activity.syncing);
  });

  it("reads one kept before as it was kept, asking nothing more of it", async () => {
    const node = archive();
    const store = await import("../../shared/activityStore.js");
    // As the wallet kept it before: its details and DuskEVM address, with every height to the head read.
    const kept = { ...parseHistoryEntry(deposit.account, deposit.entry), detailsAt: 1, success: true, bridgeTo: deposit.recipient };
    const covered = { account: deposit.account, covered: [[0, H + 90]], finalized: H + 100, genesis: fixture.head.genesis, target: H + 90, window: 8_640 };
    await store.commitActivityStep(store.activityOwnerKey("testnet", deposit.account), [{ ...kept, value: String(kept.value) }], () => covered);
    const state = { route: "home" };
    activity.ensureActivity(overview(deposit.account), { state, render: vi.fn(async () => {}) });
    await until(() => node.log.length > 0 && !state.activity.syncing);
    expect(node.detailQueries()).toEqual([]);
    expect(rowOf(state)).toMatchObject({ bridge: { step: "deposit", to: deposit.recipient } });
  });
});

describe("a .dusk name's registration", () => {
  it("names the registration and the reservation before it, reading their calls alone, once", async () => {
    const call = registrations.calls.find((c) => c.name === "shpongle.dusk");
    const reservation = registrations.reservations.find((c) => c.name === "shpongle.dusk");
    const withData = (all, { hash, data }) => ({ ...all, [hash]: { ...all[hash], tx: { ...all[hash].tx, callData: { ...all[hash].tx.callData, data } } } });
    const node = fakeArchive({ details: withData(withData(fixture.details, call), reservation) });
    const { state } = await popup();
    const rows = activity.activityRows(overview(), state);
    expect(rows.find((r) => r.hash === call.hash)).toMatchObject({ nameCall: { kind: "registration", name: "shpongle.dusk" } });
    expect(rows.find((r) => r.hash === reservation.hash)).toMatchObject({ nameCall: { kind: "reservation", name: "shpongle.dusk" } });
    // The hashes whose call arguments were asked for: theirs alone, and not again by the next popup.
    const withArgs = node.detailQueries().flatMap((l) => [...l.query.matchAll(/tx\(hash: "(\w{64})"\)[^}]*\{ contractId fnName data \}/g)].map((m) => m[1]));
    expect(withArgs).toEqual([call.hash, reservation.hash]);
    const asked = node.detailQueries().length;
    await popup();
    expect(node.detailQueries()).toHaveLength(asked);
  });
});

describe("the wallet's own sends", () => {
  // A's two calls, as this wallet sent them: the first, here, a token transfer.
  const [commit, register] = fixture.accounts[A].sender.map((e) => e.origin);
  const TOKEN = "7e".repeat(32);
  const asToken = { ...fixture.details, [commit]: { ...fixture.details[commit], tx: { ...fixture.details[commit].tx, callData: { contractId: TOKEN, fnName: "transfer" } } } };
  const sent = (over) => ({ origin: "Wallet", nodeUrl: NODE, kind: "contract_call", profileIndex: 0, submittedAt: Date.now() - 60_000, status: "executed", ...over });
  const registration = sent({ contractId: fixture.details[register].tx.callData.contractId, fnName: "register" });
  // Where the transaction store lives outside the extension.
  const memoryStorage = (store = new Map()) => ({
    get length() {
      return store.size;
    },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => store.get(String(k)) ?? null,
    setItem: (k, v) => store.set(String(k), String(v)),
    removeItem: (k) => store.delete(String(k)),
  });
  let txs;
  beforeEach(async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    txs = await import("../../shared/txStore.js");
  });

  it("are forgotten once the chain's history says all of them, a token transfer kept for its details", async () => {
    fakeArchive({ details: asToken });
    const token = { type: "DRC20", op: "transfer", symbol: "TKN", decimals: 2, valueUnits: "1250", to: SENDER };
    await txs.putTxMeta(register, registration);
    await txs.putTxMeta(commit, sent({ contractId: TOKEN, fnName: "transfer", asset: token }));
    const { state } = await popup();
    const kept = await txs.listTxs({ nodeUrl: NODE });
    expect(kept.map((tx) => [tx.hash, tx.settled])).toEqual([[commit, true]]);
    // Each once, the transfer in the token's words.
    const rows = activity.activityRows(overview(A, { txs: kept }), state);
    expect(rows.filter((r) => r.hash === commit || r.hash === register)).toHaveLength(2);
    expect(describeTx(rows.find((r) => r.hash === commit), { nodeUrl: NODE })).toMatchObject({ lead: "Sent to", amount: { value: "12.5", unit: "TKN" } });
  });

  it("are left as they are while the wallet still watches them", async () => {
    fakeArchive();
    await txs.putTxMeta(register, { ...registration, status: "mempool" });
    await popup();
    expect(await txs.getTxMeta(register)).toEqual({ ...registration, status: "mempool" });
    // Its watch done, the next popup forgets it.
    await txs.patchTxMeta(register, { status: "executed" });
    await popup();
    expect(await txs.getTxMeta(register)).toBeNull();
  });
});

describe("another chain under the node", () => {
  it("starts the account's history over, and leaves other accounts' as they are", async () => {
    const node = fakeArchive();
    const store = await import("../../shared/activityStore.js");
    const kept = (account) => store.listActivityEntries(store.activityOwnerKey("testnet", account), { limit: 1_000 });
    await popup(overview(A));
    await popup(overview(B));
    const before = await kept(B);
    node.genesis = "ff".repeat(32);
    node.finalized = 4_656_000;
    const { state } = await popup(overview(A));
    expect(state.activity.entries.map((e) => e.blockHeight)).toEqual([4655845]);
    expect(await kept(B)).toEqual(before);
  });
});

describe("a node without the archive", () => {
  it("is asked nothing by the next popup for an hour, and the console is told once", async () => {
    const node = fakeArchive();
    node.archive = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const open = async () => {
      const state = { route: "home" };
      activity.ensureActivity(overview(), { state, render: vi.fn(async () => {}) });
      await until(() => state.activity.error);
    };
    await open();
    const asked = node.log.length;
    await open();
    expect(node.log.length).toBe(asked);
    expect(warn).toHaveBeenCalledTimes(1);
    // An hour on, the next popup asks again.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 60_000);
    node.archive = true;
    const { state } = await popup();
    expect(state.activity.entries).toHaveLength(4);
  });
});

describe("a change of archiver", () => {
  it("starts the account's activity over with the new archiver", async () => {
    fakeArchive();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = { route: "home" };
    const render = vi.fn(async () => {});
    activity.ensureActivity(overview(A, { archiverUrl: NODE }), { state, render });
    const first = state.activity;
    expect(first.archiverUrl).toBe(NODE);
    activity.ensureActivity(overview(A, { archiverUrl: "https://archive.example" }), { state, render });
    const second = state.activity;
    expect(second).not.toBe(first);
    expect(second.archiverUrl).toBe("https://archive.example");
    await until(() => first.loaded && !first.syncing && second.loaded && !second.syncing);
  });
});

describe("a wallet reset or lock", () => {
  it("keeps nothing more for an account the popup saw before a reset elsewhere", async () => {
    const node = fakeArchive();
    const { state, render } = await popup();
    const store = await import("../../shared/activityStore.js");
    const owner = store.activityOwnerKey("testnet", A);
    // The wallet is reset in another window; this popup still shows A.
    await store.clearActivityStore();
    const requests = node.log.length;
    activity.refreshActivitySoon({ state, render }, 0);
    await until(() => node.log.length > requests && !state.activity.syncing);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await store.listActivityEntries(owner)).toEqual([]);
    expect(await store.getActivityMeta(owner)).toBeNull();
    expect(await store.getCounterpartyNames("testnet", [FAUCET, SENDER])).toEqual(new Map());
  });

  it("stops quietly when the wallet is reset while a lookup is out", async () => {
    const node = fakeArchive();
    const held = Promise.withResolvers();
    const reached = Promise.withResolvers();
    node.before = async (query) => {
      if (!query.includes("tx(hash:")) return;
      node.before = null;
      reached.resolve();
      await held.promise;
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = { route: "home" };
    activity.ensureActivity(overview(), { state, render: vi.fn(async () => {}) });
    await reached.promise;
    const store = await import("../../shared/activityStore.js");
    await store.clearActivityStore();
    held.resolve();
    await until(() => !state.activity.syncing);
    expect(state.activity).toMatchObject({ stale: true, error: null });
    expect(warn).not.toHaveBeenCalled();
    expect(await store.listActivityEntries(store.activityOwnerKey("testnet", A))).toEqual([]);
  });

  it("drops the activity when the wallet locks", async () => {
    fakeArchive();
    const { state, render } = await popup();
    activity.ensureActivity(overview(A, { isUnlocked: false }), { state, render });
    expect(state.activity).toBeNull();
  });
});

describe("shielded history", () => {
  const shieldedRow = { hash: "cd".repeat(32), source: "shielded", privacy: "shielded", kind: "transfer", direction: "in", amount: "5", status: "executed", timestamp: 1_000, blockHeight: 10 };

  it("asks the wallet for it once the public history is shown, and shows it with the rest", async () => {
    fakeArchive();
    const send = vi.fn(async () => ({ ok: true, result: { profileIndex: 0, entries: [shieldedRow] } }));
    const state = { route: "home" };
    const render = vi.fn(async () => {});
    activity.ensureActivity(overview(), { state, render, send });
    await until(() => state.activity.shielded.length > 0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: "DUSK_UI_GET_SHIELDED_HISTORY" });
    const rows = activity.activityRows(overview(), state);
    expect(rows.at(-1)).toMatchObject({ hash: shieldedRow.hash, source: "shielded" });
  });

  it("ignores another profile's answer, and asks again next time while notes still sync", async () => {
    fakeArchive();
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: { profileIndex: 1, entries: [shieldedRow] } })
      .mockResolvedValue({ ok: true, result: { profileIndex: 0, entries: [], pending: true } });
    let state = { route: "home" };
    activity.ensureActivity(overview(), { state, render: vi.fn(async () => {}), send });
    await until(() => send.mock.calls.length === 1 && !state.activity.syncing);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.activity.shielded).toEqual([]);

    state = { route: "home" };
    activity.ensureActivity(overview(), { state, render: vi.fn(async () => {}), send });
    await until(() => send.mock.calls.length === 2);
    await until(() => state.activity.shieldedAsked === false);
  });

  it("asks again in a view that stays open, once the notes are synced", async () => {
    fakeArchive();
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: { profileIndex: 0, entries: [], pending: true } })
      .mockResolvedValue({ ok: true, result: { profileIndex: 0, entries: [shieldedRow] } });
    const state = { route: "home" };
    const render = vi.fn(async () => {});
    const syncing = overview(A, { shieldedSync: { state: "syncing" } });
    activity.ensureActivity(syncing, { state, render, send });
    await until(() => send.mock.calls.length === 1 && state.activity.shieldedAsked === false);
    // The view's next renders, while the notes still sync: nothing more.
    activity.ensureActivity(syncing, { state, render, send });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).toHaveBeenCalledTimes(1);
    // Synced: asked again, and shown.
    activity.ensureActivity(overview(A, { shieldedSync: { state: "done" } }), { state, render, send });
    await until(() => state.activity.shielded.length > 0);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("shielded history retries", () => {
  const shieldedRow = { hash: "cd".repeat(32), source: "shielded", privacy: "shielded", kind: "transfer", direction: "in", amount: "5", status: "executed", timestamp: 1_000, blockHeight: 10 };
  const synced = (account = A) => overview(account, { shieldedSync: { state: "done" } });

  // The minute-later retries, held to be run by hand; other timers run as usual.
  function holdRetries() {
    const held = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms, ...rest) => {
      if (ms !== activity.SHIELDED_RETRY_MS) return realSetTimeout(fn, ms, ...rest);
      held.push(fn);
      return 9000 + held.length;
    });
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    return { held, cleared };
  }

  it.each([
    ["an error", { error: { message: "Shielded sync is busy" } }],
    ["no entries", { ok: true, result: null }],
    ["another profile's", { ok: true, result: { profileIndex: 3, entries: [shieldedRow] } }],
  ])("asks again after %s, instead of never", async (_label, first) => {
    fakeArchive();
    const { held } = holdRetries();
    const send = vi.fn().mockResolvedValueOnce(first).mockResolvedValue({ ok: true, result: { profileIndex: 0, entries: [shieldedRow] } });
    const state = { route: "home" };
    const render = vi.fn(async () => {});
    activity.ensureActivity(synced(), { state, render, send });
    await until(() => send.mock.calls.length === 1 && state.activity.shieldedAsked === false && held.length === 1);
    // A render once the minute is up asks again.
    vi.spyOn(Date, "now").mockReturnValue(state.activity.shieldedRetryAt + 1);
    activity.ensureActivity(synced(), { state, render, send });
    await until(() => state.activity.shielded.length > 0);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("asks again a minute later by itself in a view nothing redraws, and stops when the activity goes", async () => {
    fakeArchive();
    const { held, cleared } = holdRetries();
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: { profileIndex: 0, entries: [], pending: true } })
      .mockResolvedValueOnce({ ok: true, result: { profileIndex: 0, entries: [shieldedRow], pending: true } })
      .mockResolvedValue({ ok: true, result: { profileIndex: 0, entries: [shieldedRow] } });
    const state = { route: "home" };
    const render = vi.fn(async () => {});
    activity.ensureActivity(synced(), { state, render, send });
    await until(() => held.length === 1);
    // No render meanwhile: the timer asks.
    held[0]();
    await until(() => state.activity.shielded.length > 0);
    expect(send).toHaveBeenCalledTimes(2);

    // Still pending: another timer, cancelled once another account's activity takes over.
    await until(() => held.length === 2);
    const before = send.mock.calls.length;
    activity.ensureActivity(synced(B), { state, render, send });
    expect(cleared).toHaveBeenCalledWith(9002);
    // The new account asks for its own; the old timer, had it run anyway, asks nothing.
    await until(() => send.mock.calls.length === before + 1);
    held[1]();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).toHaveBeenCalledTimes(before + 1);
  });
});

describe("loadActivityDetail", () => {
  it("asks again a while after a lookup that brought nothing, not before", async () => {
    const node = fakeArchive();
    const { state, render } = await popup();
    // An entry shown before any lookup found its details.
    const entry = { ...state.activity.entries[0], detailsAt: undefined };
    state.activity.entries = [entry, ...state.activity.entries.slice(1)];
    const lookups = () => node.detailQueries().length;

    node.down = true;
    const before = lookups();
    activity.loadActivityDetail({ state, render }, entry.hash);
    await new Promise((resolve) => setTimeout(resolve, 30));
    node.down = false;
    // Right after: not asked again.
    activity.loadActivityDetail({ state, render }, entry.hash);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(lookups()).toBe(before);
    // A minute later: asked, and found.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + activity.DETAIL_RETRY_MS + 1);
    activity.loadActivityDetail({ state, render }, entry.hash);
    await until(() => lookups() > before);
  });
});

describe("refreshActivitySoon", () => {
  it("runs one more sync a little later", async () => {
    const node = fakeArchive({ finalized: 4_656_000 });
    const { state, render } = await popup();
    expect(state.activity.entries).toHaveLength(1);
    node.finalized = fixture.head.last_finalized_block[0];
    activity.refreshActivitySoon({ state, render }, 5);
    await until(() => state.activity.entries.length === 4);
  });
});

describe("showMoreActivity", () => {
  it("reads the next page of kept history", async () => {
    fakeArchive();
    const { state, render } = await popup(overview(B));
    await until(() => state.activity.complete);
    expect(state.activity.entries).toHaveLength(activity.ACTIVITY_PAGE);
    expect(activity.hasMoreActivity(state)).toBe(true);
    await activity.showMoreActivity({ state, render });
    expect(state.activity.entries.length).toBe(2 * activity.ACTIVITY_PAGE);
    expect(activity.hasMoreActivity(state)).toBe(true);
    await activity.showMoreActivity({ state, render });
    expect(state.activity.entries.length).toBe(102);
    expect(activity.hasMoreActivity(state)).toBe(false);
  });
});
