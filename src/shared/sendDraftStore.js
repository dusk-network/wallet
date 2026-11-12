// Where Send's draft is kept (ui/lib/sendDraft.js): in the app, on the phone
// itself (localStorage), which a restart keeps; in the extension, in the
// tab's session. A reset forgets it, and so does removing the wallet it was
// typed for (walletReset.js): a wallet restored or added again never opens
// Send on a payment from before.

/** The key it's kept under, with the wallet, profile and node it's for (`owner`). */
export const SEND_DRAFT_KEY = "dusk_send_draft";

/**
 * Forget Send's draft, wherever this page keeps it: every wallet's, or only
 * one wallet's (`walletId`, its first public account), whose `owner` starts
 * with it. Never fails.
 * @param {string} [walletId]
 */
export function forgetSendDrafts(walletId = "") {
  for (const name of ["localStorage", "sessionStorage"]) {
    try {
      const store = globalThis[name];
      const kept = store?.getItem(SEND_DRAFT_KEY);
      if (!kept) continue;
      if (walletId) {
        let owner = "";
        try {
          owner = String(JSON.parse(kept)?.owner ?? "");
        } catch {
          // Unreadable: forgotten all the same.
        }
        if (owner && owner.split(" ")[0] !== walletId) continue;
      }
      store.removeItem(SEND_DRAFT_KEY);
    } catch {
      // No such store here, as in a service worker.
    }
  }
}
