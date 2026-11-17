// Where Send's draft is kept (ui/lib/sendDraft.js): in the app, on the phone
// itself (localStorage), which a restart keeps; in the extension, in the
// tab's session, as the request form open as its tab was left is. A reset forgets it, and so does removing the wallet it was
// typed for (walletReset.js): a wallet restored or added again never opens
// Send on a payment from before.

/** The key it's kept under, with the wallet, profile and node it's for (`owner`). */
export const SEND_DRAFT_KEY = "dusk_send_draft";

/** The key the request form, open as its tab was left, is kept under in the tab's session, as Send's is. */
export const REQUEST_DRAFT_KEY = "dusk_request_draft";

/**
 * Forget Send's draft, wherever this page keeps it: every wallet's, or only
 * one wallet's (`walletId`, its first public account), whose `owner` starts
 * with it. Never fails.
 * @param {string} [walletId]
 */
export function forgetSendDrafts(walletId = "") {
  for (const name of ["localStorage", "sessionStorage"]) {
    for (const key of [SEND_DRAFT_KEY, REQUEST_DRAFT_KEY]) {
      try {
        const store = globalThis[name];
        const kept = store?.getItem(key);
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
        store.removeItem(key);
      } catch {
        // No such store here, as in a service worker.
      }
    }
  }
}
