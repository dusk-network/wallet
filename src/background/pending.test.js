import { describe, expect, it, vi } from "vitest";

let onRemovedCb = null;
let onTabRemovedCb = null;
const windowsRemove = vi.fn(async () => {});
// The browser's: with windows (a desktop), or without (Firefox for Android).
const browserHas = vi.hoisted(() => ({ windows: true }));
const tabs = vi.hoisted(() => ({
  create: null,
  get: null,
  remove: null,
  update: null,
}));
const notes = vi.hoisted(() => []);

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
      },
    }),
    runtimeGetURL: (path) => `chrome-extension://test/${String(path ?? "")}`,
    windowsCreate: vi.fn(async () => ({ id: 999 })),
    windowsRemove,
    tabsCreate: (...args) => tabs.create(...args),
    tabsGet: (...args) => tabs.get(...args),
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
        expect(notes).toEqual([{ origin: "https://site.example", kind: "connect", params: {}, answer: "not_shown" }]);
        expect(pending.pendingApprovals.size).toBe(0);
      } finally {
        browserHas.windows = true;
      }
    });
  });
});
