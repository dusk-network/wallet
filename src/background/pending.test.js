import { describe, expect, it, vi } from "vitest";

let onRemovedCb = null;

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
    windowsCreate: vi.fn(async () => ({ id: 999 })),
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
});
