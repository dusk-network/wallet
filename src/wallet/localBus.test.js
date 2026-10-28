import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({ sendTransaction: vi.fn(), unlocked: true, wallet: "wallet A" }));

// The engine's contacts key for the unlocked wallet, made as walletEngine.js
// makes it: from its seed (here, a hash of its phrase), at its own place.
async function contactsKeys() {
  if (!engine.unlocked) throw new Error("Wallet locked");
  const { contactsNamespace, deriveContactsKey } = await import("../shared/contactsCrypto.js");
  const seed = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(engine.wallet)));
  return { key: await deriveContactsKey(seed), namespace: await contactsNamespace(`account of ${engine.wallet}`) };
}

// The wallet engine without the network: a transfer just gets its hash.
vi.mock("../shared/walletEngine.js", () => ({
  // What the local bus maps commands to when it loads.
  ...Object.fromEntries(
    [
      "getMinimumStake",
      "getStakeInfo",
      "getStakeOwnerStatus",
      "getSozuStatus",
      "getDrc20Metadata",
      "getDrc20Balance",
      "encodeDrc20Input",
      "decodeDrc20Input",
      "getDrc721Metadata",
      "getDrc721OwnerOf",
      "getDrc721TokenUri",
      "decodeDrc721Input",
      "setShieldedCheckpointNow",
      "getShieldedHistory",
      "selectAccountIndex",
    ].map((name) => [name, vi.fn()])
  ),
  configure: vi.fn(),
  isUnlocked: () => engine.unlocked,
  lock: () => {
    engine.unlocked = false;
  },
  unlockWithMnemonic: async (mnemonic) => {
    engine.wallet = mnemonic;
    engine.unlocked = true;
  },
  // The wallet a phrase makes; here every phrase is "wallet …".
  walletIdOf: async (mnemonic) => {
    if (!String(mnemonic).startsWith("wallet ")) throw new Error("That isn't a valid recovery phrase.");
    return `account of ${mnemonic}`;
  },
  openContactsRecords: async (records) => {
    const { openContacts } = await import("../shared/contactsCrypto.js");
    const { key, namespace } = await contactsKeys();
    const record = Object.hasOwn(records, namespace) ? records[namespace] : null;
    return { namespace, text: record ? await openContacts(key, namespace, record) : null };
  },
  sealContactsRecord: async (text) => {
    const { sealContacts } = await import("../shared/contactsCrypto.js");
    const { key, namespace } = await contactsKeys();
    return { namespace, record: await sealContacts(key, namespace, text) };
  },
  getAccounts: () => ["acct0"],
  getSelectedAccountIndex: () => 0,
  getCachedGasPrice: vi.fn(async () => ({ median: "1" })),
  sendTransaction: engine.sendTransaction,
  // Execution is never seen here.
  waitTxExecuted: () => new Promise(() => {}),
  waitTxRemoved: () => new Promise(() => {}),
  startShieldedSync: vi.fn(async () => {}),
}));

function memoryStorage() {
  const store = new Map();
  return {
    get length() {
      return store.size;
    },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => store.get(String(k)) ?? null,
    setItem: (k, v) => store.set(String(k), String(v)),
    removeItem: (k) => store.delete(String(k)),
    clear: () => store.clear(),
  };
}

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  engine.sendTransaction.mockReset();
  engine.unlocked = true;
  engine.wallet = "wallet A";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local sends", () => {
  it("keep the profile that paid, which a stake's may not be the one selected", async () => {
    const { localSend } = await import("./localBus.js");
    const { getTxMeta } = await import("../shared/txStore.js");
    engine.sendTransaction.mockResolvedValueOnce({ hash: "cc".repeat(32), nonce: 1n });
    await localSend({ type: "DUSK_UI_SEND_TX", params: { kind: "stake", amount: "1000000000000", profileIndex: 1 } });
    await expect(getTxMeta("cc".repeat(32))).resolves.toMatchObject({ kind: "stake", profileIndex: 1 });
  });

  it("keep nothing of a send that finished after a wallet reset", async () => {
    const { localSend } = await import("./localBus.js");
    const { clearTxs, listTxs } = await import("../shared/txStore.js");
    const sent = Promise.withResolvers();
    engine.sendTransaction.mockReturnValueOnce(sent.promise);
    const params = { kind: "transfer", privacy: "public", to: ACCOUNT, amount: "1" };
    const response = localSend({ type: "DUSK_UI_SEND_TX", params });
    await vi.waitFor(() => expect(engine.sendTransaction).toHaveBeenCalled());
    // The reset's clear, while the send was out.
    await clearTxs();
    sent.resolve({ hash: "dd".repeat(32), nonce: 1n });
    await expect(response).resolves.toMatchObject({ ok: true });
    await expect(listTxs()).resolves.toEqual([]);
  });

  it("keep the .dusk name the recipient was typed as, and nothing that isn't one", async () => {
    const { localSend } = await import("./localBus.js");
    const { listTxs } = await import("../shared/txStore.js");
    const params = { kind: "transfer", privacy: "public", to: ACCOUNT, amount: "1000000000" };

    engine.sendTransaction.mockResolvedValueOnce({ hash: "aa".repeat(32), nonce: 1n });
    await expect(localSend({ type: "DUSK_UI_SEND_TX", params, toName: "alice.dusk" })).resolves.toMatchObject({ ok: true });
    engine.sendTransaction.mockResolvedValueOnce({ hash: "bb".repeat(32), nonce: 2n });
    await localSend({ type: "DUSK_UI_SEND_TX", params, toName: "not a name" });

    const byHash = Object.fromEntries((await listTxs()).map((tx) => [tx.hash, tx]));
    expect(byHash["aa".repeat(32)]).toMatchObject({ to: ACCOUNT, toName: "alice.dusk", status: "submitted" });
    expect(byHash["bb".repeat(32)].toName).toBeUndefined();
  });
});

