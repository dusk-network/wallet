import { describe, expect, it, vi } from "vitest";

let onRemovedCb = null;
let onTabRemovedCb = null;
let onTabActivatedCb = null;
const windowsRemove = vi.fn(async () => {});
// The browser's: with windows (a desktop), or without (Firefox for Android).
const browserHas = vi.hoisted(() => ({ windows: true }));
const tabs = vi.hoisted(() => ({
  create: null,
  get: null,
  remove: null,
  update: null,
  send: null,
}));
const notes = vi.hoisted(() => []);
// The browser's session storage: it outlives the background's stops.
// `gate`, when set, runs before each write: to hold it, or to fail it.
const session = vi.hoisted(() => ({ items: {}, gate: null }));

vi.mock("../shared/siteRecords.js", () => ({
  noteSiteRequest: async (walletId, origin, request) => {
    notes.push({ origin, ...request });
  },
}));

vi.mock("../platform/extensionApi.js", () => {
  tabs.create = vi.fn(async () => ({ id: 77 }));
  // The approval's tab, in front unless a test says not.
  tabs.get = vi.fn(async (id) => ({ id, active: true }));
  tabs.remove = vi.fn(async () => {});
  tabs.update = vi.fn(async () => {});
  tabs.send = vi.fn(async () => {});
  return {
    getExtensionApi: () => ({
      ...(browserHas.windows
        ? {
            windows: {
              onRemoved: {
                addListener: (cb) => {
                  onRemovedCb = cb;
                },
              },
            },
          }
        : {}),
      tabs: {
        onRemoved: {
          addListener: (cb) => {
            onTabRemovedCb = cb;
          },
        },
        onActivated: {
          addListener: (cb) => {
            onTabActivatedCb = cb;
          },
        },
      },
    }),
    runtimeGetURL: (path) => `chrome-extension://test/${String(path ?? "")}`,
    windowsCreate: vi.fn(async () => ({ id: 999 })),
    windowsRemove,
    storageSessionGet: async (key) => ({ [key]: structuredClone(session.items[key]) }),
    storageSessionSet: async (items) => {
      if (session.gate) await session.gate(items);
      Object.assign(session.items, structuredClone(items));
    },
    tabsCreate: (...args) => tabs.create(...args),
    tabsGet: (...args) => tabs.get(...args),
    tabsSendMessage: (...args) => tabs.send(...args),
    tabsRemove: (...args) => tabs.remove(...args),
    tabsUpdate: (...args) => tabs.update(...args),
    // The tab the person is on: the site's.
    tabsQuery: async () => [{ id: 5 }],
  };
});

