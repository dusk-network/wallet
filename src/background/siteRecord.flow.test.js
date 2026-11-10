import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { approveOrigin, getPermissionForOrigin, setConnectionLasts } from "../shared/permissions.js";
import { setSettings } from "../shared/settings.js";
import { clearSiteRecords, noteSiteLasts, noteSiteRequest, noteSiteUse, SITE_ASKED_KEPT, SITES_KEPT, forgetSiteRecord } from "../shared/siteRecords.js";
import { STORAGE_KEYS } from "../shared/storage.js";
import { createVault } from "../shared/vault.js";
import { noteActiveWallet } from "../shared/wallets.js";
import { handleRpc } from "./rpc.js";
import { approvalShown, cancelPendingApprovals, pendingApprovals, resolvePendingDecision } from "./pending.js";

// The real RPC, queue, connections and records: only storage, windows and the
// engine are stand-ins, as a site's request meets them.
const mocks = vi.hoisted(() => ({ store: {}, status: {}, engineCall: vi.fn(), windowClosed: null }));
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
  getExtensionApi: () => ({
    windows: {
      onRemoved: {
        addListener(listener) {
          mocks.windowClosed = listener;
        },
      },
    },
  }),
  runtimeGetURL: (path) => `chrome-extension://test/${path}`,
  windowsCreate: async () => ({ id: 1 }),
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
const OTHER_SITE = "https://shop.example";
const DAY = 24 * 60 * 60_000;
// A public BIP39 test phrase, never a real wallet's.
const PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const ACCOUNT = "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const OTHER = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const CONTRACT = `0x${"ab".repeat(32)}`;
const GAS = { limit: "2000000", price: "1" };

const pay = (over = {}) => ({ kind: "transfer", privacy: "public", to: OTHER, amount: "7654321000", memo: "for the rent", gas: GAS, ...over });
const call = (fnName = "swap_tokens") => ({ kind: "contract_call", privacy: "public", contractId: CONTRACT, fnName, fnArgs: "0x1234", amount: "7654321000", gas: GAS });

// A site's request, its window open: what the site is told in the end, and what answers it there.
async function ask(method, params, origin = SITE) {
  const before = new Set(pendingApprovals.keys());
  const outcome = handleRpc(origin, { method, params }).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  await vi.waitFor(() => expect([...pendingApprovals.keys()].filter((rid) => !before.has(rid))).toHaveLength(1));
  const rid = [...pendingApprovals.keys()].find((id) => !before.has(id));
  return {
    outcome,
    rid,
    entry: pendingApprovals.get(rid),
    approve: (approvedParams = null) => resolvePendingDecision({ rid, decision: "approve", approvedParams }),
    reject: () => resolvePendingDecision({ rid, decision: "reject" }),
  };
}

const recordOf = (origin = SITE, wallet = ACCOUNT) => mocks.store[STORAGE_KEYS.SITE_RECORDS]?.[wallet]?.[origin];
const askedOf = async (origin) => {
  await vi.waitFor(() => expect(recordOf(origin)?.asked?.length ?? 0).toBeGreaterThan(0));
  return recordOf(origin).asked.map(({ what, method, answer }) => (method ? [what, method, answer] : [what, answer]));
};

beforeEach(async () => {
  mocks.store = {};
  mocks.engineCall.mockReset();
  mocks.engineCall.mockImplementation(async (method) => {
    if (method === "dusk_getCachedGasPrice") return { median: "1" };
    if (method === "dusk_sendTransaction") return { hash: `0x${"cd".repeat(32)}` };
    return true;
  });
  const wallet = await createVault(PHRASE, "the password here");
  mocks.status = { isUnlocked: true, accounts: [ACCOUNT], addresses: [], selectedAccountIndex: 0, walletKey: wallet.id, wallets: [{ key: wallet.id, walletId: ACCOUNT }] };
  await setSettings({ nodeUrl: NODE });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const [, entry] of pendingApprovals) clearTimeout(entry.timer);
  pendingApprovals.clear();
});

