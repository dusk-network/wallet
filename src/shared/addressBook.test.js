import { beforeEach, describe, expect, it, vi } from "vitest";

// The pages ask the background, which keeps the contacts encrypted.
vi.mock("../wallet/bus.js", () => ({ send: vi.fn() }));

const { send } = await import("../wallet/bus.js");
const { clearAddressBook, listAddressBook, markAddressBookNameChecked, removeAddressBookEntry, upsertAddressBookEntry } = await import(
  "./addressBook.js"
);

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ ok: true, result: null });
});

describe("the pages' contacts", () => {
  it("ask the background for each change, by what it is", async () => {
    const entry = { id: "1", name: "Shop", address: "addr", duskName: "shop.dusk" };
    send.mockResolvedValueOnce({ ok: true, result: [entry] });
    expect(await listAddressBook({ query: "sh" })).toEqual([entry]);
    send.mockResolvedValueOnce({ ok: true, result: entry });
    expect(await upsertAddressBookEntry({ name: "Shop", address: "addr" })).toEqual(entry);
    await markAddressBookNameChecked(entry, 5000);
    await removeAddressBookEntry("1");
    await clearAddressBook();
    expect(send.mock.calls.map(([message]) => message)).toEqual([
      { type: "DUSK_UI_CONTACTS", op: "list", query: "sh" },
      { type: "DUSK_UI_CONTACTS", op: "upsert", entry: { name: "Shop", address: "addr" } },
      { type: "DUSK_UI_CONTACTS", op: "markChecked", entry, checkedAt: 5000 },
      { type: "DUSK_UI_CONTACTS", op: "remove", id: "1" },
      { type: "DUSK_UI_CONTACTS", op: "clear" },
    ]);
  });

  it("list none when the answer holds none, and ask nothing to delete no contact", async () => {
    expect(await listAddressBook()).toEqual([]);
    expect(send).toHaveBeenLastCalledWith({ type: "DUSK_UI_CONTACTS", op: "list", query: "" });
    send.mockClear();
    await removeAddressBookEntry("");
    expect(send).not.toHaveBeenCalled();
  });

  it("fail with the background's reason, as while the wallet is locked", async () => {
    send.mockResolvedValueOnce({ error: { code: 4100, message: "Wallet locked" } });
    await expect(listAddressBook()).rejects.toThrow("Wallet locked");
    send.mockResolvedValueOnce({ ok: false, error: "Unknown message" });
    await expect(upsertAddressBookEntry({ name: "A", address: "a" })).rejects.toThrow("Contacts are unavailable");
    send.mockResolvedValueOnce(undefined);
    await expect(clearAddressBook()).rejects.toThrow("Contacts are unavailable");
  });
});
