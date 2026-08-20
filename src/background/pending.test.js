import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let onRemovedCb = null;
const mocks = vi.hoisted(() => ({
  windowsCreate: vi.fn(async () => ({ id: 999 })),
  windowsRemove: vi.fn(async () => {}),
}));

vi.mock("../platform/extensionApi.js", () => {
  return {
    getExtensionApi: () => ({
      windows: {
        onRemoved: {
          addListener: (cb) => {
            onRemovedCb = cb;
          },
        },
      },
    }),
    runtimeGetURL: (path) => `chrome-extension://test/${String(path ?? "")}`,
    windowsCreate: mocks.windowsCreate,
    windowsRemove: mocks.windowsRemove,
  };
});

describe("pending approvals", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requires the exact request id for every decision", async () => {
    vi.resetModules();
    const pending = await import("./pending.js");
    const ridSpy = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue("bound-rid");
    const approval = pending.requestUserApproval(
      "sign_message",
      "https://example.com",
      { messageHash: "0x1234" }
    );
    const rejected = expect(approval).rejects.toMatchObject({ code: 4001 });

    expect(
      pending.resolvePendingDecision({ decision: "approve" })
    ).toEqual({ error: "Unknown request", ok: false });
    expect(
      pending.resolvePendingDecision({
        rid: "wrong-rid",
        decision: "approve",
      })
    ).toEqual({ error: "Unknown request", ok: false });
    expect(pending.getPending("bound-rid")).not.toBeNull();

    pending.resolvePendingDecision({
      rid: "bound-rid",
      decision: "reject",
    });
    await rejected;
    ridSpy.mockRestore();
  });

  it("rejects pending requests and closes their windows when locking", async () => {
    vi.resetModules();
    const pending = await import("./pending.js");
    const ridSpy = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue("lock-rid");
    const staleGeneration = pending.captureApprovalGeneration();
    const approval = pending.requestUserApproval(
      "send_tx",
      "https://example.com",
      { kind: "transfer" }
    );
    const cancelled = expect(approval).rejects.toMatchObject({ code: 4100 });
    await vi.waitFor(() => {
      expect(pending.getPending("lock-rid")?.windowId).toBe(999);
    });

    await pending.rejectAllPendingApprovals();
    await pending.rejectAllPendingApprovals();

    await cancelled;
    expect(pending.getPending("lock-rid")).toBeNull();
    expect(
      pending.resolvePendingDecision({
        rid: "lock-rid",
        decision: "approve",
      })
    ).toEqual({ error: "Unknown request", ok: false });
    expect(mocks.windowsRemove).toHaveBeenCalledWith(999);
    expect(mocks.windowsRemove).toHaveBeenCalledTimes(1);

    await expect(
      pending.requestUserApproval(
        "send_tx",
        "https://example.com",
        { kind: "transfer" },
        staleGeneration
      )
    ).rejects.toMatchObject({ code: 4100 });
    expect(ridSpy).toHaveBeenCalledTimes(1);
    expect(mocks.windowsCreate).toHaveBeenCalledTimes(1);

    ridSpy.mockReturnValue("post-lock-rid");
    const postLockApproval = pending.requestUserApproval(
      "send_tx",
      "https://example.com",
      { kind: "transfer" },
      pending.captureApprovalGeneration()
    );
    const rejected = expect(postLockApproval).rejects.toMatchObject({ code: 4001 });
    await vi.waitFor(() => {
      expect(pending.getPending("post-lock-rid")?.windowId).toBe(999);
    });

    pending.resolvePendingDecision({
      rid: "post-lock-rid",
      decision: "reject",
    });
    await rejected;
    expect(mocks.windowsCreate).toHaveBeenCalledTimes(2);
    ridSpy.mockRestore();
  });

  it("expires and closes approvals that are left unanswered", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.resetModules();
    const pending = await import("./pending.js");
    const ridSpy = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue("expiry-rid");
    const approval = pending.requestUserApproval(
      "sign_message",
      "https://example.com",
      { messageHash: "0x1234" }
    );
    const expired = expect(approval).rejects.toMatchObject({ code: 4001 });
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(pending.APPROVAL_TTL_MS);

    await expired;
    expect(pending.getPending("expiry-rid")).toBeNull();
    expect(mocks.windowsRemove).toHaveBeenCalledWith(999);
    ridSpy.mockRestore();
  });

  it("refuses stale approval even when the expiry timer was delayed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.resetModules();
    const pending = await import("./pending.js");
    const ridSpy = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue("stale-rid");
    const approval = pending.requestUserApproval(
      "send_tx",
      "https://example.com",
      { kind: "transfer" }
    );
    const expired = expect(approval).rejects.toMatchObject({ code: 4001 });
    await Promise.resolve();
    await Promise.resolve();
    vi.setSystemTime(Date.now() + pending.APPROVAL_TTL_MS);

    expect(
      pending.resolvePendingDecision({
        rid: "stale-rid",
        decision: "approve",
      })
    ).toEqual({ error: "Request expired", ok: false });

    await expired;
    expect(pending.getPending("stale-rid")).toBeNull();
    expect(mocks.windowsRemove).toHaveBeenCalledWith(999);
    ridSpy.mockRestore();
  });

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
});