describe("what's kept of what a site asked", () => {
  it("keeps what each request was and how it was answered, newest first, and nothing in it", async () => {
    const connecting = await ask("dusk_requestProfiles");
    connecting.approve({ accountIndex: 0 });
    await connecting.outcome;
    expect(await askedOf()).toEqual([["connect", "approved"]]);

    const paying = await ask("dusk_sendTransaction", pay());
    paying.reject();
    await expect(paying.outcome).resolves.toMatchObject({ error: { code: 4001 } });

    const calling = await ask("dusk_sendTransaction", call());
    calling.approve();
    await calling.outcome;

    const message = "Sign this private note about bob";
    const signing = await ask("dusk_signMessage", { message: `0x${Buffer.from(message).toString("hex")}` });
    mocks.windowClosed(1);
    await signing.outcome;

    await vi.waitFor(() => expect(recordOf().asked).toHaveLength(4));
    expect(await askedOf()).toEqual([
      ["sign_message", "closed"],
      ["contract_call", "swap_tokens", "approved"],
      ["transfer", "rejected"],
      ["connect", "approved"],
    ]);
    for (const { at } of recordOf().asked) expect(at).toBeGreaterThan(0);
    // Not an amount, a recipient, a memo, a message, a contract or a hash.
    const kept = JSON.stringify(mocks.store[STORAGE_KEYS.SITE_RECORDS]);
    for (const secret of ["7654321", OTHER, "for the rent", message, Buffer.from(message).toString("hex"), "abab", "cdcd", "0x1234"]) expect(kept).not.toContain(secret);
  });

  // Astra's: a send that failed while the site's next request was approved marked that one, and left itself approved.
  it("notes a send that failed on its own approval, not on the site's next one approved while it ran", async () => {
    await approveOrigin(SITE, { accountIndex: 0, profileId: `account:0:${ACCOUNT}` }, ACCOUNT);
    const sending = Promise.withResolvers();
    mocks.engineCall.mockImplementation(async (method) => {
      if (method === "dusk_sendTransaction") return sending.promise;
      if (method === "dusk_signMessage") return "0xsigned";
      return method === "dusk_getCachedGasPrice" ? { median: "1" } : true;
    });
    const paying = await ask("dusk_sendTransaction", pay());
    paying.approve();
    // While it runs, the site asks to sign, and that's approved.
    const signing = await ask("dusk_signMessage", { message: "0x6869" });
    signing.approve();
    await vi.waitFor(() => expect(recordOf().asked[0]).toMatchObject({ what: "sign_message", answer: "approved" }));
    sending.reject(Object.assign(new Error("Failed to fetch"), { data: { sent: false } }));
    await paying.outcome;
    await signing.outcome;
    await vi.waitFor(() => expect(recordOf().asked.find((entry) => entry.what === "transfer")?.answer).toBe("failed"));
    expect(await askedOf()).toEqual([
      ["sign_message", "approved"],
      ["transfer", "failed"],
    ]);
  });

  it("notes an approved send that didn't go out as not sent, and one that may not have as not confirmed", async () => {
    await approveOrigin(SITE, { accountIndex: 0, profileId: `account:0:${ACCOUNT}` }, ACCOUNT);
    // Marek's, approved offline: the engine couldn't reach the node.
    mocks.engineCall.mockImplementation(async (method) => {
      if (method === "dusk_sendTransaction") throw Object.assign(new Error("Failed to fetch"), { data: { sent: false } });
      return method === "dusk_getCachedGasPrice" ? { median: "1" } : true;
    });
    const offline = await ask("dusk_sendTransaction", pay());
    offline.approve();
    await expect(offline.outcome).resolves.toMatchObject({ error: { message: "Failed to fetch" } });
    await vi.waitFor(() => expect(recordOf().asked[0]).toMatchObject({ what: "transfer", answer: "failed" }));

    mocks.engineCall.mockImplementation(async (method) => {
      if (method === "dusk_sendTransaction") throw Object.assign(new Error("Failed to fetch"), { data: { sent: "unknown", hash: "ef".repeat(32) } });
      return method === "dusk_getCachedGasPrice" ? { median: "1" } : true;
    });
    const unclear = await ask("dusk_sendTransaction", call());
    unclear.approve();
    await unclear.outcome;
    await vi.waitFor(() => expect(recordOf().asked[0]).toMatchObject({ what: "contract_call", answer: "unconfirmed" }));
    // The one before stays as it was said.
    expect(await askedOf()).toEqual([
      ["contract_call", "swap_tokens", "unconfirmed"],
      ["transfer", "failed"],
    ]);
  });

  it("keeps a bridge call by the words its approval led with, and its function's name besides", async () => {
    await approveOrigin(SITE, { accountIndex: 0, profileId: `account:0:${ACCOUNT}` }, ACCOUNT);
    const bridging = await ask("dusk_sendTransaction", call("depositETHToWithValue"));
    await approvalShown({ rid: bridging.rid, asked: "Bridge to DuskEVM" }, {});
    bridging.reject();
    await bridging.outcome;
    await vi.waitFor(() => expect(recordOf()?.asked).toHaveLength(1));
    expect(recordOf().asked[0]).toMatchObject({ what: "contract_call", method: "depositETHToWithValue", asked: "Bridge to DuskEVM", answer: "rejected" });
  });

  it("notes one not answered in time, and one the wallet ended", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const unanswered = await ask("dusk_requestProfiles");
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    await unanswered.outcome;
    vi.useRealTimers();
    expect(await askedOf()).toEqual([["connect", "expired"]]);

    await approveOrigin(SITE, { accountIndex: 0, profileId: `account:0:${ACCOUNT}` }, ACCOUNT);
    const ended = await ask("dusk_sendTransaction", pay());
    cancelPendingApprovals(SITE, "Site disconnected");
    await ended.outcome;
    await vi.waitFor(() => expect(recordOf().asked).toHaveLength(2));
    expect(recordOf().asked[0]).toMatchObject({ what: "transfer", answer: "cancelled" });
  });

  it("notes one asked while locked under the wallet the next unlock opens", async () => {
    mocks.status = { isUnlocked: false, accounts: [], addresses: [] };
    await noteActiveWallet("key", { walletId: ACCOUNT, accounts: [ACCOUNT] });
    const asked = await ask("dusk_requestProfiles");
    asked.reject();
    await asked.outcome;
    await vi.waitFor(() => expect(recordOf()?.asked).toHaveLength(1));
    expect(recordOf().asked[0]).toMatchObject({ what: "connect", answer: "rejected" });
  });

  it("keeps a site's newest requests within what's kept, and what it was allowed past its asking", async () => {
    await noteSiteRequest(ACCOUNT, SITE, { kind: "send_tx", params: pay(), answer: "approved", at: 1 });
    for (let at = 2; at <= SITE_ASKED_KEPT + 20; at += 1) {
      await noteSiteRequest(ACCOUNT, SITE, { kind: "connect", answer: "rejected", at });
    }
    const { asked } = recordOf();
    expect(asked).toHaveLength(SITE_ASKED_KEPT);
    expect(asked[0].at).toBe(SITE_ASKED_KEPT + 20);
    // The approval is the oldest, and it's still there.
    expect(asked.at(-1)).toMatchObject({ at: 1, what: "transfer", answer: "approved" });
    // With approvals alone, the oldest goes.
    for (let at = 100; at < 100 + SITE_ASKED_KEPT; at += 1) {
      await noteSiteRequest(ACCOUNT, SITE, { kind: "connect", answer: "approved", at });
    }
    expect(recordOf().asked.map((entry) => entry.at)).toEqual(Array.from({ length: SITE_ASKED_KEPT }, (_, i) => 99 + SITE_ASKED_KEPT - i));
  });

  it("keeps what was refused when a site asks and cancels at once, again and again", async () => {
    await approveOrigin(SITE, { accountIndex: 0, profileId: `account:0:${ACCOUNT}` }, ACCOUNT);
    for (const [method, params] of [["dusk_sendTransaction", pay()], ["dusk_sendTransaction", call()], ["dusk_signMessage", { message: "0x6869" }]]) {
      const asked = await ask(method, params);
      asked.reject();
      await asked.outcome;
    }
    // Marek's: connect, then disconnect before anyone answers, 32 times over.
    await handleRpc(SITE, { method: "dusk_disconnect" });
    for (let i = 0; i < 32; i += 1) {
      const asked = await ask("dusk_requestProfiles");
      await handleRpc(SITE, { method: "dusk_disconnect" });
      await asked.outcome;
    }
    await vi.waitFor(() => expect(recordOf().asked.filter((entry) => entry.answer === "cancelled").length).toBeGreaterThan(20));
    const asked = await askedOf();
    expect(asked).toHaveLength(SITE_ASKED_KEPT);
    expect(asked.filter((entry) => entry.at(-1) === "rejected")).toEqual([
      ["sign_message", "rejected"],
      ["contract_call", "swap_tokens", "rejected"],
      ["transfer", "rejected"],
    ]);

    // Nor can other sites that only cancelled push out the record of one that was refused.
    for (let at = 1; at <= SITES_KEPT + 5; at += 1) {
      await noteSiteRequest(ACCOUNT, `https://c${at}.example`, { kind: "connect", answer: "cancelled", at: Date.now() + at });
    }
    expect(recordOf()?.asked.filter((entry) => entry.answer === "rejected")).toHaveLength(3);
  });

  it("keeps a wallet's sites within what's kept: those never approved go first", async () => {
    await noteSiteRequest(ACCOUNT, "https://allowed.example", { kind: "connect", answer: "approved", at: 1 });
    for (let at = 2; at <= SITES_KEPT + 10; at += 1) {
      await noteSiteRequest(ACCOUNT, `https://s${at}.example`, { kind: "connect", answer: "rejected", at });
    }
    const sites = mocks.store[STORAGE_KEYS.SITE_RECORDS][ACCOUNT];
    expect(Object.keys(sites)).toHaveLength(SITES_KEPT);
    expect(sites["https://allowed.example"]).toBeTruthy();
    expect(sites[`https://s${SITES_KEPT + 10}.example`]).toBeTruthy();
    expect(sites["https://s2.example"]).toBeUndefined();
  });

  it("notes when a connected site last used its connection, at most once a minute, and only one that's connected", async () => {
    await noteSiteUse(ACCOUNT, OTHER_SITE, 1_000_000);
    expect(recordOf(OTHER_SITE)).toBeUndefined();

    await approveOrigin(OTHER_SITE, { accountIndex: 0, profileId: `account:0:${ACCOUNT}` }, ACCOUNT);
    await noteSiteUse(ACCOUNT, OTHER_SITE, 2_000_000);
    expect(recordOf(OTHER_SITE).lastUsedAt).toBe(2_000_000);
    await noteSiteUse(ACCOUNT, OTHER_SITE, 2_030_000);
    expect(recordOf(OTHER_SITE).lastUsedAt).toBe(2_000_000);
    await noteSiteUse(ACCOUNT, OTHER_SITE, 2_060_000);
    expect(recordOf(OTHER_SITE).lastUsedAt).toBe(2_060_000);
  });

  it("forgets one site, and leaves nothing a reset's clear came after", async () => {
    await noteSiteRequest(ACCOUNT, SITE, { kind: "connect", answer: "approved" });
    await noteSiteRequest(ACCOUNT, OTHER_SITE, { kind: "connect", answer: "approved" });
    await forgetSiteRecord(ACCOUNT, SITE);
    expect(recordOf(SITE)).toBeUndefined();
    expect(recordOf(OTHER_SITE)).toBeTruthy();
    await forgetSiteRecord(ACCOUNT, OTHER_SITE);
    expect(mocks.store[STORAGE_KEYS.SITE_RECORDS]).toBeUndefined();

    // A waiting request ended by the reset's lock, then the clear, at once.
    const waiting = await ask("dusk_requestProfiles");
    cancelPendingApprovals();
    const cleared = clearSiteRecords();
    await waiting.outcome;
    await cleared;
    expect(mocks.store[STORAGE_KEYS.SITE_RECORDS]).toBeUndefined();
  });
});

