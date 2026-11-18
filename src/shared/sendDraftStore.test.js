import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// Round 40's review: a Send kept as its popup closed lives on in the extension's session store, for the next popup. A
// reset, or removing its wallet, forgets it there too, as it does in the page's own stores.
describe("forgetSendDrafts", () => {
  it("forgets the draft the extension's session store keeps: every one, or one wallet's", async () => {
    const kept = new Map();
    vi.stubGlobal("browser", {
      runtime: { id: "dusk-wallet", sendMessage: () => {} },
      storage: {
        session: {
          get: async (key) => (kept.has(key) ? { [key]: kept.get(key) } : {}),
          remove: async (key) => void kept.delete(key),
        },
      },
    });
    vi.resetModules();
    const { SEND_DRAFT_KEY, forgetSendDrafts } = await import("./sendDraftStore.js");
    const draftOf = (walletId) => ({ owner: `${walletId} 0 https://testnet.nodes.dusk.network`, values: { to: "someone", amountDusk: "0.5", memo: "rent" }, open: true });
    kept.set(SEND_DRAFT_KEY, draftOf("kept0"));
    await forgetSendDrafts("gone0");
    expect(kept.get(SEND_DRAFT_KEY)).toEqual(draftOf("kept0"));
    kept.set(SEND_DRAFT_KEY, draftOf("gone0"));
    await forgetSendDrafts("gone0");
    expect(kept.has(SEND_DRAFT_KEY)).toBe(false);
    kept.set(SEND_DRAFT_KEY, draftOf("kept0"));
    await forgetSendDrafts();
    expect(kept.has(SEND_DRAFT_KEY)).toBe(false);
  });
});
