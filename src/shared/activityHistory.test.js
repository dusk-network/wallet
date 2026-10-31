import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { StaleHistoryError } from "@dusk-network/app-core/history";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import fixture from "./fixtures/activity-testnet.json";
import { fakeArchive } from "./fixtures/fakeArchive.js";

const [A] = Object.keys(fixture.accounts);
const NODE = fixture.nodeUrl;

let store;
let history;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  store = await import("./activityStore.js");
  history = await import("./activityHistory.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// One run's history of `account`, as a page makes it.
const historyOf = (account) => history.activityHistory({ nodeUrl: NODE, account, epoch: store.getActivityEpoch() });
const sync = (account, options) => historyOf(account).sync(options);
const kept = (account) => store.listActivityEntries(store.activityOwnerKey("testnet", account), { limit: 1_000 });

describe("another chain under the node, found by two runs at once", () => {
  it("keeps what the faster run read of the new chain: the slower one forgets none of it, and asks for its head alone", async () => {
    const node = fakeArchive();
    await sync(A);

    // The node is reset: another genesis, and A's first entry again.
    node.genesis = "ff".repeat(32);
    node.finalized = 4_656_000;

    // One run reads the history kept, then waits for its head.
    const held = Promise.withResolvers();
    const reached = Promise.withResolvers();
    let first = true;
    node.before = async () => {
      if (!first) return;
      first = false;
      reached.resolve();
      await held.promise;
    };
    const slow = sync(A);
    await reached.promise;
    // Meanwhile another page's run starts the history over on the new chain, and reads it.
    await sync(A);
    const asked = node.log.length;

    held.resolve();
    await slow;
    expect((await kept(A)).map((r) => r.blockHeight)).toEqual([4655845]);
    expect(node.log.length).toBe(asked + 1);
  });

  it("keeps none of the old chain's details on the new chain's history", async () => {
    const node = fakeArchive();
    const patch = store.patchActivityEntries;
    let once = true;
    // Between a run's last look at the history and its write of the old
    // chain's details, the node is reset, and another run reads the new
    // chain without them.
    vi.spyOn(store, "patchActivityEntries").mockImplementation(async (...args) => {
      if (once) {
        once = false;
        node.genesis = "ff".repeat(32);
        await sync(A, { maxDetailRequests: 0 });
      }
      return patch(...args);
    });

    await expect(sync(A)).rejects.toBeInstanceOf(StaleHistoryError);
    const rows = await kept(A);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.detailsAt === undefined)).toBe(true);
  });
});