describe("a connection set to last a while", () => {
  const approved = async () => {
    const connecting = await ask("dusk_requestProfiles");
    expect(connecting.entry.params).toMatchObject({ stays: false });
    const asked = connecting.entry.params.lastsMs;
    connecting.approve({ accountIndex: 0 });
    await connecting.outcome;
    return asked;
  };
  const later = (ms) => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + ms);
  };

  it("lasts as new sites do, then the site's as if it never connected, and asks again", async () => {
    await setSettings({ newSiteLastsMs: 7 * DAY });
    await expect(approved()).resolves.toBe(7 * DAY);
    await expect(handleRpc(SITE, { method: "dusk_profiles" })).resolves.toHaveLength(1);

    later(7 * DAY - 60_000);
    await expect(handleRpc(SITE, { method: "dusk_profiles" })).resolves.toHaveLength(1);
    vi.restoreAllMocks();

    later(7 * DAY + 1_000);
    await expect(handleRpc(SITE, { method: "dusk_profiles" })).resolves.toEqual([]);
    await expect(handleRpc(SITE, { method: "dusk_sendTransaction", params: pay() })).rejects.toMatchObject({ code: 4100 });
    expect(pendingApprovals.size).toBe(0);
    // Connecting again is a new connection, from then.
    const end = Date.now();
    await expect(approved()).resolves.toBe(7 * DAY);
    const perm = await getPermissionForOrigin(SITE, ACCOUNT);
    expect(perm.expiresAt).toBe(end + 7 * DAY);
  });

  it("refuses what was waiting when its time came, and sends nothing", async () => {
    await setSettings({ newSiteLastsMs: DAY });
    await approved();
    const paying = await ask("dusk_sendTransaction", pay());
    later(DAY + 1_000);
    paying.approve();
    await expect(paying.outcome).resolves.toMatchObject({ error: { code: 4100 } });
    expect(mocks.engineCall.mock.calls.filter(([method]) => method === "dusk_sendTransaction")).toEqual([]);
  });

  it("goes by what's set for the site over what's set for new sites, on its next connection too", async () => {
    await setSettings({ newSiteLastsMs: 30 * DAY });
    await approved();
    await setConnectionLasts(SITE, ACCOUNT, DAY);
    await noteSiteLasts(ACCOUNT, SITE, DAY);
    later(DAY + 1_000);
    await expect(handleRpc(SITE, { method: "dusk_profiles" })).resolves.toEqual([]);
    await expect(approved()).resolves.toBe(DAY);
    vi.restoreAllMocks();
    // One set to last until it's disconnected stays so, whatever new sites do.
    await setConnectionLasts(SITE, ACCOUNT, 0);
    await noteSiteLasts(ACCOUNT, SITE, 0);
    expect((await getPermissionForOrigin(SITE, ACCOUNT)).expiresAt).toBeUndefined();
    const again = await ask("dusk_requestProfiles");
    expect(again.entry.params).toMatchObject({ lastsMs: 0, endsAt: 0 });
    again.reject();
    await again.outcome;
  });

  it("shows a site that's connected already what it's set to, and goes on as it was", async () => {
    await setSettings({ newSiteLastsMs: 7 * DAY });
    await approved();
    const { expiresAt, connectedAt } = await getPermissionForOrigin(SITE, ACCOUNT);
    later(DAY);
    const sharing = await ask("dusk_requestShieldedAddress", {});
    expect(sharing.entry.params).toMatchObject({ stays: true, endsAt: expiresAt });
    sharing.approve({ accountIndex: 0, shieldedReceiveAddress: true });
    await sharing.outcome;
    await expect(getPermissionForOrigin(SITE, ACCOUNT)).resolves.toMatchObject({ expiresAt, connectedAt, lastsMs: 7 * DAY });
  });
});