describe("a wallet reset", () => {
  it("leaves nothing of the old wallet: its transactions, shielded notes and history", async () => {
    const { localSend } = await import("./localBus.js");
    const txs = await import("../shared/txStore.js");
    const shielded = await import("../shared/shieldedStore.js");
    const activity = await import("../shared/activityStore.js");
    const owner = activity.activityOwnerKey("testnet", ACCOUNT);
    await txs.putTxMeta("aa".repeat(32), { status: "executed", submittedAt: 1 });
    await shielded.putNotesMap("net", "acct0", 0, new Map([[new Uint8Array([1]), new Uint8Array([2])]]));
    await activity.commitActivityStep(owner, [{ hash: "bb".repeat(32), blockHeight: 7 }], () => ({ covered: [[0, 9]] }));

    await expect(localSend({ type: "DUSK_UI_RESET_WALLET" })).resolves.toEqual({ ok: true });

    expect(await txs.listTxs()).toEqual([]);
    expect(await shielded.countNotes("net", "acct0", 0)).toBe(0);
    expect(await activity.listActivityEntries(owner)).toEqual([]);
    expect(await activity.getActivityMeta(owner)).toBeNull();
  });

  it("fails while the old wallet's data can't be cleared, and makes no new wallet until it can", async () => {
    const { localSend } = await import("./localBus.js");
    const activity = await import("../shared/activityStore.js");
    const epoch = await activity.getActivityEpoch();
    const clear = vi.spyOn(IDBObjectStore.prototype, "clear").mockImplementation(() => {
      throw new DOMException("The store is gone", "UnknownError");
    });
    try {
      const reset = await localSend({ type: "DUSK_UI_RESET_WALLET" });
      expect(reset.error.message).toMatch(/old wallet.s data couldn.t be cleared/);
      const create = await localSend({ type: "DUSK_UI_CREATE_WALLET", mnemonic: "wallet B", password: "password123" });
      expect(create.error.message).toMatch(/old wallet.s data couldn.t be cleared/);
    } finally {
      clear.mockRestore();
    }
    // The failed clear changed nothing.
    expect(await activity.getActivityEpoch()).toBe(epoch);
  });
});

