import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import vaults from "../shared/fixtures/vault-v1.json";

const engine = vi.hoisted(() => ({ sendTransaction: vi.fn(), resendSend: vi.fn(), handedOverTx: vi.fn(() => null), rebroadcastTx: vi.fn(), unlocked: true, wallet: "wallet A", key: "", held: [], addFails: false, switchFails: false, checkpoints: [], handedOver: new Set(), balance: null, balanceRead: null }));

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
  // The node's balance where a test says it (`engine.balance`), else none to read, as with no signal.
  getPublicBalance: async () => {
    // A read that takes a while, where a test holds it (`engine.balanceRead`).
    await engine.balanceRead?.();
    if (!engine.balance) throw new TypeError("Failed to fetch");
    return { nonce: 4n, value: engine.balance };
  },
  getShieldedStatus: () => ({ state: "done", progress: 1, notes: 0 }),
  getShieldedBalance: async () => ({ value: 0n, spendable: 0n }),
  sendTransaction: engine.sendTransaction,
  // A payment from Send called off unless it was handed over, as walletEngine.js settles it.
  cancelSend: ({ sendId }) => ({ cancelled: !engine.handedOver.has(sendId) }),
  // The transaction a payment's try handed over without a clear answer, sent again as it was made; or forgotten.
  resendSend: engine.resendSend,
  forgetHandedOver: vi.fn(() => ({ forgotten: true })),
  // Any other public send handed over without a clear answer, as it was signed; and sent again as it is.
  handedOverTx: engine.handedOverTx,
  rebroadcastTx: engine.rebroadcastTx,
  sendUnderWay: vi.fn(() => ({ underWay: false })),
  // The last nonce the wallet's own sends took: none here.
  lastOwnNonce: vi.fn(() => ({ nonce: null })),
  // What's told of a payment that waited before it's handed over: the app's bus keeps it.
  setHandOverHook: (hook) => {
    engine.handOverHook = hook;
  },
  // Execution is never seen here, unless a test says when (`engine.executed`).
  waitTxExecuted: () => engine.executed?.promise ?? new Promise(() => {}),
  waitTxRemoved: () => new Promise(() => {}),
  startShieldedSync: vi.fn(async () => {}),
}));

// The phone's notices, as the app's Kotlin would answer: allowed or not, and what was asked.
const phoneNotices = vi.hoisted(() => ({ allowed: () => false, asked: [], watched: [], settled: [], forgotten: [], waiting: [] }));
vi.mock("../platform/notices.js", () => ({
  appNoticesAllowed: async () => phoneNotices.allowed(),
  askAppNotices: async () => {
    phoneNotices.asked.push("ask");
    return phoneNotices.allowed() ? "on" : "off";
  },
  showAppNotice: async ({ title, body, publicBody, hash, token }) => {
    phoneNotices.asked.push(`notify: ${title}`);
    phoneNotices.shown = { title, body, publicBody, hash, token };
    return phoneNotices.allowed();
  },
  // What Android looks for once the app leaves the screen (android/ArrivalJob.kt).
  watchAppArrival: async (send) => {
    phoneNotices.watched.push(send);
    return phoneNotices.allowed();
  },
  settleAppArrival: async (hash) => {
    phoneNotices.settled.push(hash);
  },
  // A wallet's sends no longer looked for: "" for every wallet's.
  forgetAppArrivals: async (wallet = "") => {
    phoneNotices.forgotten.push(wallet);
  },
  // A payment waiting for the network while the app's away (android/ArrivalJob.kt's Waiting): null for none.
  waitAppSend: async (setup) => {
    phoneNotices.waiting.push(setup);
  },
}));

