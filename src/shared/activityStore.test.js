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

  it("keeps nothing of a sync step whose state can't be made", async () => {
    const owner = store.activityOwnerKey("testnet", "acct");
    const overtaken = () => {
      throw new Error("Another run started this history over");
    };
    await expect(store.commitActivityStep(owner, [{ hash: "aa".repeat(32), blockHeight: 5 }], overtaken)).rejects.toThrow();
    expect(await store.getActivityMeta(owner)).toBeNull();
    expect(await store.listActivityEntries(owner)).toEqual([]);
  });

  it("writes no details and forgets nothing when the check sees another run's history", async () => {
    const owner = store.activityOwnerKey("testnet", "acct");
    const hash = "aa".repeat(32);
    await store.commitActivityStep(owner, [{ hash, blockHeight: 5 }], () => ({ genesis: "new" }));
    const overtaken = new Error("Another run started this history over");
    const check = vi.fn((kept) => {
      if (kept?.genesis === "new") throw overtaken;
    });

    await expect(store.patchActivityEntries(owner, new Map([[hash, { detailsAt: 1 }]]), undefined, check)).rejects.toBe(overtaken);
    await expect(store.clearActivity(owner, undefined, check)).rejects.toBe(overtaken);
    expect(check.mock.calls.map(([kept]) => kept.genesis)).toEqual(["new", "new"]);
    expect(await store.listActivityEntries(owner)).toEqual([expect.not.objectContaining({ detailsAt: 1 })]);
    expect(await store.getActivityMeta(owner)).toMatchObject({ genesis: "new" });

    // A check that passes: written, then forgotten.
    await store.patchActivityEntries(owner, new Map([[hash, { detailsAt: 1 }]]), undefined, () => {});
    expect(await store.listActivityEntries(owner)).toEqual([expect.objectContaining({ detailsAt: 1 })]);
    await store.clearActivity(owner, undefined, () => {});
    expect([await store.getActivityMeta(owner), await store.listActivityEntries(owner)]).toEqual([null, []]);
  });

  it("keeps a shielded history's change in one transaction, and nothing of one that throws", async () => {
    const key = "testnet::w::0";
    const grow = (kept) => ({ fingerprint: "x", entries: [], decoys: [...(kept?.decoys ?? []), 7] });
    await expect(store.updateShieldedHistoryRecord(key, grow)).resolves.toMatchObject({ ownerKey: key, decoys: [7] });
    // Two at once: each sees what the other kept.
    await Promise.all([store.updateShieldedHistoryRecord(key, grow), store.updateShieldedHistoryRecord(key, grow)]);
    expect((await store.getShieldedHistoryRecord(key)).decoys).toEqual([7, 7, 7]);

    const full = new Error("The store is full");
    await expect(
      store.updateShieldedHistoryRecord(key, () => {
        throw full;
      })
    ).rejects.toBe(full);
    expect((await store.getShieldedHistoryRecord(key)).decoys).toEqual([7, 7, 7]);
  });

  it("keeps when a node answered without the archive", async () => {
    expect(await store.getArchiveRefusal("https://node.example")).toBeNull();
    await store.putArchiveRefusal("https://node.example", 42);
    expect(await store.getArchiveRefusal("https://node.example")).toBe(42);
    expect(await store.getArchiveRefusal("https://other.example")).toBeNull();
  });
});
