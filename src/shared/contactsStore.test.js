import { beforeEach, describe, expect, it, vi } from "vitest";

import { contactsNamespace, deriveContactsKey, openContacts, sealContacts } from "./contactsCrypto.js";

// chrome.storage.local, in memory: get takes a key or a list of keys, as the
// platform's adapters do.
vi.mock("./storage.js", () => {
  let data = {};
  const pick = (keys) =>
    Object.fromEntries([].concat(keys).filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
  return {
    storage: {
      get: vi.fn(async (keys) => pick(keys)),
      set: vi.fn(async (items) => {
        Object.assign(data, structuredClone(items));
      }),
      remove: vi.fn(async (keys) => {
        for (const k of [].concat(keys)) delete data[k];
      }),
    },
    STORAGE_KEYS: { ADDRESS_BOOK: "dusk_addressbook_v1", CONTACTS: "dusk_contacts_v2" },
    __reset: () => {
      data = {};
    },
    __data: () => data,
  };
});

const { storage, STORAGE_KEYS, __reset, __data } = await import("./storage.js");
const { clearContacts, contactsStore, keepOnlyContactsOf, moveLegacyContacts } = await import("./contactsStore.js");

const ACCOUNT_A = "qxwSidLBa1rJ74ngfP4GUCaNsAYjMboDPHzbmiVEMmNNK26hVkYe8QccH6ipYdVRsUDnx9QS1KBeu8ZoMDFpXJJE6YCcHy2AykvJ7eEAGc7PGDgCZFV5YJBxzukADkQ2Bgr";
const ACCOUNT_B = "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const LABEL = "Alice (landlord, private)";

// A wallet's vault, as the engine opens and seals its record: the key from
// its seed, the place from its first public account (walletEngine.js).
function vaultOf(seedByte, walletId) {
  const made = Promise.all([deriveContactsKey(new Uint8Array(64).fill(seedByte)), contactsNamespace(walletId)]);
  return {
    open: vi.fn(async (records) => {
      const [key, namespace] = await made;
      const record = Object.hasOwn(records, namespace) ? records[namespace] : null;
      return { namespace, text: record ? await openContacts(key, namespace, record) : null };
    }),
    seal: vi.fn(async (text) => {
      const [key, namespace] = await made;
      return { namespace, record: await sealContacts(key, namespace, text) };
    }),
  };
}

const records = () => __data()[STORAGE_KEYS.CONTACTS] ?? {};
const plainOf = (entries) => ({ [STORAGE_KEYS.ADDRESS_BOOK]: Object.fromEntries(entries.map((e) => [e.id, e])) });

let vault;
let book;
beforeEach(() => {
  __reset();
  vi.clearAllMocks();
  vault = vaultOf(1, ACCOUNT_A);
  book = contactsStore(vault);
});

describe("contacts at rest", () => {
  it("keep no plaintext: no label, address or .dusk name, only the wallet's sealed record", async () => {
    await book.upsert({ name: LABEL, address: ACCOUNT_B, type: "account", duskName: "alice.dusk", checkedAt: 5 });
    const kept = JSON.stringify(__data());
    for (const secret of ["landlord", "Alice", "alice.dusk", ACCOUNT_B.slice(0, 16)]) expect(kept).not.toContain(secret);
    const place = await contactsNamespace(ACCOUNT_A);
    expect(Object.keys(__data())).toEqual([STORAGE_KEYS.CONTACTS]);
    expect(Object.keys(records())).toEqual([place]);
    expect(Object.keys(records()[place]).sort()).toEqual(["data", "iv", "v"]);
    // Each write seals afresh.
    const before = records()[place].iv;
    await book.upsert({ name: "Bob", address: "addr" });
    expect(records()[place].iv).not.toBe(before);
    expect((await book.list()).map((e) => e.name)).toEqual([LABEL, "Bob"]);
  });

  it("belong to one wallet: another restored here finds none, and its own stay apart", async () => {
    await book.upsert({ name: LABEL, address: ACCOUNT_B });
    const otherVault = vaultOf(2, ACCOUNT_B);
    const other = contactsStore(otherVault);
    expect(await other.list()).toEqual([]);
    // It found no record at its place: the first wallet's is at another.
    await expect(otherVault.open.mock.results[0].value).resolves.toEqual({ namespace: await contactsNamespace(ACCOUNT_B), text: null });
    await other.upsert({ name: "Mine", address: "addr" });
    expect(Object.keys(records())).toHaveLength(2);
    expect((await other.list()).map((e) => e.name)).toEqual(["Mine"]);
    expect((await book.list()).map((e) => e.name)).toEqual([LABEL]);
  });

  it("fail closed with a wrong key: nothing reads, and nothing is written over them", async () => {
    await book.upsert({ name: LABEL, address: ACCOUNT_B });
    const kept = structuredClone(records());
    // Another seed at the same place.
    const wrong = contactsStore(vaultOf(9, ACCOUNT_A));
    await expect(wrong.list()).rejects.toThrow("couldn't be read with this wallet's key");
    await expect(wrong.upsert({ name: "Eve", address: "addr" })).rejects.toThrow("couldn't be read");
    await expect(wrong.remove(Object.keys(kept)[0])).rejects.toThrow("couldn't be read");
    expect(records()).toEqual(kept);
    expect((await book.list()).map((e) => e.name)).toEqual([LABEL]);
  });

  it("read nothing while the wallet is locked, and write nothing", async () => {
    await book.upsert({ name: LABEL, address: ACCOUNT_B });
    const kept = structuredClone(__data());
    const locked = contactsStore({
      open: async () => {
        throw new Error("Wallet locked");
      },
      seal: async () => {
        throw new Error("Wallet locked");
      },
    });
    await expect(locked.list()).rejects.toThrow("Wallet locked");
    await expect(locked.upsert({ name: "Eve", address: "addr" })).rejects.toThrow("Wallet locked");
    expect(__data()).toEqual(kept);
  });

  it("are written only at the place they were read from", async () => {
    await book.upsert({ name: LABEL, address: ACCOUNT_B });
    const kept = structuredClone(records());
    // The wallet changed between the read and the write.
    const changing = { open: vault.open, seal: vaultOf(2, ACCOUNT_B).seal };
    await expect(contactsStore(changing).upsert({ name: "Eve", address: "addr" })).rejects.toThrow("The wallet changed");
    expect(records()).toEqual(kept);
  });
});

describe("contacts from before they were encrypted", () => {
  const plain = [
    { id: "1", name: LABEL, address: ACCOUNT_B, type: "account", createdAt: 1, updatedAt: 1 },
    { id: "2", name: "Bob", address: "addr2", type: "unknown", createdAt: 2, updatedAt: 2 },
  ];

  it("move into the unlocked wallet's record, and the plain copy goes", async () => {
    await storage.set(plainOf(plain));
    await moveLegacyContacts(vault);
    expect(STORAGE_KEYS.ADDRESS_BOOK in __data()).toBe(false);
    expect(JSON.stringify(__data())).not.toContain("landlord");
    expect(await book.list()).toEqual([plain[0], plain[1]]);
    // Once.
    await moveLegacyContacts(vault);
    expect(vault.seal).toHaveBeenCalledTimes(1);
  });

  it("move on the first read too, beside the record's own, which win", async () => {
    await book.upsert({ id: "2", name: "Bobby", address: "addr2" });
    await storage.set(plainOf(plain));
    expect((await book.list()).map((e) => [e.id, e.name])).toEqual([
      ["1", LABEL],
      ["2", "Bobby"],
    ]);
    expect(STORAGE_KEYS.ADDRESS_BOOK in __data()).toBe(false);
  });

  it("stay where they are while the wallet is locked", async () => {
    await storage.set(plainOf(plain));
    const locked = { open: async () => Promise.reject(new Error("Wallet locked")), seal: vi.fn() };
    await expect(moveLegacyContacts(locked)).rejects.toThrow("Wallet locked");
    expect(__data()[STORAGE_KEYS.ADDRESS_BOOK]).toBeTruthy();
    expect(locked.seal).not.toHaveBeenCalled();
  });

  it("are left alone when there are none", async () => {
    await moveLegacyContacts(vault);
    expect(vault.open).not.toHaveBeenCalled();
    expect(__data()).toEqual({});
  });
});

describe("deleting every contact", () => {
  it("removes every wallet's record and any plain copy, without a key", async () => {
    await book.upsert({ name: LABEL, address: ACCOUNT_B });
    await contactsStore(vaultOf(2, ACCOUNT_B)).upsert({ name: "Mine", address: "addr" });
    await storage.set(plainOf([{ id: "9", name: "Old", address: "addr9" }]));
    await clearContacts();
    expect(__data()).toEqual({});
    expect(await book.list()).toEqual([]);
  });
});

describe("a restore", () => {
  it("keeps only the restored wallet's record, and no plain copy, which no wallet can be told by", async () => {
    await book.upsert({ name: LABEL, address: ACCOUNT_B });
    await contactsStore(vaultOf(2, ACCOUNT_B)).upsert({ name: "Mine", address: "addr" });
    await storage.set(plainOf([{ id: "9", name: "Old", address: "addr9" }]));
    await keepOnlyContactsOf(ACCOUNT_A);
    expect(Object.keys(__data())).toEqual([STORAGE_KEYS.CONTACTS]);
    expect(Object.keys(records())).toEqual([await contactsNamespace(ACCOUNT_A)]);
    expect((await book.list()).map((e) => e.name)).toEqual([LABEL]);
    // A wallet with none here keeps none.
    await keepOnlyContactsOf(ACCOUNT_B);
    expect(__data()).toEqual({});
  });
});

describe("listing", () => {
  const seed = async (entries) => {
    for (const e of entries) await book.upsert(e);
  };

  it("returns none when there are none", async () => {
    expect(await book.list()).toEqual([]);
  });

  it("orders by name, then the newest first", async () => {
    const now = vi.spyOn(Date, "now");
    let t = 100;
    now.mockImplementation(() => (t += 10));
    try {
      await seed([
        { id: "1", name: "Charlie", address: "addr1" },
        { id: "2", name: "Alice", address: "addr2" },
        { id: "3", name: "Bob", address: "addr3" },
        { id: "4", name: "Alice", address: "addr4" },
      ]);
    } finally {
      now.mockRestore();
    }
    expect((await book.list()).map((e) => e.id)).toEqual(["4", "2", "3", "1"]);
  });

  it("filters by name, address or .dusk name, ignoring case", async () => {
    await seed([
      { id: "1", name: "Alice Smith", address: "ABC123" },
      { id: "2", name: "Bob Jones", address: "xyz789", duskName: "bob.dusk" },
    ]);
    expect((await book.list({ query: "alice" })).map((e) => e.id)).toEqual(["1"]);
    expect((await book.list({ query: "xyz" })).map((e) => e.id)).toEqual(["2"]);
    expect((await book.list({ query: "abc" })).map((e) => e.id)).toEqual(["1"]);
    expect((await book.list({ query: "BOB.DUSK" })).map((e) => e.id)).toEqual(["2"]);
  });

  it("gets one by its ID", async () => {
    const saved = await book.upsert({ id: "test-id", name: "Alice", address: "addr1" });
    expect(await book.get("test-id")).toEqual(saved);
    expect(await book.get("missing")).toBeNull();
    expect(await book.get("")).toBeNull();
    expect(await book.get(null)).toBeNull();
  });
});

describe("saving", () => {
  it("creates a contact with an ID and times", async () => {
    const result = await book.upsert({ name: "  Alice  ", address: "  addr123  " });
    expect(result).toMatchObject({ name: "Alice", address: "addr123", type: "unknown" });
    expect(typeof result.id).toBe("string");
    expect(result.createdAt).toBe(result.updatedAt);
  });

  it("updates one, keeping when it was made and its type", async () => {
    const created = await book.upsert({ name: "Alice", address: "addr123", type: "account" });
    const updated = await book.upsert({ id: created.id, name: "Alice Updated", address: "newaddr" });
    expect(updated).toMatchObject({ id: created.id, name: "Alice Updated", address: "newaddr", type: "account", createdAt: created.createdAt });
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
  });

  it("keeps a .dusk name in lower case, and when it was checked", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(777);
    try {
      expect(await book.upsert({ name: "Shop", address: "addr", duskName: " Shop.DUSK ", checkedAt: 5 })).toMatchObject({ duskName: "shop.dusk", checkedAt: 5 });
      expect(await book.upsert({ name: "Shop", address: "addr", duskName: "shop.dusk", checkedAt: null })).toMatchObject({ checkedAt: 777 });
      expect(await book.upsert({ name: "Shop", address: "addr" })).not.toHaveProperty("duskName");
    } finally {
      now.mockRestore();
    }
  });

  it("falls back to a timestamp ID when crypto.randomUUID throws", async () => {
    const uuid = vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
      throw new Error("boom");
    });
    try {
      const result = await book.upsert({ name: "Alice", address: "addr123" });
      expect(result.id).toMatch(/^\d+-/);
    } finally {
      uuid.mockRestore();
    }
  });

  it("keeps the newest 200", async () => {
    const now = vi.spyOn(Date, "now");
    let t = 1;
    now.mockImplementation(() => t++);
    try {
      for (let i = 0; i < 205; i++) await book.upsert({ id: String(i), name: `Name ${i}`, address: `addr${i}` });
    } finally {
      now.mockRestore();
    }
    const ids = new Set((await book.list()).map((e) => e.id));
    expect(ids.size).toBe(200);
    for (let i = 0; i < 5; i++) expect(ids.has(String(i))).toBe(false);
    expect(ids.has("5") && ids.has("204")).toBe(true);
  });
});

