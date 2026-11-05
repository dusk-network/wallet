import { networks } from "@dusk-network/networks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { approveOrigin } from "../shared/permissions.js";
import { setSettings } from "../shared/settings.js";
import { assertSendPassword, askedOf, proveSendPassword, sendMoves, sendPasswordLimit, sendPasswordTerms, setSendPasswordLimit } from "../shared/sendPassword.js";
import { storage, STORAGE_KEYS } from "../shared/storage.js";
import { DAPP_RPC_METHODS } from "../shared/providerSurface.js";
import { createVault, addVaultWallet } from "../shared/vault.js";
import { handleRpc } from "./rpc.js";
import { pendingApprovals, resolvePendingDecision } from "./pending.js";

// The real RPC, queue, vault and setting: only storage, windows and the engine are
// stand-ins, as a site's request meets them.
const mocks = vi.hoisted(() => ({ store: {}, status: {}, engineCall: vi.fn(), windowsCreate: vi.fn(async () => ({ id: 1 })) }));
vi.mock("../platform/storage.js", () => ({
  kv: {
    get: async (keys) => {
      const names = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? {});
      const defaults = typeof keys === "object" && !Array.isArray(keys) ? keys : {};
      return structuredClone(Object.fromEntries(names.map((name) => [name, mocks.store[name] ?? defaults?.[name]])));
    },
    set: async (items) => {
      Object.assign(mocks.store, structuredClone(items));
    },
    remove: async (keys) => {
      for (const key of [].concat(keys)) delete mocks.store[key];
    },
  },
}));
vi.mock("../platform/extensionApi.js", () => ({
  getExtensionApi: () => ({ windows: { onRemoved: { addListener() {} } } }),
  runtimeGetURL: (path) => `chrome-extension://test/${path}`,
  windowsCreate: mocks.windowsCreate,
  windowsRemove: async () => {},
  tabsCreate: async () => {},
}));
vi.mock("./engineHost.js", () => ({
  engineCall: mocks.engineCall,
  ensureEngineConfigured: async () => {},
  getEngineStatus: async () => structuredClone(mocks.status),
  getEngineStatusStrict: async () => structuredClone(mocks.status),
  invalidateEngineConfig() {},
}));
vi.mock("./txNotify.js", () => ({ notifyTxSubmitted: async () => true }));

const NODE = "https://testnet.nodes.dusk.network";
const SITE = "https://dapp.example";
const PASSWORD = "the password here";
// Public BIP39 test phrases, never a real wallet's.
const PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const OTHER_PHRASE = "letter advice cage absurd amount doctor acoustic avoid letter advice cage above";
const ACCOUNT = "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const OTHER = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const DUSK = 1_000_000_000n;
const PUBLIC_GAS = { limit: "2000000", price: "1" };
const POOL = networks.testnet.sozu.fallbacks.pool;
const TOKEN = `0x${"ab".repeat(32)}`;

const transfer = (amount, over = {}) => ({ kind: "transfer", privacy: "public", to: OTHER, amount: String(amount), gas: PUBLIC_GAS, ...over });

// A site's request, its window open: what the site is told in the end, and what
// answers it there.
async function ask(params) {
  const outcome = handleRpc(SITE, { method: "dusk_sendTransaction", params }).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  await vi.waitFor(() => expect(pendingApprovals.size).toBe(1));
  const [[rid]] = pendingApprovals;
  return { outcome, rid, answer: (over = {}) => resolvePendingDecision({ rid, decision: "approve", approvedParams: null, ...over }) };
}

const sends = () => mocks.engineCall.mock.calls.filter(([method]) => method === "dusk_sendTransaction");

beforeEach(async () => {
  mocks.store = {};
  mocks.engineCall.mockReset();
  mocks.engineCall.mockImplementation(async (method) => {
    if (method === "dusk_getCachedGasPrice") return { median: "1" };
    if (method === "dusk_sendTransaction") return { hash: `0x${"cd".repeat(32)}` };
    return true;
  });
  const wallet = await createVault(PHRASE, PASSWORD);
  mocks.status = { isUnlocked: true, accounts: [ACCOUNT], addresses: [], selectedAccountIndex: 0, walletKey: wallet.id, wallets: [{ key: wallet.id, n: 1 }] };
  await setSettings({ nodeUrl: NODE });
  await approveOrigin(SITE, { accountIndex: 0, profileId: `account:0:${ACCOUNT}` }, ACCOUNT);
});