// The node, prover and archiver checks the overview starts: none, but in the
// tests of them, so no test reaches a real network or counts their reads.
const statusChecks = vi.hoisted(() => ({ real: false, nodeAnswers: true }));
vi.mock("../shared/networkStatus.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    checkAllEndpoints: (endpoints) => (statusChecks.real ? real.checkAllEndpoints(endpoints) : real.getNetworkStatus()),
    // The node asked whether it answers: as a test says, but in the tests of the checks.
    checkNode: (nodeUrl, opts) => (statusChecks.real ? real.checkNode(nodeUrl, opts) : Promise.resolve({ nodeStatus: statusChecks.nodeAnswers ? "online" : "offline", nodeUrl })),
  };
});

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
  engine.resendSend.mockReset();
  engine.unlocked = true;
  engine.wallet = "wallet A";
  engine.key = "";
  engine.held = [];
  engine.addFails = false;
  engine.switchFails = false;
  engine.checkpoints = [];
  engine.executed = null;
  engine.handedOver = new Set();
  engine.balance = null;
  engine.balanceRead = null;
  statusChecks.nodeAnswers = true;
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

  // Chen's, R01: handed over as the Wi-Fi came back flaky, the node never got it, and it said "Not confirmed yet"
  // for good, with nothing to tap.
  it("keep a public one handed over without a clear answer as it was signed, which Send it now sends again as it is and Don't send leaves followed", async () => {
    const { localSend } = await import("./localBus.js");
    const { getTxMeta, patchTxMeta } = await import("../shared/txStore.js");
    const hash = "c1".repeat(32);
    const lost = Object.assign(new Error("Failed to fetch"), { data: { sent: "unknown", hash, nonce: "5", account: ACCOUNT } });
    engine.sendTransaction.mockRejectedValueOnce(lost);
    engine.handedOverTx.mockImplementation(({ hash: asked }) => (asked === hash ? { hex: "ab12", nonce: "5", account: ACCOUNT, profileIndex: 0 } : null));
    await expect(localSend({ type: "DUSK_UI_SEND_TX", walletId: "account of wallet A", params: { kind: "stake", amount: "1000000000000", gas: { limit: "40000000", price: "1" } } })).resolves.toMatchObject({ error: { data: { sent: "unknown", hash } } });
    await expect(getTxMeta(hash)).resolves.toMatchObject({ status: "unknown", recoveryReason: "handover_unclear", account: ACCOUNT, nonce: "5", signedTx: "ab12" });

    // The node never had it: Send it now sends it as it was signed.
    await patchTxMeta(hash, { status: "unsent", recoveryReason: "not_reached" });
    engine.rebroadcastTx.mockResolvedValueOnce({ hash, nonce: "5" });
    await expect(localSend({ type: "DUSK_UI_RESEND_TX", hash })).resolves.toEqual({ ok: true, result: { hash } });
    expect(engine.rebroadcastTx).toHaveBeenLastCalledWith(expect.objectContaining({ hex: "ab12", hash, nonce: "5", account: ACCOUNT, profileIndex: 0 }));
    const went = await getTxMeta(hash);
    expect([went.status, went.signedTx]).toEqual(["submitted", undefined]);

    // Another, never had either: Don't send leaves it never to be sent again from here, followed till its nonce is
    // used, as its hand-over had no clear answer (Astra's: forgotten, saying nothing left, though it might still go).
    const other = "c2".repeat(32);
    engine.sendTransaction.mockRejectedValueOnce(Object.assign(new Error("Failed to fetch"), { data: { sent: "unknown", hash: other } }));
    engine.handedOverTx.mockImplementation(() => ({ hex: "cd34", nonce: "6", account: ACCOUNT, profileIndex: 0 }));
    await localSend({ type: "DUSK_UI_SEND_TX", walletId: "account of wallet A", params: { kind: "stake", amount: "1000000000000", gas: { limit: "40000000", price: "1" } } }).catch(() => {});
    await patchTxMeta(other, { status: "unsent", recoveryReason: "not_reached" });
    await expect(localSend({ type: "DUSK_UI_DROP_TX", hash: other })).resolves.toEqual({ ok: true, result: { dropped: true, followed: true } });
    const chosen = await getTxMeta(other);
    expect(chosen).toMatchObject({ status: "unsent", dontSendAt: expect.any(Number) });
    expect(chosen.signedTx).toBeUndefined();
    await expect(localSend({ type: "DUSK_UI_RESEND_TX", hash: other })).resolves.toMatchObject({ error: { code: -32602 } });
    engine.handedOverTx.mockReset();
  });

  // Astra's: Send it now handed it over and its answer was lost; it stayed Not sent yet, for Don't send to forget.
  it("look up a Send it now whose answer was lost, with nothing to drop meanwhile", async () => {
    const { localSend } = await import("./localBus.js");
    const { getTxMeta, putTxMeta } = await import("../shared/txStore.js");
    const hash = "c3".repeat(32);
    await putTxMeta(hash, { status: "unsent", kind: "stake", privacy: "public", walletId: "account of wallet A", account: ACCOUNT, nonce: "5", signedTx: "ab12", profileIndex: 0, nodeUrl: "https://testnet.nodes.dusk.network" });
    engine.rebroadcastTx.mockRejectedValueOnce(Object.assign(new Error("Failed to fetch"), { data: { sent: "unknown", hash } }));
    await expect(localSend({ type: "DUSK_UI_RESEND_TX", hash })).resolves.toMatchObject({ error: { data: { sent: "unknown" } } });
    await expect(getTxMeta(hash)).resolves.toMatchObject({ status: "unknown", signedTx: "ab12" });
    await expect(localSend({ type: "DUSK_UI_DROP_TX", hash })).resolves.toEqual({ ok: true, result: { dropped: false } });
    await expect(getTxMeta(hash)).resolves.toMatchObject({ status: "unknown", signedTx: "ab12" });
  });

  // Astra's: Send it now asked whether the wallet was open once, before anything waited; a lock meanwhile still let
  // the transaction go out after it.
  it("send one again with Send it now only once a lock under way is over, and not once it locked", async () => {
    const { localSend } = await import("./localBus.js");
    const { putTxMeta } = await import("../shared/txStore.js");
    const { WALLET_LIFECYCLE_LOCK, withStorageLock } = await import("../shared/storageLock.js");
    const hash = "c4".repeat(32);
    await putTxMeta(hash, { status: "unsent", kind: "stake", privacy: "public", walletId: "account of wallet A", account: ACCOUNT, nonce: "5", signedTx: "ab12", profileIndex: 0, nodeUrl: "https://testnet.nodes.dusk.network" });
    engine.rebroadcastTx.mockClear();
    const locked = Promise.withResolvers();
    const locking = withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
      await locked.promise;
      engine.unlocked = false;
    });
    try {
      const answer = localSend({ type: "DUSK_UI_RESEND_TX", hash });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(engine.rebroadcastTx).not.toHaveBeenCalled();
      locked.resolve();
      await locking;
      await expect(answer).resolves.toMatchObject({ error: { message: "Wallet locked" } });
      expect(engine.rebroadcastTx).not.toHaveBeenCalled();
    } finally {
      locked.resolve();
      engine.unlocked = true;
    }
  });

  it("are looked up again by their ID when the page asks, as the app comes back, and the page hears how they went", async () => {
    localStorage.setItem("dusk_settings_v1", JSON.stringify({ nodeUrl: "https://testnet.nodes.dusk.network", chainId: 2 }));
    const { localSend } = await import("./localBus.js");
    const { getTxMeta } = await import("../shared/txStore.js");
    engine.sendTransaction.mockResolvedValueOnce({ hash: "f1".repeat(32), nonce: 1n });
    await localSend({ type: "DUSK_UI_SEND_TX", params: { kind: "transfer", privacy: "public", to: ACCOUNT, amount: "1" } });
    // The watcher heard nothing while the app was away; the node has it in a block.
    const block = { tx: { id: "f1".repeat(32), err: null, gasSpent: "2135802", blockHash: "aa", blockHeight: 4802949, blockTimestamp: 1794150000, tx: { gasPrice: "1" } } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(block), { status: 200 })));
    const told = vi.fn();
    vi.stubGlobal("window", { dispatchEvent: told });
    await expect(localSend({ type: "DUSK_UI_RECHECK_TX", hash: "f1".repeat(32) })).resolves.toMatchObject({ ok: true, result: { status: "executed" } });
    await expect(getTxMeta("f1".repeat(32))).resolves.toMatchObject({ status: "executed", feePaid: "2135802", blockHeight: "4802949" });
    // Lena's: Completed kept "Network fee Up to 0,0025 DUSK" after the block: the page hears the fee charged with it.
    expect(told.mock.calls.map(([event]) => event.detail)).toEqual([{ type: "DUSK_UI_TX_STATUS", hash: "f1".repeat(32), status: "executed", ok: true, error: "", feePaid: "2135802", blockHeight: "4802949" }]);
  });

  // Chen's, in the app: a tap on "Your payment arrived" showed "Not confirmed", and the
  // wallet that "stopped waiting for a result", before Completed: the notice knew it.
  it("take a notice's news of one in its block, where nothing final is on its record, and the page hears it", async () => {
    localStorage.setItem("dusk_settings_v1", JSON.stringify({ nodeUrl: "https://testnet.nodes.dusk.network", chainId: 2 }));
    const { localSend } = await import("./localBus.js");
    const { getTxMeta, patchTxMeta } = await import("../shared/txStore.js");
    engine.sendTransaction.mockResolvedValueOnce({ hash: "f2".repeat(32), nonce: 1n });
    await localSend({ type: "DUSK_UI_SEND_TX", params: { kind: "transfer", privacy: "public", to: ACCOUNT, amount: "1" } });
    // The watcher gave up while the app was away; its notice carries the token made for it.
    const { noticeTokenFor } = await import("../shared/noticeTokens.js");
    const token = await noticeTokenFor("f2".repeat(32), ACCOUNT);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    await patchTxMeta("f2".repeat(32), { status: "unknown" });
    const told = vi.fn();
    vi.stubGlobal("window", { dispatchEvent: told });

    // Astra's: any app can open the wallet as a tap would, with a send's ID it learned and an outcome of its own.
    // Without the notice's token, or with another, nothing goes on the record and nothing opens.
    for (const forged of [{}, { token: "" }, { token: token === "7b".repeat(16) ? "7c".repeat(16) : "7b".repeat(16) }, { token: token.toUpperCase() }]) {
      await expect(localSend({ type: "DUSK_UI_TX_NOTICED", hash: "f2".repeat(32), status: "failed", blockHeight: "1", ...forged })).resolves.toMatchObject({ ok: true, result: null });
    }
    await expect(getTxMeta("f2".repeat(32))).resolves.toMatchObject({ status: "unknown" });
    expect((await getTxMeta("f2".repeat(32))).blockHeight).toBeUndefined();
    expect(told).not.toHaveBeenCalled();

    await expect(localSend({ type: "DUSK_UI_TX_NOTICED", hash: "f2".repeat(32), token, status: "executed", blockHeight: "4831109" })).resolves.toMatchObject({ ok: true, result: { patched: true } });
    await expect(getTxMeta("f2".repeat(32))).resolves.toMatchObject({ status: "executed", blockHeight: "4831109" });
    expect(told.mock.calls.map(([event]) => event.detail)).toEqual([{ type: "DUSK_UI_TX_STATUS", hash: "f2".repeat(32), status: "executed", ok: true, blockHeight: "4831109" }]);

    // A tap is taken once: the same again opens nothing.
    await expect(localSend({ type: "DUSK_UI_TX_NOTICED", hash: "f2".repeat(32), token, status: "executed" })).resolves.toMatchObject({ ok: true, result: null });

    // A record with its final word keeps it; the notice is still its own, which opens it.
    await patchTxMeta("f2".repeat(32), { status: "failed", error: "out of gas" });
    const again = await noticeTokenFor("f2".repeat(32), ACCOUNT);
    await expect(localSend({ type: "DUSK_UI_TX_NOTICED", hash: "f2".repeat(32), token: again, status: "executed" })).resolves.toMatchObject({ ok: true, result: { patched: false } });
    await expect(getTxMeta("f2".repeat(32))).resolves.toMatchObject({ status: "failed", error: "out of gas" });
  });

  // Astra's: history synced before the notice was tapped, and its sync forgot the send's record, the token with it:
  // the notice's own tap opened nothing. The token is kept apart from the record.
  it("take a notice's tap as its own after history's sync forgot its send's record", async () => {
    localStorage.setItem("dusk_settings_v1", JSON.stringify({ nodeUrl: "https://testnet.nodes.dusk.network", chainId: 2 }));
    const { localSend } = await import("./localBus.js");
    const { forgetTxs, getTxMeta } = await import("../shared/txStore.js");
    const { noticeTokenFor } = await import("../shared/noticeTokens.js");
    engine.sendTransaction.mockResolvedValueOnce({ hash: "f3".repeat(32), nonce: 1n });
    await localSend({ type: "DUSK_UI_SEND_TX", params: { kind: "transfer", privacy: "public", to: ACCOUNT, amount: "1" } });
    const token = await noticeTokenFor("f3".repeat(32), ACCOUNT);
    await forgetTxs(["f3".repeat(32)]);
    await expect(getTxMeta("f3".repeat(32))).resolves.toBeNull();
    await expect(localSend({ type: "DUSK_UI_TX_NOTICED", hash: "f3".repeat(32), token, status: "executed", blockHeight: "4831109" })).resolves.toMatchObject({ ok: true, result: { patched: false } });
    await expect(getTxMeta("f3".repeat(32))).resolves.toBeNull();
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

describe("the app's default gas price", () => {
  // Lena's, three rounds: the median of a mempool holding only Sozu's activation, at 2, was everyone's price.
  it("is the minimum while what waits fits in a block, and the capped median once it doesn't, where Review left it to the network", async () => {
    const { getCachedGasPrice } = await import("../shared/walletEngine.js");
    const { localSend } = await import("./localBus.js");
    const params = { kind: "transfer", privacy: "public", to: ACCOUNT, amount: "10000000" };
    engine.sendTransaction.mockResolvedValue({ hash: "ab".repeat(32), nonce: 1n });
    try {
      getCachedGasPrice.mockResolvedValue({ mempool: [{ gasPrice: "2", gasLimit: "6000000" }] });
      await expect(localSend({ type: "DUSK_UI_SEND_TX", walletId: "account of wallet A", params })).resolves.toMatchObject({ ok: true });
      expect(engine.sendTransaction.mock.calls.at(-1)[0].gas).toEqual({ limit: "2500000", price: "1" });
      getCachedGasPrice.mockResolvedValue({ mempool: Array.from({ length: 1000 }, () => ({ gasPrice: "900", gasLimit: "2500000" })) });
      await localSend({ type: "DUSK_UI_SEND_TX", walletId: "account of wallet A", params });
      expect(engine.sendTransaction.mock.calls.at(-1)[0].gas).toEqual({ limit: "2500000", price: "5" });
    } finally {
      getCachedGasPrice.mockResolvedValue({ median: "1" });
    }
  });
});

describe("a payment from Send that can't reach the network before it goes out", () => {
  // Amélie's and Chen's on Android: the Wi-Fi off at Confirm said "Not sent" a moment later and never waited.
  const params = { kind: "transfer", privacy: "public", to: ACCOUNT, amount: "10000000", memo: "Hors ligne un" };
  const offline = () => Object.assign(new TypeError("Failed to fetch"), { data: { sent: false } });
  // The page, and what the wallet tells it.
  const page = () => {
    const told = vi.fn();
    vi.stubGlobal("window", { dispatchEvent: told });
    return () => told.mock.calls.map(([event]) => event.detail).filter((m) => m.type === "DUSK_UI_SEND_WAITING");
  };
  const waitingNow = async (localSend) => (await localSend({ type: "DUSK_UI_OVERVIEW" })).waitingSends;

  afterEach(() => vi.useRealTimers());

  it("waits for it, which Home says with what it pays, and goes out once, once it answers", async () => {
    const { localSend } = await import("./localBus.js");
    const heard = page();
    statusChecks.nodeAnswers = false;
    engine.sendTransaction.mockRejectedValueOnce(offline()).mockResolvedValueOnce({ hash: "ad".repeat(32), nonce: 1n });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const response = localSend({ type: "DUSK_UI_SEND_TX", sendId: "send-0001", feeCapLux: "2500000", walletId: "account of wallet A", params });
    await vi.waitFor(() => expect(heard()).toEqual([{ type: "DUSK_UI_SEND_WAITING", sendId: "send-0001", waits: true }]));
    expect(await waitingNow(localSend)).toEqual([expect.objectContaining({ sendId: "send-0001", lux: "10000000", feeLux: "2500000", memo: "Hors ligne un", waiting: true, waits: true })]);

    // No answer yet: it waits on.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine.sendTransaction).toHaveBeenCalledOnce();

    statusChecks.nodeAnswers = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(response).resolves.toMatchObject({ ok: true, result: { hash: "ad".repeat(32) } });
    expect(engine.sendTransaction).toHaveBeenCalledTimes(2);
    expect(engine.sendTransaction.mock.calls[1][0]).toMatchObject({ sendId: "send-0001", memo: "Hors ligne un" });
    expect(await waitingNow(localSend)).toEqual([]);
  });

  // Lena's and Chen's: a payment that waited went from Home's list and was in Activity only about 10 s later.
  it("is kept as sent before it leaves the waiting list, so the wallet's lists always have it", async () => {
    const { localSend } = await import("./localBus.js");
    page();
    const HASH = "af".repeat(32);
    // Each time its record leaves the waiting list: whether Activity's records have it by then.
    const left = [];
    const setItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = (key, value) => {
      if (key === "dusk_waiting_sends_v1" && String(localStorage.getItem(key) ?? "").includes("send-0005") && !String(value).includes("send-0005")) {
        left.push(String(localStorage.getItem("dusk_txs_v1") ?? "").includes(HASH) ? "in Activity" : "in neither");
      }
      setItem(key, value);
    };
    statusChecks.nodeAnswers = false;
    engine.sendTransaction.mockRejectedValueOnce(offline()).mockResolvedValueOnce({ hash: HASH, nonce: 1n });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const response = localSend({ type: "DUSK_UI_SEND_TX", sendId: "send-0005", walletId: "account of wallet A", params });
    await vi.waitFor(async () => expect(await waitingNow(localSend)).toHaveLength(1));
    statusChecks.nodeAnswers = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(response).resolves.toMatchObject({ ok: true, result: { hash: HASH } });
    expect(left).toEqual(["in Activity"]);
  });

  it("is called off with Cancel while it waits: nothing sent, and never tried again", async () => {
    const { localSend } = await import("./localBus.js");
    const heard = page();
    statusChecks.nodeAnswers = false;
    engine.sendTransaction.mockRejectedValue(offline());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const response = localSend({ type: "DUSK_UI_SEND_TX", sendId: "send-0002", walletId: "account of wallet A", params });
    await vi.waitFor(() => expect(heard()).toHaveLength(1));
    await expect(localSend({ type: "DUSK_UI_CANCEL_SEND", sendId: "send-0002" })).resolves.toEqual({ ok: true, result: { cancelled: true } });
    await expect(response).resolves.toMatchObject({ error: { message: "You cancelled it, so nothing was sent.", data: { sent: false, cancelled: true } } });
    statusChecks.nodeAnswers = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine.sendTransaction).toHaveBeenCalledOnce();
    expect(await waitingNow(localSend)).toEqual([]);
  });

  // Astra's, in the app too: a payment waiting on one profile, another picked meanwhile, failed as it went; and one
  // above the amount spent its password's ticket on the try the network didn't answer.
  it("goes from the profile its Review was for, on the password given for it once, however many tries it takes", async () => {
    const { localSend } = await import("./localBus.js");
    const { proveSendPassword, setSendPasswordLimit } = await import("../shared/sendPassword.js");
    const { getSettings } = await import("../shared/settings.js");
    const heard = page();
    const wallet = await (await import("../shared/vault.js")).createVault("wallet A", "the password");
    await setSendPasswordLimit(1_000_000n);
    const { nodeUrl } = await getSettings();
    const ticket = await proveSendPassword("the password", { ...params, gas: { limit: "100000000", price: "1000" } }, { walletKey: wallet.id, walletId: "account of wallet A", nodeUrl });
    const reviewed = { ...params, _approvalContext: { walletId: "account of wallet A", profileIndex: 1, account: "account 1 of wallet A", nodeUrl } };
    statusChecks.nodeAnswers = false;
    engine.sendTransaction.mockRejectedValueOnce(offline()).mockResolvedValueOnce({ hash: "ae".repeat(32), nonce: 1n });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const response = localSend({ type: "DUSK_UI_SEND_TX", sendId: "send-0004", walletId: "account of wallet A", sendTicket: ticket, params: reviewed });
    await vi.waitFor(() => expect(heard()).toEqual([{ type: "DUSK_UI_SEND_WAITING", sendId: "send-0004", waits: true }]));
    expect(await waitingNow(localSend)).toEqual([expect.objectContaining({ sendId: "send-0004", profileIndex: 1 })]);

    statusChecks.nodeAnswers = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(response).resolves.toMatchObject({ ok: true, result: { hash: "ae".repeat(32) } });
    // Both tries from profile 1, each the payment's own.
    expect(engine.sendTransaction.mock.calls.map(([sent]) => [sent.profileIndex, sent.sendId])).toEqual([
      [1, "send-0004"],
      [1, "send-0004"],
    ]);
  });

  // Astra's: a payment waiting behind another outlived its password's ticket, checked only as its turn came.
  it("checks each payment's password as it's taken, so one waiting behind another goes out on it, however long", async () => {
    const { localSend } = await import("./localBus.js");
    const { proveSendPassword, setSendPasswordLimit } = await import("../shared/sendPassword.js");
    const { getSettings } = await import("../shared/settings.js");
    const heard = page();
    const wallet = await (await import("../shared/vault.js")).createVault("wallet A", "the password");
    await setSendPasswordLimit(1_000_000n);
    const { nodeUrl } = await getSettings();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const ticket = () => proveSendPassword("the password", params, { walletKey: wallet.id, walletId: "account of wallet A", nodeUrl });
    const [first, second] = [await ticket(), await ticket()];
    statusChecks.nodeAnswers = false;
    engine.sendTransaction
      .mockRejectedValueOnce(offline())
      .mockResolvedValueOnce({ hash: "b1".repeat(32), nonce: 1n })
      .mockResolvedValueOnce({ hash: "b2".repeat(32), nonce: 2n });
    const one = localSend({ type: "DUSK_UI_SEND_TX", sendId: "send-0006", walletId: "account of wallet A", sendTicket: first, params });
    await vi.waitFor(() => expect(heard()).toContainEqual({ type: "DUSK_UI_SEND_WAITING", sendId: "send-0006", waits: true }));
    const two = localSend({ type: "DUSK_UI_SEND_TX", sendId: "send-0007", walletId: "account of wallet A", sendTicket: second, params });
    await vi.waitFor(() => expect(heard()).toContainEqual({ type: "DUSK_UI_SEND_WAITING", sendId: "send-0007", waits: true }));
    // Three minutes with no network: past either ticket's two.
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    statusChecks.nodeAnswers = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(one).resolves.toMatchObject({ ok: true, result: { hash: "b1".repeat(32) } });
    await expect(two).resolves.toMatchObject({ ok: true, result: { hash: "b2".repeat(32) } });
  });

  it("keeps a waiting payment with its transaction's ID as the engine hands it over, and follows it by that ID", async () => {
    const { localSend } = await import("./localBus.js");
    const { getTxMeta } = await import("../shared/txStore.js");
    const { nodeUrl } = await (await import("../shared/settings.js")).getSettings();
    // Kept by an app that stopped during its try: the engine hands it over all the same.
    localStorage.setItem(
      "dusk_waiting_sends_v1",
      JSON.stringify({ "send-0005": { sendId: "send-0005", walletId: "account of wallet A", nodeUrl, profileIndex: 0, privacy: "public", to: ACCOUNT, lux: "10000000", feeLux: "0", memo: "Hors ligne un", at: 1 } })
    );
    await engine.handOverHook({ sendId: "send-0005", hash: "af".repeat(32) });
    expect(await waitingNow(localSend)).toEqual([]);
    await expect(getTxMeta("af".repeat(32))).resolves.toMatchObject({ status: "unknown", recoveryReason: "handover_unclear", to: ACCOUNT, amount: "10000000", memo: "Hors ligne un" });
  });

  it("ends as the wallet locks, and after the unlock Home says it wasn't sent, till it's dropped; it never goes out by itself", async () => {
    const { localSend } = await import("./localBus.js");
    const heard = page();
    statusChecks.nodeAnswers = false;
    engine.sendTransaction.mockRejectedValue(offline());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const response = localSend({ type: "DUSK_UI_SEND_TX", sendId: "send-0003", walletId: "account of wallet A", params });
    await vi.waitFor(() => expect(heard()).toHaveLength(1));
    await localSend({ type: "DUSK_UI_LOCK" });
    await expect(response).resolves.toMatchObject({ error: { message: "The wallet locked first. Nothing left your wallet." } });

    engine.unlocked = true;
    statusChecks.nodeAnswers = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine.sendTransaction).toHaveBeenCalledOnce();
    expect(await waitingNow(localSend)).toEqual([expect.objectContaining({ sendId: "send-0003", memo: "Hors ligne un", waiting: false, ended: "locked" })]);
    await expect(localSend({ type: "DUSK_UI_DROP_UNSENT", sendId: "send-0003" })).resolves.toEqual({ ok: true, result: { dropped: true } });
    expect(await waitingNow(localSend)).toEqual([]);
  });
});

