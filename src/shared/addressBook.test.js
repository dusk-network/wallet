import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the storage module before importing addressBook
vi.mock("./storage.js", () => {
  let store = {};
  return {
    storage: {
      get: vi.fn(async (key) => ({ [key]: store[key] })),
      set: vi.fn(async (obj) => {
        Object.assign(store, obj);
      }),
    },
    STORAGE_KEYS: {
      ADDRESS_BOOK: "dusk_address_book_v1",
    },
    // Helper to reset store between tests
    __resetStore: () => {
      store = {};
    },
    __getStore: () => store,
  };
});

// Import after mocking
const { storage, STORAGE_KEYS, __resetStore, __getStore } = await import("./storage.js");
const {
  listAddressBook,
  getAddressBookEntry,
  upsertAddressBookEntry,
  removeAddressBookEntry,
  clearAddressBook,
} = await import("./addressBook.js");

describe("addressBook", () => {
  beforeEach(() => {
    __resetStore();
    vi.clearAllMocks();
  });

  describe("listAddressBook", () => {
    it("returns empty array when no entries", async () => {
      const result = await listAddressBook();
      expect(result).toEqual([]);
    });

    it("returns entries sorted by name", async () => {
      const store = {
        "1": { id: "1", name: "Charlie", address: "addr1", updatedAt: 100 },
        "2": { id: "2", name: "Alice", address: "addr2", updatedAt: 200 },
        "3": { id: "3", name: "Bob", address: "addr3", updatedAt: 150 },
      };
      await storage.set({ [STORAGE_KEYS.ADDRESS_BOOK]: store });

      const result = await listAddressBook();
      expect(result.map((e) => e.name)).toEqual(["Alice", "Bob", "Charlie"]);
    });

    it("filters by query (name)", async () => {
      const store = {
        "1": { id: "1", name: "Alice Smith", address: "addr1", updatedAt: 100 },
        "2": { id: "2", name: "Bob Jones", address: "addr2", updatedAt: 200 },
      };
      await storage.set({ [STORAGE_KEYS.ADDRESS_BOOK]: store });

      const result = await listAddressBook({ query: "alice" });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Alice Smith");
    });

    it("filters by query (address)", async () => {
      const store = {
        "1": { id: "1", name: "Alice", address: "abc123", updatedAt: 100 },
        "2": { id: "2", name: "Bob", address: "xyz789", updatedAt: 200 },
      };
      await storage.set({ [STORAGE_KEYS.ADDRESS_BOOK]: store });

      const result = await listAddressBook({ query: "xyz" });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Bob");
    });

    it("is case insensitive for queries", async () => {
      const store = {
        "1": { id: "1", name: "Alice", address: "ABC123", updatedAt: 100 },
      };
      await storage.set({ [STORAGE_KEYS.ADDRESS_BOOK]: store });

      const result = await listAddressBook({ query: "abc" });
      expect(result).toHaveLength(1);
    });
  });

  describe("getAddressBookEntry", () => {
    it("returns null for non-existent entry", async () => {
      const result = await getAddressBookEntry("non-existent");
      expect(result).toBeNull();
    });

    it("returns null for empty id", async () => {
      expect(await getAddressBookEntry("")).toBeNull();
      expect(await getAddressBookEntry(null)).toBeNull();
    });

    it("returns entry by id", async () => {
      const store = {
        "test-id": { id: "test-id", name: "Alice", address: "addr1" },
      };
      await storage.set({ [STORAGE_KEYS.ADDRESS_BOOK]: store });

      const result = await getAddressBookEntry("test-id");
      expect(result).toMatchObject({ id: "test-id", name: "Alice" });
    });
  });

  describe("upsertAddressBookEntry", () => {
    it("creates new entry with generated id", async () => {
      const result = await upsertAddressBookEntry({
        name: "Alice",
        address: "addr123",
      });

      expect(result.id).toBeDefined();
      expect(result.name).toBe("Alice");
      expect(result.address).toBe("addr123");
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
    });

    it("updates existing entry", async () => {
      const created = await upsertAddressBookEntry({
        name: "Alice",
        address: "addr123",
      });

      const updated = await upsertAddressBookEntry({
        id: created.id,
        name: "Alice Updated",
        address: "newaddr",
      });

      expect(updated.id).toBe(created.id);
      expect(updated.name).toBe("Alice Updated");
      expect(updated.address).toBe("newaddr");
      expect(updated.createdAt).toBe(created.createdAt);
      expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    });

    it("trims name and address", async () => {
      const result = await upsertAddressBookEntry({
        name: "  Alice  ",
        address: "  addr123  ",
      });

      expect(result.name).toBe("Alice");
      expect(result.address).toBe("addr123");
    });

    it("defaults type to unknown", async () => {
      const result = await upsertAddressBookEntry({
        name: "Alice",
        address: "addr",
      });

      expect(result.type).toBe("unknown");
    });

    it("preserves existing type on update", async () => {
      const created = await upsertAddressBookEntry({
        name: "Alice",
        address: "addr",
        type: "account",
      });

      const updated = await upsertAddressBookEntry({
        id: created.id,
        name: "Alice Updated",
        address: "addr",
      });

      expect(updated.type).toBe("account");
    });

    it("falls back to timestamp id when crypto.randomUUID throws", async () => {
      const c = globalThis.crypto;
      expect(c).toBeTruthy();

      // Override crypto.randomUUID to throw to exercise the catch branch.
      Object.defineProperty(c, "randomUUID", {
        value: () => {
          throw new Error("boom");
        },
        configurable: true,
      });

      try {
        const result = await upsertAddressBookEntry({ name: "Alice", address: "addr123" });
        expect(typeof result.id).toBe("string");
        expect(result.id.length).toBeGreaterThan(0);
      } finally {
        // Restore prototype-provided randomUUID.
        try {
          delete c.randomUUID;
        } catch {
          // ignore
        }
      }
    });

    it("prunes to 200 entries by oldest updatedAt", async () => {
      const nowSpy = vi.spyOn(Date, "now");
      let t = 1;
      nowSpy.mockImplementation(() => t++);

      try {
        for (let i = 0; i < 205; i++) {
          await upsertAddressBookEntry({
            id: String(i),
            name: `Name ${i}`,
            address: `addr${i}`,
          });
        }

        const stored = __getStore()?.[STORAGE_KEYS.ADDRESS_BOOK] ?? {};
        expect(Object.keys(stored)).toHaveLength(200);

        // Oldest 5 should be gone.
        for (let i = 0; i < 5; i++) {
          expect(stored[String(i)]).toBeUndefined();
        }
        expect(stored["5"]).toBeTruthy();
        expect(stored["204"]).toBeTruthy();
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  describe("removeAddressBookEntry", () => {
    it("removes entry by id", async () => {
      const created = await upsertAddressBookEntry({
        name: "Alice",
        address: "addr",
      });

      await removeAddressBookEntry(created.id);

      const result = await getAddressBookEntry(created.id);
      expect(result).toBeNull();
    });

    it("does nothing for non-existent id", async () => {
      // Should not throw
      await removeAddressBookEntry("non-existent");
    });

    it("does nothing for empty id", async () => {
      await removeAddressBookEntry("");
      await removeAddressBookEntry(null);
    });
  });

  it("sorts by updatedAt when names are equal (newest first)", async () => {
    const store = {
      "1": { id: "1", name: "Alice", address: "addr1", updatedAt: 100 },
      "2": { id: "2", name: "Alice", address: "addr2", updatedAt: 200 },
    };
    await storage.set({ [STORAGE_KEYS.ADDRESS_BOOK]: store });

    const result = await listAddressBook();
    expect(result.map((e) => e.id)).toEqual(["2", "1"]);
  });

  it("clears all address book entries", async () => {
    await upsertAddressBookEntry({ name: "Alice", address: "addr" });
    expect(await listAddressBook()).toHaveLength(1);

    await clearAddressBook();
    expect(await listAddressBook()).toEqual([]);
  });
});