afterEach(() => {
  for (const [, entry] of pendingApprovals) clearTimeout(entry.timer);
  pendingApprovals.clear();
});

describe("the setting", () => {
  it("is off until it's chosen, kept on its own, and asks on every send where it can't be read", async () => {
    await expect(sendPasswordLimit()).resolves.toBeNull();
    await setSendPasswordLimit(5n * DUSK);
    await expect(sendPasswordLimit()).resolves.toBe(5n * DUSK);
    expect(mocks.store[STORAGE_KEYS.SEND_PASSWORD]).toBe("5000000000");
    expect(mocks.store[STORAGE_KEYS.SETTINGS]?.sendPassword).toBeUndefined();
    mocks.store[STORAGE_KEYS.SEND_PASSWORD] = { what: "this isn't one" };
    await expect(sendPasswordLimit()).resolves.toBe(0n);
    const { get } = storage;
    storage.get = async () => {
      throw new Error("storage is gone");
    };
    await expect(sendPasswordLimit()).resolves.toBe(0n);
    storage.get = get;
    await setSendPasswordLimit(null);
    await expect(sendPasswordLimit()).resolves.toBeNull();
    expect(STORAGE_KEYS.SEND_PASSWORD in mocks.store).toBe(false);
  });

  it("can't be read or changed by a site: no method names it, and capabilities don't say it", async () => {
    await setSendPasswordLimit(5n * DUSK);
    expect(DAPP_RPC_METHODS.filter((method) => /password/i.test(method))).toEqual([]);
    for (const method of ["DUSK_UI_SET_SEND_PASSWORD", "DUSK_UI_SEND_PASSWORD_ASKS", "DUSK_UI_SEND_PASSWORD_PROVE", "dusk_setSendPassword"]) {
      await expect(handleRpc(SITE, { method, params: { password: PASSWORD, limitLux: null } })).rejects.toMatchObject({ code: -32601 });
    }
    const capabilities = await handleRpc(SITE, { method: "dusk_getCapabilities" });
    expect(JSON.stringify(capabilities)).not.toMatch(/password|5000000000/i);
    await expect(sendPasswordLimit()).resolves.toBe(5n * DUSK);
  });
});

describe("what a send counts", () => {
  const LIMIT = 10n * DUSK;
  const fee = { gas: PUBLIC_GAS };

  it.each([
    ["a transfer", { kind: "transfer", amount: String(DUSK) }, DUSK],
    ["a shield", { kind: "shield", amount: String(DUSK) }, DUSK],
    ["an unshield", { kind: "unshield", amount: String(DUSK) }, DUSK],
    ["a stake", { kind: "stake", amount: String(DUSK) }, DUSK],
    ["an unstake, which comes back", { kind: "unstake", amount: String(DUSK) }, 0n],
    ["a claim, which comes back", { kind: "withdraw_reward", amount: String(DUSK) }, 0n],
    ["a stake with Sozu", { kind: "contract_call", contractId: POOL, fnName: "sozu_stake", amount: "0", deposit: String(DUSK) }, DUSK],
    ["an unstake from Sozu, which comes back", { kind: "contract_call", contractId: POOL, fnName: "sozu_unstake", amount: "0", deposit: "0" }, 0n],
  ])("takes %s at what goes out", (_name, params, moves) => {
    expect(sendMoves(params, NODE)).toEqual({ moves, always: false });
  });

  it("goes by what leaves with the most its fee can be, and asks nothing up to the amount", () => {
    expect(askedOf(transfer(LIMIT - 2_000_000n), LIMIT, NODE)).toBeNull();
    expect(askedOf(transfer(LIMIT - 2_000_000n + 1n), LIMIT, NODE)).toEqual({ limit: String(LIMIT), moves: String(LIMIT - 2_000_000n + 1n), always: false });
    // Off asks nothing, and 0 asks on every send.
    expect(askedOf(transfer(100n * DUSK), null, NODE)).toBeNull();
    expect(askedOf(transfer(1n), 0n, NODE)).not.toBeNull();
    // What comes back counts its fee alone.
    expect(askedOf({ kind: "unstake", amount: String(100n * DUSK), ...fee }, LIMIT, NODE)).toBeNull();
    expect(askedOf({ kind: "unstake", amount: String(100n * DUSK), ...fee }, 1n, NODE)).not.toBeNull();
  });

  it.each([
    ["a token's transfer", { contractId: TOKEN, fnName: "transfer" }],
    ["a token's allowance", { contractId: TOKEN, fnName: "approve" }],
    ["stDUSK's transfer, though the network's file names it", { contractId: networks.testnet.sozu.fallbacks.stDusk, fnName: "transfer" }],
    ["a call of a contract the network's file doesn't name", { contractId: TOKEN, fnName: "do_something" }],
  ])("asks on any amount for %s, which can't be counted in DUSK", (_name, call) => {
    const params = { kind: "contract_call", amount: "0", deposit: "0", ...call, ...fee };
    expect(askedOf(params, 100n * DUSK, NODE)).toMatchObject({ always: true });
  });
});

