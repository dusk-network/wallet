import { describe, expect, it } from "vitest";

import "fake-indexeddb/auto";

import { bytesToHex } from "./bytes.js";
import * as store from "./shieldedStore.js";

let seq = 0;
function nextOwner() {
  seq += 1;
  return {
    networkKey: `netA-${seq}`,
    walletId: `walletA-${seq}`,
    profileIndex: 0,
  };
}

describe("shieldedStore (IndexedDB)", () => {
  it("creates meta with defaults and returns cursor", async () => {
    const { networkKey, walletId, profileIndex } = nextOwner();

    const meta = await store.ensureShieldedMeta(networkKey, walletId, profileIndex, {
      checkpointBookmark: 5n,
      checkpointBlock: 7n,
    });

    expect(meta.networkKey).toBe(networkKey);
    expect(meta.walletId).toBe(walletId);
    expect(meta.profileIndex).toBe(profileIndex);
    expect(meta.checkpointBookmark).toBe("5");
    expect(meta.checkpointBlock).toBe("7");
    expect(meta.cursorBookmark).toBe("5");
    expect(meta.cursorBlock).toBe("7");

    const cur = store.metaCursor(meta);
    expect(cur.bookmark).toBe(5n);
    expect(cur.block).toBe(7n);

    const meta2 = await store.getShieldedMeta(networkKey, walletId, profileIndex);
    expect(meta2).not.toBeNull();
    expect(meta2.ownerKey).toBe(meta.ownerKey);
  });

  it("round-trips notes Map", async () => {
    const { networkKey, walletId, profileIndex } = nextOwner();

    const notes = new Map();
    notes.set(new Uint8Array([0x01, 0x02]), new Uint8Array([0xaa]));
    notes.set(new Uint8Array([0x03]), new Uint8Array([0xbb, 0xcc]));

    const written = await store.putNotesMap(networkKey, walletId, profileIndex, notes);
    expect(written).toBe(2);

    const out = await store.getNotesMap(networkKey, walletId, profileIndex);
    const got = Array.from(out.entries()).map(([k, v]) => [bytesToHex(k), bytesToHex(v)]);
    got.sort((a, b) => a[0].localeCompare(b[0]));

    expect(got).toEqual([
      ["0102", "aa"],
      ["03", "bbcc"],
    ]);
  });

  it("filters pending nullifiers out of spendable notes", async () => {
    const { networkKey, walletId, profileIndex } = nextOwner();

    const n1 = new Uint8Array([0xaa]);
    const n2 = new Uint8Array([0xbb]);

    const notes = new Map();
    notes.set(n1, new Uint8Array([0x01]));
    notes.set(n2, new Uint8Array([0x02]));
    await store.putNotesMap(networkKey, walletId, profileIndex, notes);

    const pendingWritten = await store.putPendingNullifiers(
      networkKey,
      walletId,
      profileIndex,
      [n1],
      "0xdeadbeef"
    );
    expect(pendingWritten).toBe(1);

    const spendable = await store.getSpendableNotesMap(networkKey, walletId, profileIndex);
    const keys = Array.from(spendable.keys()).map((k) => bytesToHex(k));
    keys.sort();
    expect(keys).toEqual(["bb"]);
  });

  it("tracks and clears pending nullifiers by tx hash", async () => {
    const { networkKey, walletId, profileIndex } = nextOwner();

    const n1 = new Uint8Array([0xaa]);
    const n2 = new Uint8Array([0xbb]);

    const notes = new Map();
    notes.set(n1, new Uint8Array([0x01]));
    notes.set(n2, new Uint8Array([0x02]));
    await store.putNotesMap(networkKey, walletId, profileIndex, notes);
    await store.putPendingNullifiers(networkKey, walletId, profileIndex, [n1], "tx-a");
    await store.putPendingNullifiers(networkKey, walletId, profileIndex, [n2], "tx-b");

    expect(await store.getPendingNullifiersForTx(networkKey, walletId, profileIndex, "tx-a")).toEqual(["aa"]);

    const marked = await store.markPendingNullifiersRecoverable(
      networkKey,
      walletId,
      profileIndex,
      "tx-a",
      "removed"
    );
    expect(marked).toBe(1);

    let spendable = await store.getSpendableNotesMap(networkKey, walletId, profileIndex);
    expect(Array.from(spendable.keys()).map((k) => bytesToHex(k))).toEqual([]);

    const cleared = await store.clearPendingNullifiersForTx(networkKey, walletId, profileIndex, "tx-a");
    expect(cleared).toBe(1);

    spendable = await store.getSpendableNotesMap(networkKey, walletId, profileIndex);
    expect(Array.from(spendable.keys()).map((k) => bytesToHex(k))).toEqual(["aa"]);
    expect(await store.getPendingNullifiersForTx(networkKey, walletId, profileIndex, "tx-a")).toEqual([]);
    expect(await store.getPendingNullifiersForTx(networkKey, walletId, profileIndex, "tx-b")).toEqual(["bb"]);
  });

  it("moves nullifiers to spent and clears pending reservations", async () => {
    const { networkKey, walletId, profileIndex } = nextOwner();

    const n1 = new Uint8Array([0xaa]);

    const notes = new Map();
    notes.set(n1, new Uint8Array([0x01, 0x02]));
    await store.putNotesMap(networkKey, walletId, profileIndex, notes);
    await store.putPendingNullifiers(networkKey, walletId, profileIndex, [n1], "0x01");

    const moved = await store.markNullifiersSpent(networkKey, walletId, profileIndex, [n1]);
    expect(moved).toBe(1);

    expect(await store.countNotes(networkKey, walletId, profileIndex)).toBe(0);

    const unspent = await store.getUnspentNullifiers(networkKey, walletId, profileIndex);
    expect(unspent).toEqual([]);

    const spent = await store.getSpentNullifiers(networkKey, walletId, profileIndex);
    expect(spent.map((b) => bytesToHex(b))).toEqual(["aa"]);

    const spendable = await store.getSpendableNotesMap(networkKey, walletId, profileIndex);
    expect(Array.from(spendable.keys()).length).toBe(0);
  });

  it("can unspend spent nullifiers (reorg handling)", async () => {
    const { networkKey, walletId, profileIndex } = nextOwner();

    const n1 = new Uint8Array([0xaa]);

    const notes = new Map();
    notes.set(n1, new Uint8Array([0x01, 0x02]));
    await store.putNotesMap(networkKey, walletId, profileIndex, notes);
    await store.markNullifiersSpent(networkKey, walletId, profileIndex, [n1]);

    const restored = await store.unspendNullifiers(networkKey, walletId, profileIndex, [n1]);
    expect(restored).toBe(1);

    expect(await store.countNotes(networkKey, walletId, profileIndex)).toBe(1);
    const unspent = await store.getUnspentNullifiers(networkKey, walletId, profileIndex);
    expect(unspent.map((b) => bytesToHex(b))).toEqual(["aa"]);

    const spent = await store.getSpentNullifiers(networkKey, walletId, profileIndex);
    expect(spent).toEqual([]);
  });

  it("clearNotes clears notes/spent/pending for one owner only", async () => {
    const { networkKey, walletId, profileIndex } = nextOwner();

    const n1 = new Uint8Array([0xaa]);

    // Owner A: notes + pending + spent
    const notesA = new Map();
    notesA.set(n1, new Uint8Array([0x01]));
    await store.putNotesMap(networkKey, walletId, profileIndex, notesA);
    await store.putPendingNullifiers(networkKey, walletId, profileIndex, [n1], "0x01");
    await store.markNullifiersSpent(networkKey, walletId, profileIndex, [n1]);

    // Owner B: one note
    const notesB = new Map();
    notesB.set(new Uint8Array([0xbb]), new Uint8Array([0x02]));
    await store.putNotesMap(networkKey, `${walletId}-other`, profileIndex, notesB);

    await store.clearNotes(networkKey, walletId, profileIndex);

    expect(await store.countNotes(networkKey, walletId, profileIndex)).toBe(0);
    expect(await store.getSpentNullifiers(networkKey, walletId, profileIndex)).toEqual([]);

    expect(await store.countNotes(networkKey, `${walletId}-other`, profileIndex)).toBe(1);
  });
});
