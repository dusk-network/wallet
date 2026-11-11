// The staking rates last measured from the chain, kept on this device for a
// day: native staking's and Sozu's, each with the days it was measured over. A
// screen shows them while a new measure is read, and keeps them where it can't
// be read, as while the node doesn't answer, rather than an estimate.

import { storage, STORAGE_KEYS } from "../../shared/storage.js";

/** How long a measure is kept to be shown: a day. */
export const KEPT_MEASURE_MS = 86_400_000;

// A measure's big numbers kept as text, and read back as they were.
const BIG = "$bigint";
const toText = (value) => JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? { [BIG]: String(v) } : v));
const fromText = (text) =>
  JSON.parse(text, (_key, v) => (v && typeof v === "object" && typeof v[BIG] === "string" && Object.keys(v).length === 1 ? BigInt(v[BIG]) : v));

const fresh = (kept, now) => typeof kept?.at === "number" && now - kept.at >= 0 && now - kept.at < KEPT_MEASURE_MS;

async function allKept() {
  try {
    const all = (await storage.get(STORAGE_KEYS.MEASURED_RATES))?.[STORAGE_KEYS.MEASURED_RATES];
    return all && typeof all === "object" ? all : {};
  } catch {
    return {};
  }
}

/**
 * The measure kept under `key` as it was read, while it's less than a day old;
 * else null.
 * @param {string} key
 * @param {{ now?: number }} [opts]
 */
export async function keptMeasure(key, { now = Date.now() } = {}) {
  const kept = (await allKept())[key];
  if (!fresh(kept, now) || typeof kept.text !== "string") return null;
  try {
    return fromText(kept.text);
  } catch {
    return null;
  }
}

// One write at a time, each over the last: two measures kept at once both stay.
let writing = Promise.resolve();

/**
 * Keeps a measure just read under `key`, with when; those over a day old go.
 * @param {string} key
 * @param {unknown} value
 * @param {{ now?: number }} [opts]
 */
export function keepMeasure(key, value, { now = Date.now() } = {}) {
  if (!value) return writing;
  writing = writing.then(async () => {
    const kept = Object.fromEntries(Object.entries(await allKept()).filter(([, each]) => fresh(each, now)));
    await storage.set({ [STORAGE_KEYS.MEASURED_RATES]: { ...kept, [key]: { at: now, text: toText(value) } } });
  }).catch(() => {});
  return writing;
}