describe("a site's send", () => {
  const LIMIT = 5n * DUSK;
  beforeEach(() => setSendPasswordLimit(LIMIT));

  it("goes with no password up to the amount, and with it off, as ever", async () => {
    const below = await ask(transfer(DUSK));
    expect(await below.answer()).toEqual({ ok: true });
    expect((await below.outcome).value).toMatchObject({ hash: expect.any(String) });
    expect(sends()).toHaveLength(1);

    await setSendPasswordLimit(null);
    const off = await ask(transfer(100n * DUSK));
    expect(await off.answer()).toEqual({ ok: true });
    await off.outcome;
    expect(sends()).toHaveLength(2);
  });

  it("waits for the right password above it: none, or a wrong one, leaves it waiting, and nothing goes", async () => {
    const { outcome, rid, answer } = await ask(transfer(6n * DUSK));

    const none = await answer();
    expect(none).toMatchObject({ ok: false, error: { message: "It waits for your password, so nothing was sent.", data: { sendPassword: { limit: String(LIMIT), always: false } } } });
    expect(pendingApprovals.has(rid)).toBe(true);

    const wrong = await answer({ sendPassword: "not the password" });
    expect(wrong).toMatchObject({ ok: false, error: { message: "Incorrect password" } });
    expect(pendingApprovals.has(rid)).toBe(true);
    expect(sends()).toHaveLength(0);

    // A wrong one counts, as an unlock's does.
    const guard = mocks.store[STORAGE_KEYS.UNLOCK_GUARD];
    expect(guard.failures).toBe(1);
    mocks.store[STORAGE_KEYS.UNLOCK_GUARD] = { failures: 1, nextAllowedAt: 0 };

    await expect(answer({ sendPassword: PASSWORD })).resolves.toEqual({ ok: true });
    expect((await outcome).value).toMatchObject({ hash: expect.any(String) });
    expect(sends()).toHaveLength(1);
    expect(sends()[0][1].amount).toBe(String(6n * DUSK));
    // What it's checked with goes nowhere further.
    expect(JSON.stringify(sends()[0][1])).not.toContain(PASSWORD);
    expect(mocks.store[STORAGE_KEYS.UNLOCK_GUARD]).toBeUndefined();
  });

  it("makes a wrong password wait as an unlock does", async () => {
    const { answer } = await ask(transfer(6n * DUSK));
    await answer({ sendPassword: "not the password" });
    const again = await answer({ sendPassword: PASSWORD });
    expect(again.error.message).toMatch(/^Too many attempts\. Try again in \d+s\.$/);
    expect(sends()).toHaveLength(0);
  });

  it("takes only a password that opens the wallet open, not another's here", async () => {
    // The wallet open is one this password doesn't open; another here is.
    await addVaultWallet(OTHER_PHRASE, PASSWORD, {});
    mocks.status.walletKey = "another-wallet";
    const { answer } = await ask(transfer(6n * DUSK));
    await expect(answer({ sendPassword: PASSWORD })).resolves.toMatchObject({ ok: false, error: { message: "Incorrect password" } });
    expect(sends()).toHaveLength(0);
  });

  it("counts the fee the window chose: gas that lifts it past the amount asks too", async () => {
    const { outcome, answer } = await ask(transfer(5n * DUSK - 2_000_000n));
    const raised = { gas: { limit: "2000000", price: "5" } };
    await expect(answer({ approvedParams: raised })).resolves.toMatchObject({ ok: false, error: { message: "It waits for your password, so nothing was sent." } });
    await expect(answer({ approvedParams: raised, sendPassword: PASSWORD })).resolves.toEqual({ ok: true });
    await outcome;
    expect(sends()[0][1].gas).toMatchObject({ price: "5" });
  });

  it("asks of a token's transfer whatever the amount, in the window's terms too", async () => {
    const params = { kind: "contract_call", privacy: "public", contractId: TOKEN, fnName: "transfer", fnArgs: "0x00", amount: "0", deposit: "0", gas: PUBLIC_GAS };
    const { outcome, answer } = await ask(params);
    await expect(sendPasswordTerms(params, NODE)).resolves.toMatchObject({ always: true, limit: String(LIMIT) });
    await expect(answer()).resolves.toMatchObject({ ok: false, error: { data: { sendPassword: { always: true } } } });
    await expect(answer({ sendPassword: PASSWORD })).resolves.toEqual({ ok: true });
    await outcome;
    expect(sends()).toHaveLength(1);
  });

  it("is rejected as ever by Reject, with nothing asked", async () => {
    const { outcome, rid } = await ask(transfer(6n * DUSK));
    expect(resolvePendingDecision({ rid, decision: "reject" })).toEqual({ ok: true });
    expect((await outcome).error).toMatchObject({ code: 4001 });
    expect(sends()).toHaveLength(0);
  });

  it("asks when the setting was turned on while its window was open", async () => {
    await setSendPasswordLimit(null);
    const { outcome, answer } = await ask(transfer(6n * DUSK));
    await setSendPasswordLimit(LIMIT);
    await expect(answer()).resolves.toMatchObject({ ok: false, error: { data: { sendPassword: { limit: String(LIMIT) } } } });
    await expect(answer({ sendPassword: PASSWORD })).resolves.toEqual({ ok: true });
    await outcome;
  });
});

