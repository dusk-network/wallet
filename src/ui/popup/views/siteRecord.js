// A site's record in Settings' Connected sites: when it was last used, and what
// it asked for and how that was answered, newest first (shared/siteRecords.js).

import { safeText } from "../../../shared/safeText.js";
import { h } from "../../lib/dom.js";
import { dateText } from "../../lib/time.js";

const ASKED = Object.freeze({
  connect: "Connect",
  shielded_address: "Share your shielded address",
  switch_network: "Switch network",
  transfer: "Pay",
  shield: "Shield",
  unshield: "Unshield",
  stake: "Stake",
  unstake: "Unstake",
  withdraw_reward: "Withdraw rewards",
  contract_call: "Contract call",
  sign_message: "Sign a message",
  sign_auth: "Sign in",
  sign_typed_data: "Sign typed data",
  watch_token: "Add a token",
  watch_nft: "Import an NFT",
});

const ANSWERS = Object.freeze({
  approved: "Approved",
  // Approved, and its send failed: nothing went out, or it may not have.
  failed: "Approved, not sent",
  unconfirmed: "Approved, not confirmed",
  rejected: "Rejected",
  closed: "Window closed",
  expired: "Not answered in time",
  // Ended by a lock, a switch or the site, before anyone answered: not the person's own.
  cancelled: "Ended before an answer",
  // The wallet couldn't show it, so no one saw it.
  not_shown: "Couldn't be shown",
});

// The approval's own words where it said more than its kind ("Bridge to
// DuskEVM"), else "Contract call: approve", by its function's name as the site gave it.
const askedText = ({ what, method, asked }) => {
  if (typeof asked === "string" && asked) return safeText(asked).text;
  const kind = ASKED[what] ?? "Request";
  return method ? `${kind}: ${safeText(method).text}` : kind;
};

/**
 * "Last used Thu 5 Nov 2026, 15:40 CET", or null before it was.
 * @param {{ lastUsedAt?: number } | undefined} record
 */
export function siteLastUsedEl(record) {
  const at = Number(record?.lastUsedAt);
  return at > 0 ? h("span", { class: "settings-site__note", text: `Last used ${dateText(at)}` }) : null;
}

/**
 * A site's Details: how long it stays connected, when that can be set, and what
 * it asked. Null with neither.
 * @param {{ asked?: Array<{ at: number, what: string, method?: string, answer: string }> } | undefined} record
 * @param {string} host - the site's name, for its label
 * @param {{ lasts?: HTMLElement | null, open?: boolean, onToggle?: (open: boolean) => void }} [opts]
 * @returns {HTMLElement | null}
 */
export function siteDetailsEl(record, host, { lasts = null, open = false, onToggle } = {}) {
  const asked = Array.isArray(record?.asked) ? record.asked : [];
  if (!asked.length && !lasts) return null;
  const details = h("details", { class: "advanced settings-site__details", open }, [
    h("summary", { text: "Details", "aria-label": `Details of ${host}` }),
    h("div", { class: "advanced-body" }, [
      lasts,
      asked.length ? h("span", { class: "settings-site__note", text: "What it asked" }) : null,
      asked.length
        ? h(
            "ul",
            { class: "settings-site__list" },
            asked.map((entry) =>
              h("li", { class: "settings-site__ask" }, [
                h("span", { class: "settings-site__what", text: askedText(entry) }),
                h("span", { class: "settings-site__answer", text: ANSWERS[entry.answer] ?? "" }),
                h("span", { class: "settings-site__when", text: dateText(Number(entry.at)) }),
              ])
            )
          )
        : null,
    ]),
  ]);
  details.addEventListener("toggle", () => onToggle?.(details.open));
  return details;
}