describe("pending approvals", () => {
  it("resolves approved params and rejects when the window is closed", async () => {
    vi.resetModules();

    const pending = await import("./pending.js");

    const ridSpy = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("rid-1");

    const promise = pending.requestUserApproval("connect", "https://example.com", {
      requestedAccounts: true,
    });

    expect(pending.getPending("rid-1")).toMatchObject({
      kind: "connect",
      origin: "https://example.com",
    });

    // Approve flow
    pending.resolvePendingDecision({
      rid: "rid-1",
      decision: "approve",
      approvedParams: { accountIndex: 2 },
    });

    await expect(promise).resolves.toEqual({ accountIndex: 2 });

    // Window-closed flow for a different request.
    ridSpy.mockReturnValue("rid-2");
    const promise2 = pending.requestUserApproval("send_tx", "https://example.com", { kind: "transfer" });

    // Allow requestUserApproval() to finish opening the window and recording windowId.
    await new Promise((r) => setTimeout(r, 0));

    expect(typeof onRemovedCb).toBe("function");
    onRemovedCb(999);

    await expect(promise2).rejects.toMatchObject({ code: 4001 });

    ridSpy.mockRestore();
  });

  it("rejects every pending approval when wallet state changes", async () => {
    vi.resetModules();
    const pending = await import("./pending.js");
    const ridSpy = vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("rid-a")
      .mockReturnValueOnce("rid-b");

    const first = pending.requestUserApproval("send_tx", "https://a.example", {});
    const second = pending.requestUserApproval("sign_message", "https://b.example", {});
    pending.cancelPendingApprovals(null, "Wallet reset");

    await expect(first).rejects.toMatchObject({ code: 4001, message: "Wallet reset" });
    await expect(second).rejects.toMatchObject({ code: 4001, message: "Wallet reset" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pending.pendingApprovals.size).toBe(0);
    expect(windowsRemove).toHaveBeenCalledWith(999);
    ridSpy.mockRestore();
  });

  it("keeps a request to one wallet: the one it was asked on, or the first its window shows; another ends it", async () => {
    vi.resetModules();
    const pending = await import("./pending.js");
    const ridSpy = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce("rid-w1").mockReturnValueOnce("rid-locked");

    const asked = pending.requestUserApproval("connect", "https://a.example", {}, { walletId: "w1" });
    expect(pending.bindPendingWallet("rid-w1", "w1")).toBe(true);
    expect(pending.bindPendingWallet("rid-w1", "w2")).toBe(false);
    await expect(asked).rejects.toMatchObject({ code: 4001, message: "Wallet changed while awaiting approval" });
    expect(pending.getPending("rid-w1")).toBeNull();

    // Asked while locked: still locked, nothing is shown; then the first wallet shown.
    const shown = { walletId: "" };
    const lockedAsk = pending.requestUserApproval("sign_message", "https://b.example", {}, shown);
    expect(pending.bindPendingWallet("rid-locked", "")).toBe(true);
    expect(pending.bindPendingWallet("rid-locked", "w2")).toBe(true);
    expect(shown.walletId).toBe("w2");
    expect(pending.bindPendingWallet("rid-locked", "w1")).toBe(false);
    await expect(lockedAsk).rejects.toMatchObject({ message: "Wallet changed while awaiting approval" });
    ridSpy.mockRestore();
  });

  it("ends only the requests for the wallets named, one not yet shown counting as the open wallet's", async () => {
    vi.resetModules();
    const pending = await import("./pending.js");
    const ridSpy = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce("rid-a").mockReturnValueOnce("rid-new");
    const onA = pending.requestUserApproval("send_tx", "https://shop.example", {}, { walletId: "wa" });
    const unshown = pending.requestUserApproval("connect", "https://other.example", {}, { walletId: "" });
    const ended = [];
    onA.catch(() => ended.push("a"));
    unshown.catch(() => ended.push("unshown"));

    pending.cancelPendingApprovals("https://shop.example", "Site disconnected", { wallets: ["wb"], open: "wa" });
    pending.cancelPendingApprovals(null, "Sites disconnected", { wallets: ["wb"], open: "wa" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([ended, pending.pendingApprovals.size]).toEqual([[], 2]);

    pending.cancelPendingApprovals(null, "Sites disconnected", { wallets: ["wa"], open: "wa" });
    await expect(onA).rejects.toMatchObject({ message: "Sites disconnected" });
    await expect(unshown).rejects.toMatchObject({ message: "Sites disconnected" });
    ridSpy.mockRestore();
  });

  it("bounds approvals per origin and supports targeted cancellation", async () => {
    vi.resetModules();
    const pending = await import("./pending.js");
    const ridSpy = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("rid-3");
    const first = pending.requestUserApproval("send_tx", "https://example.com", {});

    await expect(
      pending.requestUserApproval("sign_message", "https://example.com", {})
    ).rejects.toMatchObject({ code: 4001 });

    pending.cancelPendingApprovals("https://example.com", "Wallet locked");
    await expect(first).rejects.toMatchObject({ code: 4001, message: "Wallet locked" });
    ridSpy.mockRestore();
  });

  describe("where windows can't be made, as in Firefox for Android", () => {
    it("shows the request in a tab, and once it's answered closes it and brings the site's tab back", async () => {
      browserHas.windows = false;
      vi.resetModules();
      const pending = await import("./pending.js");
      const ridSpy = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("rid-tab");
      try {
        const answer = pending.requestUserApproval("connect", "https://site.example", {});
        await new Promise((r) => setTimeout(r, 0));
        expect(tabs.create).toHaveBeenCalledWith({ url: "chrome-extension://test/notification.html?rid=rid-tab", active: true });
        expect(pending.getPending("rid-tab")).toMatchObject({ tabId: 77 });
        pending.resolvePendingDecision({ rid: "rid-tab", decision: "approve", approvedParams: { accountIndex: 0 } });
        await expect(answer).resolves.toEqual({ accountIndex: 0 });
        await new Promise((r) => setTimeout(r, 0));
        expect(tabs.remove).toHaveBeenCalledWith(77);
        expect(tabs.update).toHaveBeenCalledWith(5, { active: true });

        // Its tab closed by the person: a refusal, as a closed window is.
        ridSpy.mockReturnValue("rid-closed");
        const closed = pending.requestUserApproval("sign_message", "https://site.example", {});
        await new Promise((r) => setTimeout(r, 0));
        onTabRemovedCb(77);
        await expect(closed).rejects.toMatchObject({ code: 4001 });
      } finally {
        ridSpy.mockRestore();
        browserHas.windows = true;
      }
    });

    // Marek's: switching to the site's tab ended it, as "User rejected".
    it("keeps a request waiting as the person switches tabs, its site's too, and puts the entry the phone's Back takes away under it", async () => {
      browserHas.windows = false;
      vi.resetModules();
      const pending = await import("./pending.js");
      tabs.remove.mockClear();
      tabs.update.mockClear();
      const ridSpy = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("rid-back");
      try {
        const answer = pending.requestUserApproval("send_tx", "https://site.example", {}, { walletId: "acct0" });
        await new Promise((r) => setTimeout(r, 0));
        onTabActivatedCb?.({ tabId: 9 });
        onTabActivatedCb?.({ tabId: 5 });
        expect(pending.getPending("rid-back")).toBeTruthy();
        expect(tabs.remove).not.toHaveBeenCalled();

        // Drawn in its tab: the wallet's entry under it, once; not from another tab.
        const url = "chrome-extension://test/notification.html?rid=rid-back";
        await expect(pending.approvalShown({ rid: "rid-back" }, { tab: { id: 12 }, url })).resolves.toBe(true);
        expect(tabs.update).not.toHaveBeenCalled();
        await pending.approvalShown({ rid: "rid-back" }, { tab: { id: 77 }, url });
        await pending.approvalShown({ rid: "rid-back" }, { tab: { id: 77 }, url: `${url}#back` });
        expect(tabs.update.mock.calls).toEqual([[77, { url: `${url}#back` }]]);
        await expect(pending.approvalShown({ rid: "gone" }, { tab: { id: 77 }, url })).resolves.toBe(false);

        // Back takes it away: the window rejects, and the site's tab comes back.
        pending.resolvePendingDecision({ rid: "rid-back", decision: "reject" });
        await expect(answer).rejects.toMatchObject({ code: 4001, message: "User rejected the request" });
        await new Promise((r) => setTimeout(r, 0));
        expect(tabs.remove).toHaveBeenCalledWith(77);
        expect(tabs.update).toHaveBeenLastCalledWith(5, { active: true });
      } finally {
        ridSpy.mockRestore();
        browserHas.windows = true;
      }
    });

    // Marek's: the record said "Contract call: depositETHToWithValue" where the approval said "Bridge to DuskEVM".
    it("keeps the words a bridge's call led with for its site's record, and nothing else a window says", async () => {
      vi.resetModules();
      const pending = await import("./pending.js");
      const ridSpy = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("rid-words");
      notes.length = 0;
      try {
        const bridged = pending.requestUserApproval("send_tx", "https://bridge.example", { kind: "contract_call", fnName: "depositETHToWithValue" }, { walletId: "acct0" });
        await new Promise((r) => setTimeout(r, 0));
        await pending.approvalShown({ rid: "rid-words", asked: "Bridge to DuskEVM" }, {});
        pending.resolvePendingDecision({ rid: "rid-words", decision: "reject" });
        await bridged.catch(() => {});
        ridSpy.mockReturnValue("rid-other");
        const paid = pending.requestUserApproval("send_tx", "https://shop.example", { kind: "transfer", amount: "7" }, { walletId: "acct0" });
        await new Promise((r) => setTimeout(r, 0));
        await pending.approvalShown({ rid: "rid-other", asked: "Pay 7 DUSK to alice" }, {});
        pending.resolvePendingDecision({ rid: "rid-other", decision: "reject" });
        await paid.catch(() => {});
        await vi.waitFor(() => expect(notes).toHaveLength(2));
        expect(notes.map(({ origin, asked }) => [origin, asked])).toEqual([
          ["https://bridge.example", "Bridge to DuskEVM"],
          ["https://shop.example", undefined],
        ]);
      } finally {
        ridSpy.mockRestore();
      }
    });

    it("leaves the person where they are when one they left unanswered ends: its tab goes, theirs stays in front", async () => {
      browserHas.windows = false;
      vi.resetModules();
      const pending = await import("./pending.js");
      tabs.remove.mockClear();
      tabs.update.mockClear();
      // They went to another page, or another site's approval.
      tabs.get.mockResolvedValueOnce({ id: 77, active: false });
      const answer = pending.requestUserApproval("sign_message", "https://site.example", {}, { walletId: "acct0" });
      await new Promise((r) => setTimeout(r, 0));
      pending.cancelPendingApprovals(null, "Network changed");
      await expect(answer).rejects.toMatchObject({ code: 4001 });
      await new Promise((r) => setTimeout(r, 0));
      expect(tabs.remove).toHaveBeenCalledWith(77);
      expect(tabs.update).not.toHaveBeenCalled();
      browserHas.windows = true;
    });

    it("tells the site the wallet couldn't show it, not that the person cancelled, and keeps that in the site's record", async () => {
      browserHas.windows = false;
      vi.resetModules();
      notes.length = 0;
      const pending = await import("./pending.js");
      tabs.create.mockRejectedValueOnce(new Error("No tabs here"));
      try {
        const answer = pending.requestUserApproval("connect", "https://site.example", {}, { walletId: "acct0" });
        await expect(answer).rejects.toMatchObject({ code: -32603, message: pending.NOT_SHOWN_TEXT });
        await new Promise((r) => setTimeout(r, 0));
        expect(notes).toEqual([{ origin: "https://site.example", kind: "connect", params: {}, answer: "not_shown", id: expect.any(String) }]);
        expect(pending.pendingApprovals.size).toBe(0);
      } finally {
        browserHas.windows = true;
      }
    });
  });

  describe("through a stop of the background, as Firefox for Android stops it while Firefox is away", () => {
    const SITE = "https://testnet.dusk.domains";
    const KEY = "7:0:req-9";
    // What it was asked for: the wallet, profile, network and site.
    const CONTEXT = { origin: SITE, walletId: "acct0", nodeUrl: "https://testnet.nodes.dusk.network", chainId: 2, profileId: "account:0:acct0", accountIndex: 0 };

    // One waiting in its tab, then the background gone, with what it held, and back.
    async function stoppedWhileWaiting(params = { amount: "1" }) {
      browserHas.windows = false;
      session.items = {};
      session.gate = null;
      vi.resetModules();
      const before = await import("./pending.js");
      vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce("rid-kept");
      before.requestUserApproval("send_tx", SITE, params, { walletId: "acct0" }, { key: KEY, context: CONTEXT }).catch(() => {});
      await new Promise((r) => setTimeout(r, 0));
      vi.resetModules();
      tabs.create.mockClear();
      tabs.remove.mockClear();
      return import("./pending.js");
    }

    it("takes the request up again as its site asks again, in the approval still open, whose Approve then works", async () => {
      try {
        const pending = await stoppedWhileWaiting();
        // Back, before its site asks again: kept, not lost.
        await expect(pending.keptApproval("rid-kept")).resolves.toMatchObject({ origin: SITE, tabId: 77 });
        await expect(pending.checkResume(KEY)).resolves.toBeUndefined();
        const answer = pending.requestUserApproval("send_tx", SITE, { amount: "1" }, { walletId: "acct0" }, { key: KEY, resume: true, context: CONTEXT });
        await new Promise((r) => setTimeout(r, 0));
        expect(tabs.create).not.toHaveBeenCalled();
        expect(pending.getPending("rid-kept")).toMatchObject({ origin: SITE, tabId: 77 });
        expect(await pending.resolvePendingDecision({ rid: "rid-kept", decision: "approve", approvedParams: { gas: null } })).toEqual({ ok: true });
        await expect(answer).resolves.toEqual({ gas: null });
        // Answered: nothing takes it up again, whatever came of it.
        await expect(pending.checkResume(KEY)).rejects.toMatchObject({ code: 4900, message: expect.stringContaining("Check its Activity") });
      } finally {
        browserHas.windows = true;
      }
    });

    it("tells its site to ask again, its tab behind the approval, until the request is taken up", async () => {
      try {
        const pending = await stoppedWhileWaiting();
        tabs.send.mockClear();
        await pending.askKeptAgain();
        expect(tabs.send).toHaveBeenCalledWith(7, { type: "DUSK_ASK_AGAIN", id: "req-9" }, { frameId: 0 });
        pending.requestUserApproval("send_tx", SITE, { amount: "1" }, { walletId: "acct0" }, { key: KEY, resume: true, context: CONTEXT });
        await new Promise((r) => setTimeout(r, 0));
        // Taken up: nothing more to ask.
        tabs.send.mockClear();
        await pending.askKeptAgain("rid-kept");
        expect(tabs.send).not.toHaveBeenCalled();
      } finally {
        browserHas.windows = true;
      }
    });

    it("tells its site the approval was closed, when it was closed while the background was stopped", async () => {
      try {
        const pending = await stoppedWhileWaiting();
        onTabRemovedCb(77);
        // As a closed approval does, never one nobody can answer.
        await expect(pending.checkResume(KEY)).rejects.toMatchObject({ code: 4001, message: "User closed the approval window" });
      } finally {
        browserHas.windows = true;
      }
    });

    it("keeps one kept through a stop waiting as the person goes back to the site's tab meanwhile", async () => {
      try {
        const pending = await stoppedWhileWaiting();
        onTabActivatedCb?.({ tabId: 5 });
        await expect(pending.checkResume(KEY)).resolves.toBeUndefined();
        expect(tabs.remove).not.toHaveBeenCalled();
      } finally {
        browserHas.windows = true;
      }
    });

    it.each([["wallet", { walletId: "acct1" }], ["profile", { profileId: "account:1:acct1", accountIndex: 1 }], ["network", { nodeUrl: "https://my-node.example" }], ["site", { origin: "https://other.example" }]])(
      "never takes it up for another %s than it was asked for, and ends it", async (_, changed) => {
        try {
          const pending = await stoppedWhileWaiting();
          const answer = pending.requestUserApproval("send_tx", SITE, { amount: "1" }, { walletId: "acct0" }, { key: KEY, resume: true, context: { ...CONTEXT, ...changed } });
          const outcome = await Promise.race([answer.catch((e) => e), new Promise((r) => setTimeout(() => r("taken up"), 20))]);
          expect(outcome).toMatchObject({ code: 4100, message: "Wallet changed while awaiting approval" });
          expect(pending.getPending("rid-kept")).toBeNull();
          expect(tabs.remove).toHaveBeenCalledWith(77);
          await expect(pending.checkResume(KEY)).rejects.toMatchObject({ code: 4100 });
        } finally {
          browserHas.windows = true;
        }
      }
    );

    it("ends one kept through a stop on a change of the wallet's state, and its site hears why as it asks again", async () => {
      try {
        const pending = await stoppedWhileWaiting();
        // Another site's change, or another wallet's, leaves it.
        pending.cancelPendingApprovals("https://other.example", "Site disconnected");
        pending.cancelPendingApprovals(null, "Site disconnected", { wallets: ["acct9"] });
        await expect(pending.checkResume(KEY)).resolves.toBeUndefined();
        pending.cancelPendingApprovals(null, "Network changed");
        await expect(pending.checkResume(KEY)).rejects.toMatchObject({ code: 4001, message: "Network changed" });
        expect(tabs.remove).toHaveBeenCalledWith(77);
      } finally {
        browserHas.windows = true;
      }
    });

    it("keeps a refusal made before its site asks again as final at once, and the site hears it then", async () => {
      try {
        const pending = await stoppedWhileWaiting();
        // An approval waits for the site; a refusal doesn't.
        tabs.send.mockClear();
        await expect(pending.decideKept("rid-kept", "approve")).resolves.toMatchObject({ ok: false, error: { code: "waking" } });
        await vi.waitFor(() => expect(tabs.send).toHaveBeenCalled());
        await expect(pending.decideKept("rid-kept", "reject")).resolves.toEqual({ ok: true });
        expect(tabs.remove).toHaveBeenCalledWith(77);
        const answer = pending.requestUserApproval("send_tx", SITE, { amount: "1" }, { walletId: "acct0" }, { key: KEY, resume: true, context: CONTEXT });
        await expect(answer).rejects.toMatchObject({ code: 4001, message: "User rejected the request" });
        expect(pending.pendingApprovals.size).toBe(0);
        // Given up on by its window instead: the site hears it may have gone.
        const again = await stoppedWhileWaiting();
        await expect(again.decideKept("rid-kept", "abandon")).resolves.toEqual({ ok: true });
        // Its window stays, to say so.
        expect(tabs.remove).not.toHaveBeenCalled();
        await expect(again.checkResume(KEY)).rejects.toMatchObject({ code: 4900, message: expect.stringContaining("Check its Activity") });
      } finally {
        browserHas.windows = true;
      }
    });

    it("lets nothing go before the approval is kept as answered: held, it waits; failed, nothing goes", async () => {
      try {
        const pending = await stoppedWhileWaiting();
        const answer = pending.requestUserApproval("send_tx", SITE, { amount: "1" }, { walletId: "acct0" }, { key: KEY, resume: true, context: CONTEXT });
        await new Promise((r) => setTimeout(r, 0));
        let release;
        session.gate = () => new Promise((r) => (release = r));
        const decided = pending.resolvePendingDecision({ rid: "rid-kept", decision: "approve", approvedParams: null });
        let released = false;
        answer.then(() => (released = true), () => {});
        await new Promise((r) => setTimeout(r, 10));
        // The write held, as a stop now would leave it: nothing let go.
        expect(released).toBe(false);
        session.gate = null;
        release();
        await expect(decided).resolves.toEqual({ ok: true });
        await expect(answer).resolves.toBeNull();
        // Back again after a stop: never taken up a second time.
        vi.resetModules();
        const after = await import("./pending.js");
        await expect(after.checkResume(KEY)).rejects.toMatchObject({ code: 4900 });

        // The write failing: the approval doesn't go through.
        const failing = await stoppedWhileWaiting();
        const second = failing.requestUserApproval("send_tx", SITE, { amount: "1" }, { walletId: "acct0" }, { key: KEY, resume: true, context: CONTEXT });
        await new Promise((r) => setTimeout(r, 0));
        session.gate = async () => {
          throw new Error("QuotaExceededError");
        };
        await expect(failing.resolvePendingDecision({ rid: "rid-kept", decision: "approve", approvedParams: null })).resolves.toMatchObject({ ok: false, error: { code: "ended", message: failing.NOT_NOTED_TEXT } });
        await expect(second).rejects.toMatchObject({ code: -32603, message: failing.NOT_NOTED_TEXT });
        // Its window stays, to say nothing went.
        await new Promise((r) => setTimeout(r, 0));
        expect(tabs.remove).not.toHaveBeenCalled();
      } finally {
        session.gate = null;
        browserHas.windows = true;
      }
    });

    it("takes up one asked while locked for the wallet its approval then unlocked", async () => {
      try {
        browserHas.windows = false;
        session.items = {};
        vi.resetModules();
        const before = await import("./pending.js");
        vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce("rid-locked");
        before.requestUserApproval("send_tx", SITE, { amount: "1" }, { walletId: "" }, { key: KEY, context: { ...CONTEXT, walletId: "" } }).catch(() => {});
        await new Promise((r) => setTimeout(r, 0));
        // Unlocked in its window, then the background stops.
        expect(before.bindPendingWallet("rid-locked", "acct0")).toBe(true);
        await new Promise((r) => setTimeout(r, 0));
        vi.resetModules();
        const pending = await import("./pending.js");
        pending.requestUserApproval("send_tx", SITE, { amount: "1" }, { walletId: "acct0" }, { key: KEY, resume: true, context: CONTEXT });
        await new Promise((r) => setTimeout(r, 0));
        expect(pending.getPending("rid-locked")).toMatchObject({ origin: SITE, tabId: 77 });
      } finally {
        browserHas.windows = true;
      }
    });

    it.each([
      ["its approval closed", () => onTabRemovedCb(77), "User closed the approval window"],
      ["the wallet's state changed", (pending) => pending.cancelPendingApprovals(null, "Network changed"), "Network changed"],
    ])("ends a request being taken up when %s while that was written", async (_, end, message) => {
      try {
        const pending = await stoppedWhileWaiting();
        let release;
        session.gate = () => new Promise((r) => (release = r));
        const answer = pending.requestUserApproval("send_tx", SITE, { amount: "1" }, { walletId: "acct0" }, { key: KEY, resume: true, context: CONTEXT });
        await vi.waitFor(() => expect(release).toBeTypeOf("function"));
        end(pending);
        session.gate = null;
        release();
        const outcome = await Promise.race([answer.catch((e) => e), new Promise((r) => setTimeout(() => r("still waiting"), 50))]);
        expect(outcome).toMatchObject({ code: 4001, message });
        expect(pending.pendingApprovals.size).toBe(0);
        await expect(pending.checkResume(KEY)).rejects.toMatchObject({ code: 4001, message });
      } finally {
        session.gate = null;
        browserHas.windows = true;
      }
    });

    it("leaves nothing waiting when taking a request up couldn't be written", async () => {
      try {
        const pending = await stoppedWhileWaiting();
        session.gate = async () => {
          throw new Error("QuotaExceededError");
        };
        const answer = pending.requestUserApproval("send_tx", SITE, { amount: "1" }, { walletId: "acct0" }, { key: KEY, resume: true, context: CONTEXT });
        await expect(answer).rejects.toThrow("QuotaExceededError");
        // No Approve left to answer nothing, and the site free to ask again.
        expect(pending.getPending("rid-kept")).toBeNull();
        expect(pending.pendingApprovals.size).toBe(0);
      } finally {
        session.gate = null;
        browserHas.windows = true;
      }
    });

    it("asks anew, closing the old approval, when what's asked changed meanwhile", async () => {
      try {
        const pending = await stoppedWhileWaiting({ amount: "1" });
        pending.requestUserApproval("send_tx", SITE, { amount: "2" }, { walletId: "acct0" }, { key: KEY, resume: true, context: CONTEXT });
        await new Promise((r) => setTimeout(r, 0));
        expect(tabs.remove).toHaveBeenCalledWith(77);
        expect(tabs.create).toHaveBeenCalledTimes(1);
        expect(pending.getPending("rid-kept")).toBeNull();
      } finally {
        browserHas.windows = true;
      }
    });
  });
});