describe("marking a .dusk name checked", () => {
  it("marks the contact as saved, and only while it's the one checked", async () => {
    const checked = await book.upsert({ name: "Shop", address: "addr", duskName: "shop.dusk", checkedAt: 1 });
    const marked = await book.markChecked(checked, 5000);
    expect(marked).toEqual({ ...checked, checkedAt: 5000 });
    expect(await book.get(checked.id)).toEqual(marked);

    // Edited during the check: the edit stands.
    const edited = await book.upsert({ ...checked, name: "Corner shop", checkedAt: 2 });
    expect(await book.markChecked(checked, 6000)).toBeNull();
    expect(await book.get(checked.id)).toEqual(edited);
    for (const change of [{ address: "other" }, { duskName: "other.dusk" }]) {
      const changed = await book.upsert({ ...edited, ...change });
      expect(await book.markChecked(edited, 7000)).toBeNull();
      expect((await book.get(checked.id)).checkedAt).toBe(changed.checkedAt);
    }

    // Deleted during the check: it stays deleted.
    await book.remove(checked.id);
    expect(await book.markChecked(checked, 8000)).toBeNull();
    expect(await book.list()).toEqual([]);
    // Nothing to check.
    expect(await book.markChecked({ id: "x" })).toBeNull();
    expect(await book.markChecked(null)).toBeNull();
  });

  // A check whose read of the book waits, holding the book as it was.
  function holdNextRead() {
    const read = Promise.withResolvers();
    const held = Promise.withResolvers();
    const get = storage.get.getMockImplementation();
    storage.get.mockImplementationOnce(async (keys) => {
      const before = await get(keys);
      read.resolve();
      await held.promise;
      return before;
    });
    return { read: read.promise, release: held.resolve };
  }

  it.each([
    ["deleted", (entry) => book.remove(entry.id), () => []],
    ["edited", (entry) => book.upsert({ ...entry, name: "Corner shop" }), () => [expect.objectContaining({ name: "Corner shop" })]],
  ])("leaves a contact %s during the check as the change left it", async (_change, change, expected) => {
    const checked = await book.upsert({ name: "Shop", address: "addr", duskName: "shop.dusk", checkedAt: 1 });
    const { read, release } = holdNextRead();
    const mark = book.markChecked(checked, 5000);
    await read;
    const changed = change(checked);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await Promise.all([mark, changed]);
    expect(await book.list()).toEqual(expected());
  });
});

describe("deleting a contact", () => {
  it("removes it, and does nothing for an ID it doesn't have", async () => {
    const created = await book.upsert({ name: "Alice", address: "addr" });
    await book.remove(created.id);
    expect(await book.get(created.id)).toBeNull();
    const writes = vault.seal.mock.calls.length;
    await book.remove("missing");
    await book.remove("");
    await book.remove(null);
    expect(vault.seal).toHaveBeenCalledTimes(writes);
  });
});