describe("contacts", () => {
  const LABEL = "Alice (landlord, private)";
  const contacts = async (message) => {
    const { localSend } = await import("./localBus.js");
    const res = await localSend({ type: "DUSK_UI_CONTACTS", ...message });
    if (res.error) throw new Error(res.error.message);
    return res.result;
  };
  // What this browser keeps, as text.
  const kept = () => JSON.stringify(Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => [localStorage.key(i), localStorage.getItem(localStorage.key(i))])));
  // Contacts in plain text, as a wallet before this one kept them.
  const leavePlain = (entries) =>
    localStorage.setItem("dusk_addressbook_v1", JSON.stringify(Object.fromEntries(entries.map((e) => [e.id, e]))));

  it("are kept encrypted, and a reset deletes them", async () => {
    const { localSend } = await import("./localBus.js");
    await contacts({ op: "upsert", entry: { name: LABEL, address: ACCOUNT } });
    expect(kept()).not.toContain("landlord");
    expect(kept()).not.toContain(ACCOUNT.slice(0, 16));
    expect((await contacts({ op: "list" })).map((e) => e.name)).toEqual([LABEL]);

    await expect(localSend({ type: "DUSK_UI_RESET_WALLET" })).resolves.toEqual({ ok: true });
    expect(localStorage.getItem("dusk_contacts_v2")).toBeNull();
  });

  it("read nothing while the wallet is locked", async () => {
    await contacts({ op: "upsert", entry: { name: LABEL, address: ACCOUNT } });
    engine.unlocked = false;
    await expect(contacts({ op: "list" })).rejects.toThrow("Wallet locked");
  });

  it("start with none in a new wallet, even when an older one left plain ones here", async () => {
    const { localSend } = await import("./localBus.js");
    await contacts({ op: "upsert", entry: { name: LABEL, address: ACCOUNT } });
    await localSend({ type: "DUSK_UI_RESET_WALLET" });
    leavePlain([{ id: "1", name: LABEL, address: ACCOUNT, updatedAt: 1 }]);

    const created = await localSend({ type: "DUSK_UI_CREATE_WALLET", mnemonic: "wallet B", password: "password123" });
    expect(created).toMatchObject({ ok: true });
    expect(await contacts({ op: "list" })).toEqual([]);
    expect(kept()).not.toContain("landlord");
  });

  it("move from plain text into the wallet's record on the first unlock, and the plain copy goes", async () => {
    const { localSend } = await import("./localBus.js");
    await localSend({ type: "DUSK_UI_RESET_WALLET" });
    await localSend({ type: "DUSK_UI_CREATE_WALLET", mnemonic: "wallet A", password: "password123" });
    await contacts({ op: "upsert", entry: { id: "2", name: "Bob", address: "addr2" } });
    await localSend({ type: "DUSK_UI_LOCK" });
    // Left by the wallet before it was updated.
    leavePlain([{ id: "1", name: LABEL, address: ACCOUNT, updatedAt: 1 }]);

    await expect(localSend({ type: "DUSK_UI_UNLOCK", password: "password123" })).resolves.toMatchObject({ ok: true });
    expect(localStorage.getItem("dusk_addressbook_v1")).toBeNull();
    expect(kept()).not.toContain("landlord");
    expect((await contacts({ op: "list" })).map((e) => e.name)).toEqual([LABEL, "Bob"]);
  });

  describe("on a restore after a forgotten password", () => {
    // Wallet A with a contact, locked, as its owner finds it.
    const walletA = async () => {
      const { localSend } = await import("./localBus.js");
      await localSend({ type: "DUSK_UI_RESET_WALLET" });
      await localSend({ type: "DUSK_UI_CREATE_WALLET", mnemonic: "wallet A", password: "password123" });
      await contacts({ op: "upsert", entry: { name: LABEL, address: ACCOUNT } });
      await localSend({ type: "DUSK_UI_LOCK" });
      return localSend;
    };

    it("stay for the same wallet, under its new password, and go for another's", async () => {
      const localSend = await walletA();
      leavePlain([{ id: "1", name: "Old", address: ACCOUNT, updatedAt: 1 }]);
      await expect(localSend({ type: "DUSK_UI_RESTORE_WALLET", mnemonic: "wallet A", password: "new password" })).resolves.toMatchObject({ ok: true });
      expect((await contacts({ op: "list" })).map((e) => e.name)).toEqual([LABEL]);
      // No wallet can be told by a plain copy: it goes.
      expect(localStorage.getItem("dusk_addressbook_v1")).toBeNull();
      await localSend({ type: "DUSK_UI_LOCK" });
      await expect(localSend({ type: "DUSK_UI_UNLOCK", password: "new password" })).resolves.toMatchObject({ ok: true });

      await localSend({ type: "DUSK_UI_LOCK" });
      await expect(localSend({ type: "DUSK_UI_RESTORE_WALLET", mnemonic: "wallet B", password: "new password" })).resolves.toMatchObject({ ok: true });
      expect(await contacts({ op: "list" })).toEqual([]);
      expect(localStorage.getItem("dusk_contacts_v2")).toBeNull();
    });

    // The new vault's write fails once, after the old vault went: a storage
    // error, or the app shut between the two.
    const failNextVaultWrite = () => {
      const write = localStorage.setItem;
      localStorage.setItem = (key, value) => {
        if (key === "dusk_vault_v1") {
          localStorage.setItem = write;
          throw new Error("Storage is full");
        }
        return write(key, value);
      };
    };

    it.each([
      ["keep for the next import of the same wallet", "wallet A", [LABEL]],
      ["go for an import of another wallet", "wallet B", []],
    ])("cut short before the new vault, %s", async (_, phrase, names) => {
      const localSend = await walletA();
      failNextVaultWrite();
      const restore = await localSend({ type: "DUSK_UI_RESTORE_WALLET", mnemonic: "wallet A", password: "new password" });
      expect(restore.error.message).toBe("Storage is full");
      await expect(localSend({ type: "DUSK_UI_STATUS" })).resolves.toMatchObject({ hasVault: false });

      // Onboarding's import, the only way on from there.
      await expect(localSend({ type: "DUSK_UI_CREATE_WALLET", mnemonic: phrase, password: "password456" })).resolves.toMatchObject({ ok: true });
      expect((await contacts({ op: "list" })).map((e) => e.name)).toEqual(names);
      // Done: the next wallet made after a reset starts with none.
      expect(localStorage.getItem("dusk_reset_pending_v1")).toBeNull();
    });

    it("leave everything as it was for a phrase that isn't one", async () => {
      const localSend = await walletA();
      const txs = await import("../shared/txStore.js");
      await txs.putTxMeta("aa".repeat(32), { status: "executed", submittedAt: 1 });
      const before = kept();
      const restore = await localSend({ type: "DUSK_UI_RESTORE_WALLET", mnemonic: "not a phrase", password: "new password" });
      expect(restore.error.message).toBe("That isn't a valid recovery phrase.");
      expect(kept()).toBe(before);
      await expect(localSend({ type: "DUSK_UI_UNLOCK", password: "password123" })).resolves.toMatchObject({ ok: true });
      expect((await contacts({ op: "list" })).map((e) => e.name)).toEqual([LABEL]);
    });
  });
});
