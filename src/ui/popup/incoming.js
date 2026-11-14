// Money coming in, told while the app on Android is away from the screen:
// Android's job looks at the open wallet's public accounts about every 15
// minutes (android/ArrivalJob.kt's Incoming), with no server, and says "You
// received 0.03 DUSK from …" for each payment in. What it's given is public
// data only: the accounts, named as Activity names the wallet's own profiles
// by default, the .dusk names Activity found for those it was paid by, the
// archive Activity reads, the notice's words and the network's name; never a
// key, the recovery words or a contact. Given while the wallet is open, kept
// while it's locked, and taken back once it's turned off in Settings or
// notices aren't allowed.

import { historyArchiverUrl } from "../../shared/activityHistory.js";
import { amountLocale } from "../../shared/amount.js";
import { networkTextOf } from "../../shared/nodeNetwork.js";
import { INCOMING_LOCKED_TITLE, incomingNoticeTitle } from "../../shared/phoneNotices.js";
import { appNoticesAllowed, watchAppIncoming } from "../../platform/notices.js";

// What was given last, and when: given again once it changes, and each
// minute, as notices may be allowed or not since in the phone's settings.
const GIVEN_AGAIN_MS = 60_000;
let given = null;
let givenAt = 0;

// The marks Activity writes an amount with.
function marks() {
  try {
    const parts = new Intl.NumberFormat(amountLocale()).formatToParts(1234567.5);
    return { decimal: parts.find((p) => p.type === "decimal")?.value ?? ".", group: parts.find((p) => p.type === "group")?.value ?? "," };
  } catch {
    return { decimal: ".", group: "," };
  }
}

/**
 * What Android's job is given for the open wallet, or null for nothing (it
 * stops looking): its public accounts, each profile by the name it has by
 * default; the public .dusk names of those it was paid by (`names`, as
 * Activity found them); the archive and network; the notice's words.
 * @param {object} ov - the overview of an open wallet
 * @param {{ names?: Map<string, string|null> }} [opts]
 */
export function incomingSetup(ov, { names } = {}) {
  if (ov?.incomingNotices === false) return null;
  const accounts = (ov?.accounts ?? []).map((account, i) => ({ account: String(account ?? ""), name: `Profile ${i + 1}` })).filter(({ account }) => account);
  const archiveUrl = historyArchiverUrl({ nodeUrl: ov?.nodeUrl, archiverUrl: ov?.archiverUrl });
  if (!accounts.length || !archiveUrl) return null;
  const known = [...(names ?? new Map())].filter(([account, name]) => account && typeof name === "string" && /\.dusk$/i.test(name)).slice(0, 100);
  return {
    accounts,
    names: Object.fromEntries(known),
    archiveUrl,
    network: networkTextOf(String(ov.nodeUrl ?? "")),
    title: incomingNoticeTitle({ hidden: ov.hideBalances === true }),
    // On a locked phone that hides what notices say.
    publicTitle: INCOMING_LOCKED_TITLE,
    wallet: accounts[0].account,
    ...marks(),
  };
}

/** Turned on or off in Settings: given again with the next draw, whatever was given a moment ago. */
export function watchIncomingAgain() {
  given = null;
}

/**
 * Gives Android's job what to look for, as the open wallet is drawn: once
 * it changed, else at most each minute. A locked wallet changes nothing.
 * @param {object} ov
 * @param {{ names?: Map<string, string|null>, send: (message: object) => Promise<any>, allowedNow?: () => Promise<boolean>, watch?: (setup: object|null) => Promise<void>, now?: number }} ctx
 */
export async function keepIncomingWatched(ov, { names, send, allowedNow = appNoticesAllowed, watch = watchAppIncoming, now = Date.now() }) {
  if (!ov?.isUnlocked || !ov.accounts?.length) return;
  const setup = incomingSetup(ov, { names });
  const key = JSON.stringify(setup);
  if (key === given && now - givenAt < GIVEN_AGAIN_MS) return;
  given = key;
  givenAt = now;
  if (!setup || !(await allowedNow().catch(() => false))) return watch(null);
  const token = (await send({ type: "DUSK_UI_INCOMING_TOKEN" }).catch(() => null))?.token ?? "";
  // Not given: asked again with the next draw.
  if (!token) {
    given = null;
    return;
  }
  await watch({ ...setup, token });
}