describe("a payment from Send in the app, as Android ends it or the signal goes as it's handed over", () => {
  const params = { kind: "transfer", privacy: "public", to: ACCOUNT, amount: "10000000", memo: "Cendol" };
  const HASH = "c3".repeat(32);
  const page = () => {
    const told = vi.fn();
    vi.stubGlobal("window", { dispatchEvent: told });
    return () => told.mock.calls.map(([event]) => event.detail).filter((m) => m.type === "DUSK_UI_SEND_WAITING");
  };
  // The node, as its GraphQL and its account status answer: what it has of the payment, the account's nonce, and
  // the account's other sends waiting in its mempool (`waiting`, their nonces).
  const node = { has: "nothing", nonce: 130, waiting: [] };
  const stubNode = () =>
    vi.stubGlobal("fetch", async (input, init = {}) => {
      const url = String(input);
      const body = String(init.body ?? "");
      const json = (value) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
      if (url.endsWith("/on/graphql/query") && body.includes("tx(hash")) return json({ tx: node.has === "chain" ? { id: HASH, err: null, blockHeight: 4848915 } : null });
      if (url.endsWith("/on/graphql/query") && body.includes("mempoolTxs")) {
        const others = node.waiting.map((nonce) => ({ id: `${nonce}`.padStart(64, "e"), json: JSON.stringify({ type: "moonlight", sender: "account of wallet A", receiver: ACCOUNT, value: 10000000, nonce }) }));
        return json({ mempoolTxs: [...(node.has === "mempool" ? [{ id: HASH }] : []), ...others] });
      }
      if (/\/on\/account:[^/]+\/status$/.test(url)) return json({ balance: 481844605, nonce: node.nonce, next_nonce: node.nonce + 1 });
      throw new TypeError("Failed to fetch");
    });
  // A try that hands the payment over, its ID and nonce kept first, and loses the answer as the signal goes.
  const handsOverAndLoses = async ({ sendId }) => {
    await engine.handOverHook({ sendId, hash: HASH, nonce: "131" });
    throw Object.assign(new TypeError("Failed to fetch"), { data: { sent: "unknown", hash: HASH } });
  };
  const overview = (localSend) => localSend({ type: "DUSK_UI_OVERVIEW" });
  const kept = (over = {}) => ({ sendId: "send-0009", walletId: "account of wallet A", nodeUrl: "", profileIndex: 0, account: "account of wallet A", privacy: "public", to: ACCOUNT, lux: "10000000", feeLux: "2500000", memo: "Cendol", at: 1, ...over });

  beforeEach(() => {
    node.has = "nothing";
    node.nonce = 130;
    node.waiting = [];
    stubNode();
  });
  afterEach(() => vi.useRealTimers());

  // Sofía's: Android ended the app during the first try, and the payment vanished without a word.
  it("is kept as it's confirmed: an app ended during its first try says, once open again, that it wasn't sent", async () => {
    const { localSend } = await import("./localBus.js");
    engine.sendTransaction.mockImplementationOnce(() => new Promise(() => {}));
    localSend({ type: "DUSK_UI_SEND_TX", sendId: "send-0008", walletId: "account of wallet A", params }).catch(() => {});
    await vi.waitFor(async () => expect((await overview(localSend)).waitingSends).toEqual([expect.objectContaining({ sendId: "send-0008", memo: "Cendol", waiting: true, waits: false })]));

    // Android ends the app: the page and all it held start again.
    vi.resetModules();
    const again = await import("./localBus.js");
    expect((await overview(again.localSend)).waitingSends).toEqual([expect.objectContaining({ sendId: "send-0008", waiting: false, ended: "closed" })]);
  });

  // Chen's: confirmed as the Wi-Fi died, phone pocketed; back, "It may still have reached the network", and Activity
  // said "Sent −0.01 Not confirmed", though the node never had it.
  it("isn't in Activity as sent while unclear, and goes out once more as it was made where the node never had it", async () => {
    const { localSend } = await import("./localBus.js");
    const { nodeUrl } = await (await import("../shared/settings.js")).getSettings();
    const heard = page();
    engine.sendTransaction.mockImplementationOnce(handsOverAndLoses);
    engine.resendSend.mockResolvedValueOnce({ hash: HASH, nonce: 131n });
    statusChecks.nodeAnswers = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const reviewed = { ...params, _approvalContext: { walletId: "account of wallet A", profileIndex: 0, account: "account of wallet A", nodeUrl } };
    const response = localSend({ type: "DUSK_UI_SEND_TX", sendId: "send-0008", walletId: "account of wallet A", params: reviewed });
    await vi.waitFor(() => expect(heard()).toContainEqual({ type: "DUSK_UI_SEND_WAITING", sendId: "send-0008", waits: true, handedOver: true }));
    const ov = await overview(localSend);
    expect(ov.waitingSends).toEqual([expect.objectContaining({ sendId: "send-0008", waiting: true, unclear: true })]);
    expect(ov.txs).toEqual([]);

    // The network back: the node has nothing of it, and the account's nonce hasn't reached it.
    statusChecks.nodeAnswers = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(response).resolves.toMatchObject({ ok: true, result: { hash: HASH } });
    expect(engine.resendSend).toHaveBeenCalledWith({ sendId: "send-0008" });
    expect(engine.sendTransaction).toHaveBeenCalledOnce();
    const after = await overview(localSend);
    // Said Sent on Home till its block's in.
    expect(after.waitingSends).toEqual([expect.objectContaining({ sendId: "send-0008", waiting: false, went: expect.any(Number) })]);
    expect(after.txs).toEqual([expect.objectContaining({ hash: HASH, status: "submitted", memo: "Cendol" })]);
  });

  // Lena's: a payment that waited offline said "Sending: 0.01 DUSK…" on Home, then for 20 s there was no card, no
  // payment and the old balance, till its block came in.
  it("says a payment that went out after it waited Sent on Home till its block's in and the balance is read after", async () => {
    const { localSend } = await import("./localBus.js");
    const { nodeUrl } = await (await import("../shared/settings.js")).getSettings();
    const heard = page();
    engine.sendTransaction.mockRejectedValueOnce(Object.assign(new TypeError("Failed to fetch"), { data: { sent: false } })).mockImplementationOnce(async ({ sendId }) => {
      await engine.handOverHook({ sendId, hash: HASH, nonce: "131" });
      return { hash: HASH, nonce: 131n };
    });
    statusChecks.nodeAnswers = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const reviewed = { ...params, _approvalContext: { walletId: "account of wallet A", profileIndex: 0, account: "account of wallet A", nodeUrl } };
    const response = localSend({ type: "DUSK_UI_SEND_TX", sendId: "send-0013", walletId: "account of wallet A", params: reviewed });
    await vi.waitFor(() => expect(heard()).toContainEqual({ type: "DUSK_UI_SEND_WAITING", sendId: "send-0013", waits: true }));
    statusChecks.nodeAnswers = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(response).resolves.toMatchObject({ ok: true, result: { hash: HASH } });

    // Gone out: Sent on Home, and among the sends, never in neither.
    engine.balance = 1_000_000_000n;
    let ov = await overview(localSend);
    expect(ov.waitingSends).toEqual([expect.objectContaining({ sendId: "send-0013", hash: HASH, waiting: false, went: expect.any(Number) })]);
    expect(ov.txs).toEqual([expect.objectContaining({ hash: HASH, status: "submitted" })]);
    // In its block, the balance not read: Sent still. Read: gone from Home, Activity has it.
    const { getTxEpoch, patchTxMeta } = await import("../shared/txStore.js");
    await patchTxMeta(HASH, { status: "executed" }, { epoch: await getTxEpoch() });
    engine.balance = null;
    ov = await overview(localSend);
    expect(ov.waitingSends).toEqual([expect.objectContaining({ sendId: "send-0013", went: expect.any(Number) })]);
    engine.balance = 990_000_000n;
    ov = await overview(localSend);
    expect(ov.waitingSends).toEqual([]);
    expect(ov.txs).toEqual([expect.objectContaining({ hash: HASH, status: "executed" })]);
  });

  // Lena's again: it went out as Home read the wallet, after the sends were read, and that read forgot it: no card,
  // no payment and the old balance for 20 s.
  it("says a payment that went out as Home read the wallet Sent, though the sends read before it don't have it", async () => {
    const { localSend } = await import("./localBus.js");
    const { nodeUrl } = await (await import("../shared/settings.js")).getSettings();
    const heard = page();
    engine.sendTransaction.mockRejectedValueOnce(Object.assign(new TypeError("Failed to fetch"), { data: { sent: false } })).mockImplementationOnce(async ({ sendId }) => {
      await engine.handOverHook({ sendId, hash: HASH, nonce: "131" });
      return { hash: HASH, nonce: 131n };
    });
    statusChecks.nodeAnswers = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const reviewed = { ...params, _approvalContext: { walletId: "account of wallet A", profileIndex: 0, account: "account of wallet A", nodeUrl } };
    const response = localSend({ type: "DUSK_UI_SEND_TX", sendId: "send-0014", walletId: "account of wallet A", params: reviewed });
    await vi.waitFor(() => expect(heard()).toContainEqual({ type: "DUSK_UI_SEND_WAITING", sendId: "send-0014", waits: true }));

    // Home reads the wallet: the sends, then the balance, which takes a while; it goes out meanwhile.
    engine.balance = 1_000_000_000n;
    const asked = Promise.withResolvers();
    const answer = Promise.withResolvers();
    engine.balanceRead = () => {
      asked.resolve();
      return answer.promise;
    };
    const reading = overview(localSend);
    await asked.promise;
    engine.balanceRead = null;
    statusChecks.nodeAnswers = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(response).resolves.toMatchObject({ ok: true, result: { hash: HASH } });
    answer.resolve();
    const ov = await reading;
    // In the one or the other, never in neither.
    expect([ov.txs, ov.waitingSends]).toEqual([[], [expect.objectContaining({ sendId: "send-0014", hash: HASH, waiting: false, went: expect.any(Number) })]]);
  });

  // Chen's: the Wi-Fi dropped as she paid on her first phone, she paid the same from her second, and the first sent
  // its copy too once it had the network back, without asking.
  it("holds a payment that waited where its account sent something else meanwhile, seen in the node's mempool, till Send it too", async () => {
    const { localSend } = await import("./localBus.js");
    const { nodeUrl } = await (await import("../shared/settings.js")).getSettings();
    const heard = page();
    engine.sendTransaction.mockRejectedValueOnce(Object.assign(new TypeError("Failed to fetch"), { data: { sent: false } })).mockResolvedValueOnce({ hash: HASH, nonce: 132n });
    statusChecks.nodeAnswers = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const reviewed = { ...params, _approvalContext: { walletId: "account of wallet A", profileIndex: 0, account: "account of wallet A", nodeUrl } };
    const response = localSend({ type: "DUSK_UI_SEND_TX", sendId: "send-0012", walletId: "account of wallet A", seenNonce: "130", params: reviewed });
    await vi.waitFor(() => expect(heard()).toContainEqual({ type: "DUSK_UI_SEND_WAITING", sendId: "send-0012", waits: true }));

    // Her other phone's payment waits in the node's mempool as the network comes back.
    node.waiting = [131];
    statusChecks.nodeAnswers = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(heard()).toContainEqual({ type: "DUSK_UI_SEND_WAITING", sendId: "send-0012", waits: false, held: true }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(engine.sendTransaction).toHaveBeenCalledOnce();
    expect((await overview(localSend)).waitingSends).toEqual([expect.objectContaining({ sendId: "send-0012", memo: "Cendol", waiting: true, held: true })]);

    // Send it too: out it goes once the chain has her other payment, never at its nonce (Astra's).
    await expect(localSend({ type: "DUSK_UI_SEND_HELD", sendId: "send-0012" })).resolves.toEqual({ ok: true, result: { sending: true } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(engine.sendTransaction).toHaveBeenCalledOnce();
    node.nonce = 131;
    node.waiting = [];
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(response).resolves.toMatchObject({ ok: true, result: { hash: HASH } });
    expect(engine.sendTransaction).toHaveBeenCalledTimes(2);
  });

  // Astra's: a Testnet payment lost its answer, Mainnet was chosen meanwhile, and the payment the node had all the same
  // was kept as Mainnet's.
  it("keeps a payment the node had after all under the network it was sent on, whatever was chosen since", async () => {
    const { localSend } = await import("./localBus.js");
    const settings = await import("../shared/settings.js");
    const { nodeUrl } = await settings.getSettings();
    const other = nodeUrl.includes("testnet") ? "https://nodes.dusk.network" : "https://testnet.nodes.dusk.network";
    const heard = page();
    engine.sendTransaction.mockImplementationOnce(handsOverAndLoses);
    statusChecks.nodeAnswers = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const reviewed = { ...params, _approvalContext: { walletId: "account of wallet A", profileIndex: 0, account: "account of wallet A", nodeUrl } };
      const response = localSend({ type: "DUSK_UI_SEND_TX", sendId: "send-0011", walletId: "account of wallet A", params: reviewed });
      await vi.waitFor(() => expect(heard()).toContainEqual({ type: "DUSK_UI_SEND_WAITING", sendId: "send-0011", waits: true, handedOver: true }));
      // The other network chosen; the node it was sent to has it in its mempool.
      await settings.setSettings({ nodeUrl: other });
      node.has = "mempool";
      statusChecks.nodeAnswers = true;
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(response).resolves.toMatchObject({ ok: true, result: { hash: HASH } });
      const { getTxMeta } = await import("../shared/txStore.js");
      expect(await getTxMeta(HASH)).toMatchObject({ nodeUrl, status: expect.any(String) });
    } finally {
      await settings.setSettings({ nodeUrl });
    }
  });

  it("handed over as the app was ended, is said not sent once open again where the node never had it, and sent where it has", async () => {
    const { nodeUrl } = await (await import("../shared/settings.js")).getSettings();
    localStorage.setItem("dusk_waiting_sends_v1", JSON.stringify({ "send-0009": kept({ nodeUrl, hash: HASH, nonce: "131" }) }));
    // The app opened again.
    vi.resetModules();
    const { localSend } = await import("./localBus.js");
    await vi.waitFor(async () => expect((await overview(localSend)).waitingSends).toEqual([expect.objectContaining({ sendId: "send-0009", waiting: false, ended: "closed" })]));
    expect((await overview(localSend)).txs).toEqual([]);

    // Another, which the node has in its block: in Activity, never said not sent.
    vi.resetModules();
    node.has = "chain";
    localStorage.setItem("dusk_waiting_sends_v1", JSON.stringify({ "send-0010": kept({ sendId: "send-0010", nodeUrl, hash: HASH, nonce: "131" }) }));
    const again = await import("./localBus.js");
    await vi.waitFor(async () => expect((await overview(again.localSend)).txs).toEqual([expect.objectContaining({ hash: HASH, memo: "Cendol" })]));
    expect((await overview(again.localSend)).waitingSends).toEqual([]);
  });
});

describe("the balance in the app", () => {
  // Chen's: opened with no signal, Firefox for Android showed "—" for every balance while saying they "may be out
  // of date"; the app does the same where Android ended it and it's opened offline.
  it("shows the one read last on this phone where it can't be read now, said to be out of date with when it was read", async () => {
    const { localSend } = await import("./localBus.js");
    engine.balance = 857535243n;
    const readFrom = Date.now();
    await expect(localSend({ type: "DUSK_UI_OVERVIEW" })).resolves.toMatchObject({ balance: { value: "857535243" }, balanceError: null });
    const readTo = Date.now();

    // No signal now. Lena's wish, the sixth round: each part kept says when it was read, the shielded balance's too.
    engine.balance = null;
    const offline = await localSend({ type: "DUSK_UI_OVERVIEW" });
    expect(offline).toMatchObject({ balance: { value: "857535243" }, balanceStale: true, balanceReadAt: expect.any(Number), shieldedBalance: { value: "0" }, shieldedStale: true, shieldedReadAt: expect.any(Number) });
    for (const at of [offline.balanceReadAt, offline.shieldedReadAt]) expect(at >= readFrom && at <= readTo).toBe(true);
    expect(offline.balanceError).toBeTruthy();

    // Nothing kept: nothing shown, never a figure made up.
    const { forgetKeptBalances } = await import("../shared/keptBalances.js");
    await forgetKeptBalances();
    const none = await localSend({ type: "DUSK_UI_OVERVIEW" });
    expect([none.balance, none.balanceStale]).toEqual([null, undefined]);
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

  it("goes back to the default network, for the engine too", async () => {
    const { localSend } = await import("./localBus.js");
    const { setSettings } = await import("../shared/settings.js");
    const engine = await import("../shared/walletEngine.js");
    const configured = vi.spyOn(engine, "configure");
    await setSettings({ nodeUrl: "https://hostile-node.example", chainId: 1 });
    await expect(localSend({ type: "DUSK_UI_RESET_WALLET" })).resolves.toEqual({ ok: true });
    expect(configured).toHaveBeenLastCalledWith(expect.objectContaining({ nodeUrl: "https://nodes.dusk.network", chainId: 1 }));
    expect(localStorage.getItem("dusk_settings_v1")).toBeNull();
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

    it("keep the network it was on, one of Dusk's own, and go back to Mainnet from any other node", async () => {
      const { getSettings, setSettings } = await import("../shared/settings.js");
      let localSend = await walletA();
      await setSettings({ nodeUrl: "https://testnet.nodes.dusk.network", proverUrl: "https://testnet.provers.dusk.network", chainId: 2 });
      await expect(localSend({ type: "DUSK_UI_RESTORE_WALLET", mnemonic: "wallet A", password: "new password" })).resolves.toMatchObject({ ok: true });
      expect(await getSettings()).toMatchObject({
        nodeUrl: "https://testnet.nodes.dusk.network",
        proverUrl: "https://testnet.provers.dusk.network",
        archiverUrl: "https://testnet.nodes.dusk.network",
        chainId: 2,
      });

      localSend = await walletA();
      await setSettings({ nodeUrl: "https://my-node.example", proverUrl: "https://my-node.example", archiverUrl: "https://my-node.example", chainId: 2 });
      await expect(localSend({ type: "DUSK_UI_RESTORE_WALLET", mnemonic: "wallet A", password: "new password" })).resolves.toMatchObject({ ok: true });
      expect((await getSettings()).nodeUrl).toBe("https://nodes.dusk.network");
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

describe("the network's status, in the app", () => {
  beforeEach(() => {
    vi.resetModules();
    engine.unlocked = false;
    statusChecks.real = true;
  });

  afterEach(() => {
    statusChecks.real = false;
  });

  it("is checked as the wallet draws, and the page drawn again with what the check found, as the extension's dot says it", async () => {
    localStorage.setItem("dusk_settings_v1", JSON.stringify({ nodeUrl: "https://testnet.nodes.dusk.network", chainId: 2 }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"chain_id":2}')));
    const told = vi.fn();
    vi.stubGlobal("window", { dispatchEvent: told });
    const { localSend } = await import("./localBus.js");
    // Never checked: unknown, and a check starts.
    await expect(localSend({ type: "DUSK_UI_OVERVIEW" })).resolves.toMatchObject({ networkStatus: { nodeStatus: expect.stringMatching(/unknown|checking/) } });
    await vi.waitFor(() => expect(told.mock.calls.map(([event]) => event.detail.type)).toContain("DUSK_UI_NETWORK_CHANGED"));
    await expect(localSend({ type: "DUSK_UI_OVERVIEW" })).resolves.toMatchObject({ networkStatus: { nodeStatus: "online" } });

    // Without a signal, asked now, as the page asks back online: offline.
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(localSend({ type: "DUSK_UI_CHECK_NETWORK" })).resolves.toMatchObject({ networkStatus: { nodeStatus: "offline" } });
    await expect(localSend({ type: "DUSK_UI_OVERVIEW" })).resolves.toMatchObject({ networkStatus: { nodeStatus: "offline" } });
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

  it("refuses a node, prover or archiver over plain http on another computer, and saves nothing", async () => {
    const fetch = vi.fn(async () => new Response('{"chain_id":2}'));
    vi.stubGlobal("fetch", fetch);
    const { localSend } = await import("./localBus.js");
    for (const [message, problem] of [
      [{ nodeUrl: "http://hostile-node.example" }, "The node URL must start with https://, unless it's on this computer."],
      [{ nodeUrl: NODE, proverUrl: "http://hostile-node.example" }, "The prover URL must start with https://, unless it's on this computer."],
      [{ nodeUrl: NODE, archiverUrl: "ftp://hostile-node.example" }, "Invalid archiver URL format"],
    ]) {
      await expect(localSend({ type: "DUSK_UI_SET_NODE_URL", ...message })).resolves.toMatchObject({ error: { message: problem } });
    }
    expect(fetch).not.toHaveBeenCalled();
    await expect(localSend({ type: "DUSK_UI_SET_NODE_URL", nodeUrl: "http://localhost:8080" })).resolves.toMatchObject({ ok: true, nodeUrl: "http://localhost:8080" });
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

  it("counts every wallet the vault holds for Settings, one another password opens included", async () => {
    engine.unlocked = false;
    // A wallet under another password, then main's vault beside it.
    await (await import("../shared/vault.js")).createVault("wallet B", "another password");
    localStorage.setItem("dusk_vault_v1", JSON.stringify(twelve.vault));
    await ok({ type: "DUSK_UI_UNLOCK", password: twelve.password });
    const { wallets, walletsHere } = await overview();
    expect([wallets.length, walletsHere]).toEqual([1, 2]);
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
    // Its sends no longer looked for by Android, and no other wallet's forgotten.
    expect(phoneNotices.forgotten.filter((w) => w === second.walletId)).toEqual([second.walletId]);
    expect(phoneNotices.forgotten).not.toContain(first.walletId);

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
    // The unlock form, by its password field: it has no heading.
    expect(page.querySelector("#unlock-password")).toBeNull();

    // The first wallet's profile, picked from the menu; the engine fails the switch.
    engine.switchFails = true;
    header.querySelector(".account-chip").click();
    await flush();
    const rows = dom.document.body.querySelectorAll(".acct-menu-wallet")[0].querySelectorAll(".net-menu-item");
    expect(rows.length).toBeGreaterThan(0);
    rows[0].click();
    await flush();
    expect(engine.unlocked).toBe(false);
    expect(page.querySelector("#unlock-password")).not.toBeNull();
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

  // Chen's: the recovery words, to check them, in the app's Settings.
  it("gives the open wallet's recovery phrase for the password that opens it, and nothing for another", async () => {
    await twoWallets();
    await expect(send({ type: "DUSK_UI_RECOVERY_PHRASE", password: "not it" })).resolves.toMatchObject({ error: { message: "Incorrect password" } });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(send({ type: "DUSK_UI_RECOVERY_PHRASE", password: "password123" })).resolves.toEqual({ ok: true, result: engine.wallet });
    await ok({ type: "DUSK_UI_LOCK" });
    await expect(send({ type: "DUSK_UI_RECOVERY_PHRASE", password: "password123" })).resolves.toMatchObject({ error: { message: "Wallet locked" } });
  });

  // Amélie's: Check your recovery words, in Settings. The wallet compares them and says whether they match:
  // never the phrase, whatever was typed (Nandini's and Amélie's).
  it("checks words of the open wallet's phrase for the password that opens it, saying only whether they match", async () => {
    await twoWallets();
    const check = (over) => send({ type: "DUSK_UI_CHECK_RECOVERY_WORDS", password: "password123", ...over });
    await expect(check({ password: "not it" })).resolves.toMatchObject({ error: { message: "Incorrect password" } });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const words = engine.wallet.split(" ");
    await expect(check()).resolves.toEqual({ ok: true, count: words.length });
    await expect(check({ words: words.map((word, i) => [i + 1, ` ${word.toUpperCase()} `]) })).resolves.toEqual({ ok: true, match: true });
    await expect(check({ words: [[1, "zoo"]] })).resolves.toEqual({ ok: true, match: false });
    await expect(check({ words: [[1, "maison"], [2, "velo"], [3, "gateau"]] })).resolves.toEqual({ ok: true, match: false });
    await expect(check({ words: [[words.length + 1, "zoo"]] })).resolves.toEqual({ ok: true, match: false });
    // Compared as the web wallet compares them (app-core): one place asked twice is no check of three.
    await expect(check({ words: [[1, words[0]], [1, words[0]], [2, words[1]]] })).resolves.toEqual({ ok: true, match: false });
    await ok({ type: "DUSK_UI_LOCK" });
    await expect(check()).resolves.toMatchObject({ error: { message: "Wallet locked" } });
  });

  it("removes every wallet on Reset, and on a restore after a forgotten password", async () => {
    await twoWallets();
    await ok({ type: "DUSK_UI_LOCK" });
    await ok({ type: "DUSK_UI_RESTORE_WALLET", mnemonic: "wallet C", password: "password456" });
    expect(vault().wallets).toHaveLength(1);
    expect((await overview()).wallets).toMatchObject([{ n: 1, walletId: accountOf("wallet C") }]);

    // Not without the password the wallets here open with.
    await expect(send({ type: "DUSK_UI_RESET_WALLET" })).resolves.toMatchObject({ error: { message: "Incorrect password" } });
    await expect(send({ type: "DUSK_UI_RESET_WALLET", password: "password123" })).resolves.toMatchObject({ error: { message: expect.stringMatching(/Incorrect password|Too many attempts/) } });
    expect(vault().wallets).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    await ok({ type: "DUSK_UI_RESET_WALLET", password: "password456" });
    for (const key of ["dusk_vault_v1", "dusk_vault_v2", "dusk_wallets_v1", "dusk_permissions_v2"]) expect(localStorage.getItem(key)).toBeNull();
    await expect(send({ type: "DUSK_UI_STATUS" })).resolves.toMatchObject({ hasVault: false });
  });
});

// Hein's: arrival notices in the app on a phone, asked for by the person. The
// phone's side (platform/notices.js, android/NoticesPlugin.kt) answers here as
// a test says, and records what it was asked.
describe("arrival notices in the app on a phone", () => {
  const phone = ({ allowed }) => {
    Object.assign(phoneNotices, { allowed, asked: [], watched: [], settled: [], forgotten: [], waiting: [], shown: null });
    vi.stubGlobal("navigator", { ...globalThis.navigator, userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 6; wv) Chrome/156.0 Mobile Safari/537.36" });
    vi.stubGlobal("document", { visibilityState: "hidden" });
    return phoneNotices.asked;
  };
  const sendAndSettle = async (localSend, hash, { to = ACCOUNT, amount = "1", toName, memo } = {}) => {
    engine.executed = Promise.withResolvers();
    engine.sendTransaction.mockResolvedValueOnce({ hash, nonce: 1n });
    await localSend({ type: "DUSK_UI_SEND_TX", params: { kind: "transfer", privacy: "public", to, amount, ...(memo ? { memo } : {}) }, ...(toName ? { toName } : {}) });
    engine.executed.resolve({ data: { err: null } });
  };
  // What a send left behind, done: its watcher's steps, as many as it takes.
  const settled = async (hash) => {
    const { getTxMeta } = await import("../shared/txStore.js");
    await vi.waitFor(async () => expect((await getTxMeta(hash))?.status).toBe("executed"));
  };

  it("shows none and asks nothing by itself, asks once when the person taps, and then shows the arrival", async () => {
    let allowed = false;
    const asked = phone({ allowed: () => allowed });
    const { localSend } = await import("./localBus.js");
    await sendAndSettle(localSend, "d1".repeat(32));
    await settled("d1".repeat(32));
    expect(asked).toEqual([]);

    // Tell me when it arrives: Android's question, and a yes.
    allowed = true;
    await expect(localSend({ type: "DUSK_UI_NOTICES_ASK" })).resolves.toMatchObject({ state: "on" });
    await expect(localSend({ type: "DUSK_UI_NOTICES_ASK" })).resolves.toMatchObject({ state: "on" });
    expect(asked).toEqual(["ask"]);
    // Chen's and Sofía's: "Your payment arrived · Testnet" didn't say which payment. How much and to whom, as
    // Activity names them; a locked phone that hides what notices say shows what came of it and the network.
    await sendAndSettle(localSend, "d2".repeat(32), { amount: "10000000", toName: "lena.dusk" });
    await vi.waitFor(() => expect(asked.at(-1)).toEqual("notify: Your payment arrived"));
    // With the token made for its send's notice, by which its tap is known as the notice's.
    const { noticeTokenFor } = await import("../shared/noticeTokens.js");
    expect(phoneNotices.shown).toEqual({ title: "Your payment arrived", body: "0.01 DUSK to lena.dusk · Mainnet", publicBody: "Mainnet", hash: "d2".repeat(32), token: await noticeTokenFor("d2".repeat(32)) });
    expect(phoneNotices.shown.token).toMatch(/^[0-9a-f]{32}$/);
    // To a profile of this wallet, by its name; with balances hidden, no amount.
    const { setSettings } = await import("../shared/settings.js");
    await setSettings({ hideBalances: true });
    await sendAndSettle(localSend, "d6".repeat(32), { to: `account 1 of ${engine.wallet}`, amount: "10000000" });
    await vi.waitFor(() => expect(phoneNotices.shown?.hash).toBe("d6".repeat(32)));
    expect([phoneNotices.shown.body, phoneNotices.shown.publicBody]).toEqual(["To Profile 2 · Mainnet", "Mainnet"]);
    await setSettings({ hideBalances: false });

    // Learned another way, as the app looks a send up again: a notice all the same, once.
    const { patchTxMeta, putTxMeta } = await import("../shared/txStore.js");
    await putTxMeta("d4".repeat(32), { status: "submitted", nodeUrl: "https://testnet.nodes.dusk.network" });
    await patchTxMeta("d4".repeat(32), { status: "executed" });
    await patchTxMeta("d4".repeat(32), { status: "executed" });
    await vi.waitFor(() => expect(asked.filter((step) => step.startsWith("notify"))).toHaveLength(2));
  });

  // Chen's: a payment confirmed as the signal dropped didn't go out with the app in the background, the signal back
  // for minutes, and nothing said so. The app sends only while it's open: Android's notice says so while it's away.
  // Chen's and Sofía's: "A payment is waiting" didn't say which payment. Named where the phone shows a notice whole;
  // the neutral words where a locked phone hides what notices say.
  it("tells Android of a payment waiting for the network, named but on a locked phone, and that none waits once it's gone out", async () => {
    let allowed = false;
    phone({ allowed: () => allowed });
    const { localSend } = await import("./localBus.js");
    const { getSettings } = await import("../shared/settings.js");
    const params = { kind: "transfer", privacy: "public", to: ACCOUNT, amount: "10000000", memo: "cendol" };
    const offline = () => Object.assign(new TypeError("Failed to fetch"), { data: { sent: false } });
    statusChecks.nodeAnswers = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Notices not allowed on the phone: Android's told nothing of it, as it could show nothing.
      engine.sendTransaction.mockRejectedValue(offline());
      const quiet = localSend({ type: "DUSK_UI_SEND_TX", sendId: "send-0101", walletId: "account of wallet A", params });
      await vi.waitFor(async () => expect((await localSend({ type: "DUSK_UI_OVERVIEW" })).waitingSends).toHaveLength(1));
      expect(phoneNotices.waiting.filter(Boolean)).toEqual([]);
      // Filmed with Chen's app: allowed, though Tell me when it arrives was never tapped, the app was put away with
      // it waiting, and no notice came, nor once the network was back. Told as the wallet draws, nothing asked.
      allowed = true;
      await localSend({ type: "DUSK_UI_OVERVIEW" });
      await vi.waitFor(() => expect(phoneNotices.waiting.at(-1)).toMatchObject({ publicTitle: "A payment is waiting" }));
      expect(phoneNotices.asked).toEqual([]);
      await localSend({ type: "DUSK_UI_CANCEL_SEND", sendId: "send-0101" });
      await quiet;
      await vi.waitFor(() => expect(phoneNotices.waiting.at(-1)).toBeNull());

      // On its first try, as the app may be left before the try's through (the signal gone, it hangs): told then,
      // with the node to ask and the notice's words.
      const firstTry = Promise.withResolvers();
      engine.sendTransaction.mockReset();
      engine.sendTransaction.mockReturnValueOnce(firstTry.promise).mockResolvedValueOnce({ hash: "ef".repeat(32), nonce: 1n });
      const response = localSend({ type: "DUSK_UI_SEND_TX", sendId: "send-0102", walletId: "account of wallet A", params });
      const { nodeUrl } = await getSettings();
      await vi.waitFor(() =>
        expect(phoneNotices.waiting.at(-1)).toEqual({
          wallet: "account of wallet A",
          nodeUrl,
          title: `0.01 DUSK to ${ACCOUNT.slice(0, 6)}…${ACCOUNT.slice(-6)} is waiting`,
          publicTitle: "A payment is waiting",
          away: "Goes out when you reopen Dusk Wallet, or asks first if Android closed it.",
          back: "Open Dusk Wallet to send it.",
        })
      );
      // What a locked phone shows: no amount, no name, no memo.
      const { publicTitle, away, back } = phoneNotices.waiting.at(-1);
      expect(JSON.stringify([publicTitle, away, back])).not.toMatch(/0\.01|cendol|lucas|26FCH7/);
      firstTry.reject(offline());
      await vi.waitFor(async () => expect((await localSend({ type: "DUSK_UI_OVERVIEW" })).waitingSends).toEqual([expect.objectContaining({ sendId: "send-0102", waits: true })]));
      expect(phoneNotices.waiting.at(-1)).toMatchObject({ publicTitle: "A payment is waiting" });
      // Balances hidden meanwhile, then shown: its amount goes from the notice, and comes back (round 40's second
      // review: hidden, the app put away said it all the same).
      const short = `${ACCOUNT.slice(0, 6)}…${ACCOUNT.slice(-6)}`;
      await localSend({ type: "DUSK_UI_SET_HIDE_BALANCES", hideBalances: true });
      expect(phoneNotices.waiting.at(-1)).toMatchObject({ title: `A payment to ${short} is waiting`, publicTitle: "A payment is waiting" });
      await localSend({ type: "DUSK_UI_SET_HIDE_BALANCES", hideBalances: false });
      expect(phoneNotices.waiting.at(-1)).toMatchObject({ title: `0.01 DUSK to ${short} is waiting` });

      // The network back, the app open: it goes out, and none waits.
      statusChecks.nodeAnswers = true;
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(response).resolves.toMatchObject({ ok: true, result: { hash: "ef".repeat(32) } });
      await vi.waitFor(() => expect(phoneNotices.waiting.at(-1)).toBeNull());

      // One waiting as the wallet locks isn't sent: none waits for the app to open.
      statusChecks.nodeAnswers = false;
      engine.sendTransaction.mockRejectedValueOnce(offline());
      const locked = localSend({ type: "DUSK_UI_SEND_TX", sendId: "send-0103", walletId: "account of wallet A", params });
      await vi.waitFor(() => expect(phoneNotices.waiting.at(-1)).toMatchObject({ publicTitle: "A payment is waiting" }));
      await localSend({ type: "DUSK_UI_LOCK" });
      await locked;
      await vi.waitFor(() => expect(phoneNotices.waiting.at(-1)).toBeNull());
    } finally {
      vi.useRealTimers();
      statusChecks.nodeAnswers = true;
      engine.sendTransaction.mockReset();
    }
  });

  // Astra's: Android ended the app with a payment waiting; started again, the payment was said not sent, but Android
  // still had it as waiting, and leaving the app posted "A payment is waiting" and looked for the network again.
  it("tells Android as the app starts that none waits, one that waited before being said not sent", async () => {
    vi.resetModules();
    phone({ allowed: () => true });
    const { nodeUrl } = await (await import("../shared/settings.js")).getSettings();
    // Kept as Android ended the app with it waiting.
    localStorage.setItem(
      "dusk_waiting_sends_v1",
      JSON.stringify({ "send-0109": { sendId: "send-0109", walletId: "account of wallet A", nodeUrl, profileIndex: 0, privacy: "public", to: ACCOUNT, lux: "10000000", feeLux: "2500000", memo: "cendol", at: 1 } })
    );
    const { localSend } = await import("./localBus.js");
    await vi.waitFor(() => expect(phoneNotices.waiting).toEqual([null]));
    expect((await localSend({ type: "DUSK_UI_OVERVIEW" })).waitingSends).toEqual([expect.objectContaining({ sendId: "send-0109", waiting: false, ended: "closed" })]);
    // Read again: nothing more to tell.
    expect(phoneNotices.waiting).toEqual([null]);
  });

  it("never asks again after a no, and shows arrivals once notices are allowed in the phone's settings", async () => {
    let allowed = false;
    const asked = phone({ allowed: () => allowed });
    const { localSend } = await import("./localBus.js");
    await expect(localSend({ type: "DUSK_UI_NOTICES_ASK" })).resolves.toMatchObject({ state: "off" });
    await expect(localSend({ type: "DUSK_UI_NOTICES_ASK" })).resolves.toMatchObject({ state: "off" });
    await sendAndSettle(localSend, "d3".repeat(32));
    await settled("d3".repeat(32));
    expect(asked).toEqual(["ask"]);
    await localSend({ type: "DUSK_UI_NOTICES_SAID" });
    await expect(localSend({ type: "DUSK_UI_NOTICES" })).resolves.toMatchObject({ state: "off-said" });

    // Astra's: allowed later in Android's settings, as Sent said, and arrivals still off for good.
    allowed = true;
    await expect(localSend({ type: "DUSK_UI_NOTICES" })).resolves.toMatchObject({ state: "on" });
    await sendAndSettle(localSend, "d5".repeat(32));
    await vi.waitFor(() => expect(asked).toEqual(["ask", "notify: Your payment arrived"]));
  });

  // Chen's and Sofía's: Android cuts the app's network seconds after it leaves the screen, and the notice never came.
  it("has Android look for a send the person asked to hear of once the app is left, and stop once the wallet heard it", async () => {
    const allowed = () => true;
    phone({ allowed });
    const { localSend } = await import("./localBus.js");
    const { putTxMeta } = await import("../shared/txStore.js");
    // Asked for on Sent, the send on its way: Android looks for it, with its notice for either outcome.
    await putTxMeta("e1".repeat(32), { status: "submitted", kind: "transfer", nodeUrl: "https://testnet.nodes.dusk.network", walletId: ACCOUNT });
    await expect(localSend({ type: "DUSK_UI_NOTICES_ASK", hash: "e1".repeat(32) })).resolves.toMatchObject({ state: "on" });
    expect(phoneNotices.watched).toEqual([
      { hash: "e1".repeat(32), nodeUrl: "https://testnet.nodes.dusk.network", title: "Your payment arrived", failTitle: "Your payment didn't go through", body: "Testnet", publicBody: "Testnet", wallet: ACCOUNT, token: expect.stringMatching(/^[0-9a-f]{32}$/) },
    ]);
    // Its notice's token, by which its tap is known as the notice's, kept on the phone.
    const { noticeTokenFor } = await import("../shared/noticeTokens.js");
    expect(await noticeTokenFor("e1".repeat(32))).toBe(phoneNotices.watched[0].token);
    // Notices on, each send after: looked for from the start, and no more once its outcome is heard.
    await sendAndSettle(localSend, "e2".repeat(32), { amount: "30000000", toName: "sofiadesign.dusk" });
    await settled("e2".repeat(32));
    await vi.waitFor(() => expect(phoneNotices.watched.map((w) => w.hash)).toEqual(["e1".repeat(32), "e2".repeat(32)]));
    expect(phoneNotices.watched[1].token).toBe(await noticeTokenFor("e2".repeat(32)));
    // The notice Android shows says which payment, and on a locked phone that hides it, only what came of it.
    expect([phoneNotices.watched[1].title, phoneNotices.watched[1].body, phoneNotices.watched[1].publicBody]).toEqual(["Your payment arrived", "0.03 DUSK to sofiadesign.dusk · Mainnet", "Mainnet"]);
    await vi.waitFor(() => expect(phoneNotices.settled).toContain("e2".repeat(32)));
  });

  // Astra's: a send sent again with Send it now was never looked for by Android, nor followed to its block, as each
  // send is: it could stay on its way, and its notice never came.
  it("follows a send sent again with Send it now to its block, and has Android look for it, as any send", async () => {
    phone({ allowed: () => true });
    const { localSend } = await import("./localBus.js");
    const { getTxMeta, putTxMeta } = await import("../shared/txStore.js");
    await expect(localSend({ type: "DUSK_UI_NOTICES_ASK" })).resolves.toMatchObject({ state: "on" });
    const hash = "e8".repeat(32);
    await putTxMeta(hash, { status: "unsent", kind: "transfer", privacy: "public", to: ACCOUNT, amount: "1", walletId: "account of wallet A", account: ACCOUNT, nonce: "5", signedTx: "ab12", profileIndex: 0, nodeUrl: "https://testnet.nodes.dusk.network" });
    engine.executed = Promise.withResolvers();
    engine.rebroadcastTx.mockResolvedValueOnce({ hash, nonce: "5" });
    await expect(localSend({ type: "DUSK_UI_RESEND_TX", hash })).resolves.toEqual({ ok: true, result: { hash } });
    await vi.waitFor(() => expect(phoneNotices.watched.map((watched) => watched.hash)).toEqual([hash]));
    engine.executed.resolve({ data: { err: null } });
    await vi.waitFor(async () => expect((await getTxMeta(hash))?.status).toBe("executed"));
  });

  // Sofía's: "Your payment arrived · 0.01 DUSK to Lena · Testnet", after Android had closed the app, without the memo
  // that says which job it was.
  it("names the payment's memo in its notice, the one Android shows once the app's closed too, never on a locked screen", async () => {
    phone({ allowed: () => true });
    const { localSend } = await import("./localBus.js");
    await expect(localSend({ type: "DUSK_UI_NOTICES_ASK" })).resolves.toMatchObject({ state: "on" });
    await sendAndSettle(localSend, "e7".repeat(32), { amount: "10000000", toName: "lena.dusk", memo: "Metro sin cobertura 153" });
    await settled("e7".repeat(32));
    const watched = (hash) => phoneNotices.watched.find((w) => w.hash === hash);
    await vi.waitFor(() => expect(watched("e7".repeat(32))).toBeTruthy());
    expect([watched("e7".repeat(32)).body, watched("e7".repeat(32)).publicBody]).toEqual(["0.01 DUSK to lena.dusk · “Metro sin cobertura 153” · Mainnet", "Mainnet"]);
    // A memo a notice can't show as it is: left to its details.
    await sendAndSettle(localSend, "e8".repeat(32), { amount: "10000000", toName: "lena.dusk", memo: "Factura\u202e153" });
    await settled("e8".repeat(32));
    await vi.waitFor(() => expect(watched("e8".repeat(32))).toBeTruthy());
    expect(watched("e8".repeat(32)).body).toBe("0.01 DUSK to lena.dusk · Mainnet");
    await vi.waitFor(() => expect(phoneNotices.settled).toContain("e8".repeat(32)));
  });

  // Astra's: after a reset, Android kept looking for the old wallet's sends on its node, and told them.
  it("has Android forget every wallet's sends on a reset and a restore, each send kept with its wallet", async () => {
    phone({ allowed: () => true });
    const { localSend } = await import("./localBus.js");
    await localSend({ type: "DUSK_UI_NOTICES_ASK" });
    await sendAndSettle(localSend, "e4".repeat(32));
    await vi.waitFor(() => expect(phoneNotices.watched.map((w) => [w.hash, w.wallet])).toEqual([["e4".repeat(32), `account of ${engine.wallet}`]]));
    expect(phoneNotices.forgotten).toEqual([]);

    await expect(localSend({ type: "DUSK_UI_RESET_WALLET" })).resolves.toEqual({ ok: true });
    expect(phoneNotices.forgotten).toEqual([""]);
    await localSend({ type: "DUSK_UI_CREATE_WALLET", mnemonic: "wallet A", password: "password123" });
    await localSend({ type: "DUSK_UI_LOCK" });
    await expect(localSend({ type: "DUSK_UI_RESTORE_WALLET", mnemonic: "wallet A", password: "new password" })).resolves.toMatchObject({ ok: true });
    expect(phoneNotices.forgotten).toEqual(["", ""]);
  });

  // Sofía's: no notice when a client paid her with the app away. Android's job tells those (android/ArrivalJob.kt);
  // its tap opens the payment in the profile it came to, by the wallet's token for those notices, and nothing else.
  it("takes a tap on a notice of money that came in only with the open wallet's token, to one of its profiles", async () => {
    phone({ allowed: () => true });
    const { localSend } = await import("./localBus.js");
    const HASH = "e5".repeat(32);
    const { token } = await localSend({ type: "DUSK_UI_INCOMING_TOKEN" });
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    await expect(localSend({ type: "DUSK_UI_INCOMING_TOKEN" })).resolves.toMatchObject({ token });
    // Kept apart from the sends' tokens: as many sends after as you like, it still opens.
    const { noticeTokenFor } = await import("../shared/noticeTokens.js");
    for (let i = 0; i < 55; i++) await noticeTokenFor(i.toString(16).padStart(64, "0"));
    const tap = (over) => localSend({ type: "DUSK_UI_TX_NOTICED", hash: HASH, token, account: `account 1 of ${engine.wallet}`, ...over });
    await expect(tap()).resolves.toMatchObject({ ok: true, result: { incoming: true, profileIndex: 1 } });
    // Again: taken more than once, as each of its notices carries it.
    await expect(tap({ account: `account of ${engine.wallet}` })).resolves.toMatchObject({ result: { incoming: true, profileIndex: 0 } });
    // Another token, a send's, an account of no profile here, or a locked wallet: nothing opens.
    await expect(tap({ token: "d5".repeat(16) })).resolves.toMatchObject({ ok: true, result: null });
    await expect(tap({ token: await noticeTokenFor(HASH) })).resolves.toMatchObject({ ok: true, result: null });
    await expect(tap({ account: ACCOUNT })).resolves.toMatchObject({ ok: true, result: null });
    // Locked, as by its auto-lock while the page still showed it open: said so, for the page to keep
    // the tap for the unlock (issue #214), rather than as a tap that opens nothing.
    engine.unlocked = false;
    await expect(tap()).resolves.toEqual({ error: expect.objectContaining({ message: "Wallet locked" }) });
    engine.unlocked = true;
  });

  it("keeps notices of money coming in on until they're turned off in Settings, and says so in the overview", async () => {
    phone({ allowed: () => true });
    const { localSend } = await import("./localBus.js");
    await expect(localSend({ type: "DUSK_UI_OVERVIEW" })).resolves.toMatchObject({ incomingNotices: true });
    await expect(localSend({ type: "DUSK_UI_SET_INCOMING_NOTICES", on: false })).resolves.toMatchObject({ ok: true, incomingNotices: false });
    await expect(localSend({ type: "DUSK_UI_OVERVIEW" })).resolves.toMatchObject({ incomingNotices: false });
    await expect(localSend({ type: "DUSK_UI_SET_INCOMING_NOTICES", on: true })).resolves.toMatchObject({ incomingNotices: true });
  });

  it("asks Android to look for nothing while the person hasn't asked for notices", async () => {
    phone({ allowed: () => true });
    const { localSend } = await import("./localBus.js");
    await sendAndSettle(localSend, "e3".repeat(32));
    await settled("e3".repeat(32));
    expect(phoneNotices.watched).toEqual([]);
  });

  // Astra's: notices kept "on" by an earlier build, Android's leave taken back
  // later: Sent said they're off on every send, as its saying wasn't kept.
  it("says notices are off once when Android's leave is taken back, whatever was kept", async () => {
    const asked = phone({ allowed: () => false });
    const { setSettings } = await import("../shared/settings.js");
    await setSettings({ phoneNotices: "on" });
    const { localSend } = await import("./localBus.js");
    await expect(localSend({ type: "DUSK_UI_NOTICES" })).resolves.toMatchObject({ state: "off" });
    await localSend({ type: "DUSK_UI_NOTICES_SAID" });
    await expect(localSend({ type: "DUSK_UI_NOTICES" })).resolves.toMatchObject({ state: "off-said" });
    expect(asked).toEqual([]);
  });
});

// Sofía's: every change of Auto-lock said "Couldn't save auto-lock", and a
// time chosen never locked the app: only Immediately had a home in it.
describe("Auto-lock in the app", () => {
  it("saves the time chosen, says it in the overview, and locks after that long without use", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { localSend } = await import("./localBus.js");
      const told = vi.fn();
      vi.stubGlobal("window", { dispatchEvent: told });
      await expect(localSend({ type: "DUSK_UI_SET_AUTO_LOCK", autoLockTimeoutMinutes: 5 })).resolves.toMatchObject({ ok: true, autoLockTimeoutMinutes: 5 });
      await expect(localSend({ type: "DUSK_UI_OVERVIEW" })).resolves.toMatchObject({ isUnlocked: true, autoLockTimeoutMinutes: 5 });
      // Used four minutes on: still open five minutes after that use.
      vi.advanceTimersByTime(4 * 60_000);
      await expect(localSend({ type: "DUSK_UI_ACTIVITY" })).resolves.toMatchObject({ ok: true });
      vi.advanceTimersByTime(4 * 60_000);
      await expect(localSend({ type: "DUSK_UI_OVERVIEW" })).resolves.toMatchObject({ isUnlocked: true });
      // Five minutes without a press: locked as the page asks, and the page is told.
      vi.advanceTimersByTime(60_000);
      await expect(localSend({ type: "DUSK_UI_OVERVIEW" })).resolves.toMatchObject({ isUnlocked: false });
      expect(told.mock.calls.map(([event]) => event.detail)).toContainEqual({ type: "DUSK_UI_LOCK_STATE", isUnlocked: false, reason: "auto_lock" });

      // Unlocked and used again, then Off: never.
      engine.unlocked = true;
      await localSend({ type: "DUSK_UI_ACTIVITY" });
      await localSend({ type: "DUSK_UI_SET_AUTO_LOCK", autoLockTimeoutMinutes: 0 });
      vi.advanceTimersByTime(60 * 60_000);
      await expect(localSend({ type: "DUSK_UI_OVERVIEW" })).resolves.toMatchObject({ isUnlocked: true, autoLockTimeoutMinutes: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});