describe("the wallet's own send", () => {
  const WALLET = { walletId: ACCOUNT, nodeUrl: NODE };
  const key = () => mocks.status.walletKey;
  const params = transfer(6n * DUSK);
  beforeEach(() => setSendPasswordLimit(5n * DUSK));

  it("goes only with a ticket for that send, once", async () => {
    await expect(assertSendPassword(params, { ...WALLET })).rejects.toMatchObject({ message: "It waits for your password, so nothing was sent." });
    await expect(proveSendPassword("not the password", params, { ...WALLET, walletKey: key() })).rejects.toThrow("Incorrect password");
    mocks.store[STORAGE_KEYS.UNLOCK_GUARD] = undefined;
    delete mocks.store[STORAGE_KEYS.UNLOCK_GUARD];

    const ticket = await proveSendPassword(PASSWORD, params, { ...WALLET, walletKey: key() });
    await expect(assertSendPassword(params, { ...WALLET, ticket })).resolves.toBeUndefined();
    await expect(assertSendPassword(params, { ...WALLET, ticket })).rejects.toThrow();
  });

  it("takes no ticket for less than it moves, of another wallet, for what could be counted, or too old", async () => {
    const proved = (what = params, now) => proveSendPassword(PASSWORD, what, { ...WALLET, walletKey: key(), now });
    await expect(assertSendPassword(transfer(7n * DUSK), { ...WALLET, ticket: await proved() })).rejects.toThrow();
    await expect(assertSendPassword(params, { walletId: "another", nodeUrl: NODE, ticket: await proved() })).rejects.toThrow();
    const call = { kind: "contract_call", contractId: TOKEN, fnName: "transfer", amount: "0", deposit: "0", gas: PUBLIC_GAS };
    await expect(assertSendPassword(call, { ...WALLET, ticket: await proved() })).rejects.toThrow();
    const ticket = await proved(params, 1_000);
    await expect(assertSendPassword(params, { ...WALLET, ticket, now: 1_000 + 2 * 60_000 })).rejects.toThrow();
    // Below the amount, none's needed.
    await expect(assertSendPassword(transfer(DUSK), { ...WALLET })).resolves.toBeUndefined();
  });
});
