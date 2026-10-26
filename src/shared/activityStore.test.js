import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

let store;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  store = await import("./activityStore.js");
});

describe("activityStore", () => {
  it("forgets everything it keeps when the wallet is reset", async () => {
    const owner = store.activityOwnerKey("testnet", "acct");
    await store.commitActivityStep(owner, [{ hash: "aa".repeat(32), blockHeight: 5 }], () => ({ covered: [[0, 9]] }));
    await store.putCounterpartyNames("testnet", new Map([["acct2", "alice.dusk"]]));
    await store.putNoteHeightPool("testnet", [1, 2], 3);
    await store.putShieldedHistoryRecord("testnet::w::0", { fingerprint: "x", entries: [] });
    await store.putArchiveRefusal("https://node.example", 1);

    await store.clearActivityStore();

    expect(await store.getActivityMeta(owner)).toBeNull();
    expect(await store.listActivityEntries(owner)).toEqual([]);
    expect(await store.getCounterpartyNames("testnet", ["acct2"])).toEqual(new Map());
    expect(await store.getNoteHeightPool("testnet")).toBeNull();
    expect(await store.getShieldedHistoryRecord("testnet::w::0")).toBeNull();
    expect(await store.getArchiveRefusal("https://node.example")).toBeNull();
  });

  it("keeps when a node answered without the archive", async () => {
    expect(await store.getArchiveRefusal("https://node.example")).toBeNull();
    await store.putArchiveRefusal("https://node.example", 42);
    expect(await store.getArchiveRefusal("https://node.example")).toBe(42);
    expect(await store.getArchiveRefusal("https://other.example")).toBeNull();
  });
});
