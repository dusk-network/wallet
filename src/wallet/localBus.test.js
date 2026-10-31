import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import vaults from "../shared/fixtures/vault-v1.json";

const engine = vi.hoisted(() => ({ sendTransaction: vi.fn(), unlocked: true, wallet: "wallet A", key: "", held: [], addFails: false, switchFails: false, checkpoints: [] }));

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
  // A shielded checkpoint, on the wallet open as it's set.
  setShieldedCheckpointNow: vi.fn(async () => {
    engine.checkpoints.push(engine.wallet);
    return { bookmark: "1", block: "1" };
  }),
  isUnlocked: () => engine.unlocked,
  lock: () => {
    engine.unlocked = false;
  },
  unlockWithMnemonic: async (mnemonic) => {
    engine.wallet = mnemonic;
    engine.unlocked = true;
  },
  // Every wallet the vault opened, one unlocked, as walletEngine.js keeps them.
  unlockWallets: async ({ wallets, walletKey }) => {
    const chosen = wallets.find((w) => w.id === walletKey) ?? wallets[0];
    engine.held = wallets.map(({ id, n, mnemonic }) => ({ id, n, mnemonic }));
    engine.key = chosen.id;
    engine.wallet = chosen.mnemonic;
    engine.unlocked = true;
  },
  switchWallet: async ({ walletKey }) => {
    if (engine.switchFails) throw new Error("The engine stopped");
    const chosen = engine.held.find((w) => w.id === walletKey);
    if (!chosen) throw new Error("That wallet isn't here.");
    engine.key = chosen.id;
    engine.wallet = chosen.mnemonic;
  },
  addWallet: ({ walletKey, n, mnemonic }) => {
    if (engine.addFails) throw new Error("Engine restarted");
    engine.held.push({ id: walletKey, n, mnemonic });
  },
  removeWallet: ({ walletKey }) => {
    engine.held = engine.held.filter((w) => w.id !== walletKey);
  },
  getWallets: () => (engine.unlocked ? engine.held.map(({ id, n }) => ({ key: id, n })) : []),
  getWalletKey: () => (engine.unlocked ? engine.key : ""),
  // A held wallet's profiles' accounts, from its phrase.
  walletAccountsOf: async ({ walletKey }) => {
    const held = engine.held.find((w) => w.id === walletKey);
    if (!held) throw new Error("That wallet isn't here.");
    return [`account of ${held.mnemonic}`, `account 1 of ${held.mnemonic}`];
  },
  getAddresses: () => ["addr0"],
  // The wallet a phrase makes; here every phrase is "wallet …", or a BIP39 test phrase.
  walletIdOf: async (mnemonic) => {
    if (!/^(wallet |abandon )/.test(String(mnemonic))) throw new Error("That isn't a valid recovery phrase.");
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
  // The wallet's accounts: its own for each phrase.
  getAccounts: () => [`account of ${engine.wallet}`, `account 1 of ${engine.wallet}`],
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
  engine.key = "";
  engine.held = [];
  engine.addFails = false;
  engine.switchFails = false;
  engine.checkpoints = [];
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

  it("keep the network they were sent on, by the chain ID the node's settings keep", async () => {
    localStorage.setItem("dusk_settings_v1", JSON.stringify({ nodeUrl: "https://my-node.example", chainId: 2 }));
    const { localSend } = await import("./localBus.js");
    const { getTxMeta } = await import("../shared/txStore.js");
    engine.sendTransaction.mockResolvedValueOnce({ hash: "ee".repeat(32), nonce: 1n });
    await localSend({ type: "DUSK_UI_SEND_TX", params: { kind: "transfer", privacy: "public", to: ACCOUNT, amount: "1" } });
    await expect(getTxMeta("ee".repeat(32))).resolves.toMatchObject({ nodeUrl: "https://my-node.example", chainId: 2 });
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

  it("go from the wallet they were reviewed on, or not at all", async () => {
    const { localSend } = await import("./localBus.js");
    const params = { kind: "transfer", privacy: "public", to: ACCOUNT, amount: "1" };
    await expect(localSend({ type: "DUSK_UI_SEND_TX", walletId: "account of wallet B", params })).resolves.toMatchObject({
      error: { message: "The wallet changed while you reviewed it." },
    });
    expect(engine.sendTransaction).not.toHaveBeenCalled();
    engine.sendTransaction.mockResolvedValueOnce({ hash: "ab".repeat(32), nonce: 1n });
    await expect(localSend({ type: "DUSK_UI_SEND_TX", walletId: "account of wallet A", params })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("keep a wallet switch waiting until they're out", async () => {
    const { localSend } = await import("./localBus.js");
    const { WALLET_LIFECYCLE_LOCK, withStorageLock } = await import("../shared/storageLock.js");
    const sent = Promise.withResolvers();
    engine.sendTransaction.mockReturnValueOnce(sent.promise);
    const params = { kind: "transfer", privacy: "public", to: ACCOUNT, amount: "1" };
    const response = localSend({ type: "DUSK_UI_SEND_TX", walletId: "account of wallet A", params });
    await vi.waitFor(() => expect(engine.sendTransaction).toHaveBeenCalled());
    let switched = false;
    const switching = withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
      switched = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(switched).toBe(false);
    sent.resolve({ hash: "ac".repeat(32), nonce: 1n });
    await expect(response).resolves.toMatchObject({ ok: true });
    await switching;
    expect(switched).toBe(true);
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
        if (key === "dusk_vault_v2") {
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

describe("a custom node's chain ID, on the desktop app", () => {
  const NODE = "https://my-node.example";
  const infoReads = (fetch) => fetch.mock.calls.filter(([url]) => new URL(String(url)).pathname === "/on/node/info").length;

  beforeEach(async () => {
    vi.resetModules();
    engine.unlocked = false;
    const { configure } = await import("../shared/walletEngine.js");
    configure.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is read when the node is chosen, kept with it, and handed to the engine", async () => {
    const fetch = vi.fn(async () => new Response('{"chain_id":2}'));
    vi.stubGlobal("fetch", fetch);
    const { localSend } = await import("./localBus.js");
    const { configure } = await import("../shared/walletEngine.js");
    await expect(localSend({ type: "DUSK_UI_SET_NODE_URL", nodeUrl: NODE })).resolves.toMatchObject({ ok: true, nodeUrl: NODE });
    expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({ nodeUrl: NODE, chainId: 2 }));
    await expect(localSend({ type: "DUSK_UI_OVERVIEW" })).resolves.toMatchObject({ nodeUrl: NODE, chainId: 2 });
    expect(infoReads(fetch)).toBe(1);
  });

  it("is asked again as the wallet draws when the node couldn't say when chosen, at most every 30 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    localStorage.setItem("dusk_settings_v1", JSON.stringify({ nodeUrl: NODE, chainId: null }));
    const fetch = vi.fn(async () => new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const { localSend } = await import("./localBus.js");
    const stored = () => JSON.parse(localStorage.getItem("dusk_settings_v1")).chainId;
    // The page the wallet runs in, which draws again when told (popup/app.js).
    const told = vi.fn();
    vi.stubGlobal("window", { dispatchEvent: told });

    await expect(localSend({ type: "DUSK_UI_OVERVIEW" })).resolves.toMatchObject({ chainId: null });
    // Asked, and once more after a short wait.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(infoReads(fetch)).toBe(2);
    expect(stored()).toBeNull();
    expect(told).not.toHaveBeenCalled();

    // The node can say now: drawing again soon asks nothing yet...
    fetch.mockImplementation(async () => new Response('{"chain_id":2}'));
    await localSend({ type: "DUSK_UI_OVERVIEW" });
    expect(infoReads(fetch)).toBe(2);
    // ...and 30 seconds on asks again, and keeps what it says with the node.
    await vi.advanceTimersByTimeAsync(30_000);
    await localSend({ type: "DUSK_UI_OVERVIEW" });
    await vi.waitFor(() => expect(stored()).toBe(2));
    // The page is told, as the extension's background tells its pages.
    await vi.waitFor(() => expect(told).toHaveBeenCalledTimes(1));
    expect([told.mock.calls[0][0].type, told.mock.calls[0][0].detail]).toEqual(["dusk-wallet-message", { type: "DUSK_UI_NETWORK_CHANGED" }]);
    await expect(localSend({ type: "DUSK_UI_OVERVIEW" })).resolves.toMatchObject({ chainId: 2 });
    expect(infoReads(fetch)).toBe(3);
  });
});

// The real vault, at 900,000 PBKDF2 iterations a phrase: slow under load.
describe("more than one recovery phrase", { timeout: 30_000 }, () => {
  const { twelve } = vaults;
  const send = async (message) => (await import("./localBus.js")).localSend(message);
  const ok = async (message) => {
    const res = await send(message);
    if (res?.error) throw new Error(res.error.message);
    return res;
  };
  const overview = () => ok({ type: "DUSK_UI_OVERVIEW" });
  const vault = () => JSON.parse(localStorage.getItem("dusk_vault_v2"));
  const accountOf = (phrase) => `account of ${phrase}`;

  // A vault main made, as the update finds it, then unlocked with a second
  // wallet imported beside it.
  async function twoWallets() {
    engine.unlocked = false;
    localStorage.setItem("dusk_vault_v1", JSON.stringify(twelve.vault));
    await ok({ type: "DUSK_UI_UNLOCK", password: twelve.password });
    await ok({ type: "DUSK_UI_ADD_WALLET", mnemonic: "wallet B", password: twelve.password });
    return (await overview()).wallets;
  }

  it("moves main's vault on unlock, imports another phrase, and switches both ways without the password", async () => {
    engine.unlocked = false;
    localStorage.setItem("dusk_vault_v1", JSON.stringify(twelve.vault));
    await ok({ type: "DUSK_UI_UNLOCK", password: twelve.password });
    expect(localStorage.getItem("dusk_vault_v1")).toBeNull();
    expect((await overview()).wallets).toMatchObject([{ n: 1, name: "", active: true, walletId: accountOf(twelve.mnemonic) }]);

    await ok({ type: "DUSK_UI_ADD_WALLET", mnemonic: "wallet B", password: twelve.password });
    const wallets = (await overview()).wallets;
    expect(wallets.map(({ n, active, walletId }) => [n, active, walletId])).toEqual([
      [1, false, accountOf(twelve.mnemonic)],
      [2, true, accountOf("wallet B")],
    ]);
    // The other wallet's profiles show as they were last shown.
    expect(wallets[0].accounts).toEqual([accountOf(twelve.mnemonic), `account 1 of ${twelve.mnemonic}`]);
    expect(engine.wallet).toBe("wallet B");

    // No password either way.
    await ok({ type: "DUSK_UI_SWITCH_WALLET", walletKey: wallets[0].key, index: 1 });
    expect(engine.wallet).toBe(twelve.mnemonic);
    expect(JSON.parse(localStorage.getItem("dusk_settings_v1")).selectedAccountIndex).toBe(1);
    await ok({ type: "DUSK_UI_SWITCH_WALLET", walletKey: wallets[1].key, index: 0 });
    expect(engine.wallet).toBe("wallet B");

    // A lock locks every wallet; the next unlock opens the one used last, with the other held.
    await ok({ type: "DUSK_UI_LOCK" });
    await expect(send({ type: "DUSK_UI_SWITCH_WALLET", walletKey: wallets[0].key })).resolves.toMatchObject({ error: { message: "Wallet locked" } });
    await ok({ type: "DUSK_UI_UNLOCK", password: twelve.password });
    expect(engine.wallet).toBe("wallet B");
    expect(engine.held.map((w) => w.mnemonic)).toEqual([twelve.mnemonic, "wallet B"]);
  });

  it("refuses a phrase that's here already with one sentence, a wrong password, and one that isn't a phrase", async () => {
    await twoWallets();
    const before = localStorage.getItem("dusk_vault_v2");
    await expect(send({ type: "DUSK_UI_ADD_WALLET", mnemonic: twelve.mnemonic, password: twelve.password })).resolves.toMatchObject({
      error: { message: "This recovery phrase is already in your wallet." },
    });
    await expect(send({ type: "DUSK_UI_ADD_WALLET", mnemonic: "wallet C", password: "not the password" })).resolves.toMatchObject({
      error: { message: "Incorrect password" },
    });
    localStorage.removeItem("dusk_unlock_guard_v1");
    await expect(send({ type: "DUSK_UI_ADD_WALLET", mnemonic: "not a phrase", password: twelve.password })).resolves.toMatchObject({
      error: { message: "That isn't a valid recovery phrase." },
    });
    expect(localStorage.getItem("dusk_vault_v2")).toBe(before);
    expect(engine.held).toHaveLength(2);
  });

  it("removes a wallet with the password, its data with it, and touches nothing of the other", async () => {
    const [first, second] = await twoWallets();
    const txs = await import("../shared/txStore.js");
    const names = await import("../shared/accountNames.js");
    for (const w of [first, second]) {
      await txs.putTxMeta(`${w.n}`.repeat(64), { walletId: w.walletId, nodeUrl: "n", status: "executed", submittedAt: w.n });
      await names.setAccountName(w.walletId, 0, `label ${w.n}`);
    }
    const kept = JSON.stringify(vault().wallets.find((w) => w.id === first.key));

    await expect(send({ type: "DUSK_UI_REMOVE_WALLET", walletKey: second.key, password: "wrong" })).resolves.toMatchObject({
      error: { message: "Incorrect password" },
    });
    expect(vault().wallets).toHaveLength(2);
    localStorage.removeItem("dusk_unlock_guard_v1");

    // The wallet open now: the other one opens in its place.
    await ok({ type: "DUSK_UI_REMOVE_WALLET", walletKey: second.key, password: twelve.password });
    expect(engine.wallet).toBe(twelve.mnemonic);
    expect(engine.held.map((w) => w.id)).toEqual([first.key]);
    expect(vault().wallets.map((w) => JSON.stringify(w))).toEqual([kept]);
    await expect(txs.listTxs({ walletId: second.walletId })).resolves.toEqual([]);
    await expect(txs.listTxs({ walletId: first.walletId })).resolves.toHaveLength(1);
    await expect(names.getAccountNames(second.walletId)).resolves.toEqual({});
    await expect(names.getAccountNames(first.walletId)).resolves.toEqual({ 0: "label 1" });
    expect((await overview()).wallets.map((w) => w.key)).toEqual([first.key]);

    // The only wallet stays: Reset removes it.
    await expect(send({ type: "DUSK_UI_REMOVE_WALLET", walletKey: first.key, password: twelve.password })).resolves.toMatchObject({
      error: { message: "This is the only wallet here. Reset removes it." },
    });
  });

  it("says a wallet the vault took opens on the next unlock, when the engine couldn't take it", async () => {
    engine.unlocked = false;
    localStorage.setItem("dusk_vault_v1", JSON.stringify(twelve.vault));
    await ok({ type: "DUSK_UI_UNLOCK", password: twelve.password });
    engine.addFails = true;
    await expect(send({ type: "DUSK_UI_ADD_WALLET", mnemonic: "wallet B", password: twelve.password })).resolves.toMatchObject({
      error: { message: "The wallet was added. Lock and unlock to open it." },
    });
    engine.addFails = false;
    await ok({ type: "DUSK_UI_LOCK" });
    await ok({ type: "DUSK_UI_UNLOCK", password: twelve.password });
    expect(engine.held.map((w) => w.mnemonic)).toEqual([twelve.mnemonic, "wallet B"]);
  });

  it("forgets a removed wallet's data by its phrase, whatever the switcher last showed of it", async () => {
    const [first, second] = await twoWallets();
    await ok({ type: "DUSK_UI_SWITCH_WALLET", walletKey: first.key, index: 0 });
    const txs = await import("../shared/txStore.js");
    const activity = await import("../shared/activityStore.js");
    await txs.putTxMeta("b".repeat(64), { walletId: second.walletId, nodeUrl: "n", status: "executed", submittedAt: 1 });
    const owner = activity.activityOwnerKey("testnet", "account 1 of wallet B");
    await activity.commitActivityStep(owner, [{ hash: "c".repeat(64), blockHeight: 1 }], () => ({ synced: 1 }));
    // Nothing kept of what the switcher showed of it.
    const directory = JSON.parse(localStorage.getItem("dusk_wallets_v1"));
    delete directory.wallets[second.key];
    localStorage.setItem("dusk_wallets_v1", JSON.stringify(directory));

    await ok({ type: "DUSK_UI_REMOVE_WALLET", walletKey: second.key, password: twelve.password });
    await expect(txs.listTxs({ walletId: second.walletId })).resolves.toEqual([]);
    await expect(activity.listActivityEntries(owner)).resolves.toEqual([]);
  });

  it("gives the sends kept before wallets were kept apart to the wallet moved from main's vault, and to no other", async () => {
    const txs = await import("../shared/txStore.js");
    await txs.putTxMeta("d".repeat(64), { nodeUrl: "n", status: "executed", submittedAt: 1 });
    const [first, second] = await twoWallets();
    await expect(txs.listTxs({ walletId: first.walletId })).resolves.toEqual([expect.objectContaining({ hash: "d".repeat(64) })]);

    // One kept without a wallet since, and the moved wallet gone: the other doesn't take it.
    await txs.putTxMeta("e".repeat(64), { nodeUrl: "n", status: "executed", submittedAt: 2 });
    await ok({ type: "DUSK_UI_REMOVE_WALLET", walletKey: first.key, password: twelve.password });
    await ok({ type: "DUSK_UI_LOCK" });
    await ok({ type: "DUSK_UI_UNLOCK", password: twelve.password });
    expect(engine.held.map((w) => w.id)).toEqual([second.key]);
    await expect(txs.listTxs({ walletId: second.walletId })).resolves.toEqual([]);
  });

  it("sets a new phrase's shielded checkpoint as it adds that wallet, and never on another opened meanwhile", async () => {
    await twoWallets();
    // "wallet B" was imported: no checkpoint for it.
    expect(engine.checkpoints).toEqual([]);
    await ok({ type: "DUSK_UI_ADD_WALLET", mnemonic: "wallet C", password: twelve.password, fresh: true });
    expect(engine.checkpoints).toEqual(["wallet C"]);

    // Another window opens the first wallet; a checkpoint asked on its own after the add sets nothing.
    await ok({ type: "DUSK_UI_SWITCH_WALLET", walletKey: (await overview()).wallets[0].key, index: 0 });
    await send({ type: "DUSK_UI_SET_SHIELDED_CHECKPOINT_NOW" });
    expect(engine.checkpoints).toEqual(["wallet C"]);
  });

  it("deletes all contacts of the wallet its page showed, and leaves another wallet's", async () => {
    const [first, second] = await twoWallets();
    const contacts = (walletId, op, more = {}) => ok({ type: "DUSK_UI_CONTACTS", op, walletId, ...more });
    await contacts(second.walletId, "upsert", { entry: { name: "Bea", address: ACCOUNT } });
    await ok({ type: "DUSK_UI_SWITCH_WALLET", walletKey: first.key, index: 0 });
    await contacts(first.walletId, "upsert", { entry: { name: "Ann", address: ACCOUNT } });

    await contacts(first.walletId, "clear");
    expect((await contacts(first.walletId, "list")).result).toEqual([]);
    await ok({ type: "DUSK_UI_SWITCH_WALLET", walletKey: second.key, index: 0 });
    expect((await contacts(second.walletId, "list")).result).toEqual([expect.objectContaining({ name: "Bea" })]);
  });

  it("shows the unlock form once a failed switch has locked the wallet", async () => {
    const { installFakeDom, settle } = await import("../ui/testing/fakeDom.js");
    await twoWallets();
    const dom = installFakeDom({ pathname: "/popup.html" });
    dom.document.body.innerHTML = "";
    const header = dom.document.createElement("div");
    header.id = "header-actions";
    const page = dom.document.createElement("div");
    page.id = "app";
    dom.document.body.append(header, page);
    const flush = async () => {
      for (let i = 0; i < 20; i++) {
        await settle();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    const { render } = await import("../ui/popup/app.js");
    await render();
    await flush();
    expect(page.textContent).not.toContain("Unlock your wallet");

    // The first wallet's profile, picked from the menu; the engine fails the switch.
    engine.switchFails = true;
    header.querySelector(".account-chip").click();
    await flush();
    const rows = dom.document.body.querySelectorAll(".acct-menu-wallet")[0].querySelectorAll(".net-menu-item");
    expect(rows.length).toBeGreaterThan(0);
    rows[0].click();
    await flush();
    expect(engine.unlocked).toBe(false);
    expect(page.textContent).toContain("Unlock your wallet");
  });

  it("renames a wallet, and gives it its number back", async () => {
    const [, second] = await twoWallets();
    await ok({ type: "DUSK_UI_RENAME_WALLET", walletKey: second.key, name: "  Savings " });
    expect((await overview()).wallets[1]).toMatchObject({ n: 2, name: "Savings" });
    await ok({ type: "DUSK_UI_RENAME_WALLET", walletKey: second.key, name: "" });
    expect((await overview()).wallets[1].name).toBe("");
  });

  it("changes the password of every phrase", async () => {
    await twoWallets();
    await expect(send({ type: "DUSK_UI_CHANGE_PASSWORD", password: twelve.password, newPassword: "short" })).resolves.toMatchObject({
      error: { message: "Use at least 8 characters." },
    });
    await ok({ type: "DUSK_UI_CHANGE_PASSWORD", password: twelve.password, newPassword: "a new password" });
    await ok({ type: "DUSK_UI_LOCK" });
    await expect(send({ type: "DUSK_UI_UNLOCK", password: twelve.password })).resolves.toMatchObject({ error: { message: "Incorrect password" } });
    localStorage.removeItem("dusk_unlock_guard_v1");
    await ok({ type: "DUSK_UI_UNLOCK", password: "a new password" });
    expect(engine.held.map((w) => w.mnemonic)).toEqual([twelve.mnemonic, "wallet B"]);
  });

  it("removes every wallet on Reset, and on a restore after a forgotten password", async () => {
    await twoWallets();
    await ok({ type: "DUSK_UI_LOCK" });
    await ok({ type: "DUSK_UI_RESTORE_WALLET", mnemonic: "wallet C", password: "password456" });
    expect(vault().wallets).toHaveLength(1);
    expect((await overview()).wallets).toMatchObject([{ n: 1, walletId: accountOf("wallet C") }]);

    await ok({ type: "DUSK_UI_RESET_WALLET" });
    for (const key of ["dusk_vault_v1", "dusk_vault_v2", "dusk_wallets_v1", "dusk_permissions_v2"]) expect(localStorage.getItem(key)).toBeNull();
    await expect(send({ type: "DUSK_UI_STATUS" })).resolves.toMatchObject({ hasVault: false });
  });
});
