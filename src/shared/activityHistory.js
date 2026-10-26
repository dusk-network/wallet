// A public account's transaction history, from the archive node's
// `moonlightHistory`, synced by block height and kept on this device
// (activityStore.js).
//
// The archive answers ascending pages only: `moonlightHistory(sender: …)` and
// `(receiver: …)` list a range's entries oldest first, `maxCount` at a time.
// A sync covers the chain from the top down in windows, so the newest entries
// come first: the window under the last finalized block, then wider ones
// below it while they hold few entries, narrower ones where a page fills.
// The heights covered are kept, and a later refresh asks only for what is
// above them, with the last blocks under the finalized one read again: the
// archive indexes a block once it is final. An entry read again is the same
// entry, by its hash. Each request carries both directions as GraphQL
// aliases, and a run makes a bounded number of them; the next one carries on.
//
// Times, outcomes and fees come from one aliased `tx(hash:)` request per 50
// entries. The shielded history is phoenixHistory.js's.

import { fetchWithTimeout } from "./networkStatus.js";
import { detectPresetIdFromNodeUrl } from "./network.js";
import { TX_KIND } from "./constants.js";
import * as defaultStore from "./activityStore.js";

export const TRANSFER_CONTRACT = "0100000000000000000000000000000000000000000000000000000000000000";
export const STAKE_CONTRACT = "0200000000000000000000000000000000000000000000000000000000000000";

/** Entries one history query returns per direction. */
export const PAGE = 50;
/** The first window: about a day of 10-second blocks. */
export const FIRST_WINDOW = 8_640;
/** Blocks under the last finalized one that a sync counts as covered: the archive may not have indexed the newest yet. */
export const FINALITY_MARGIN = 10;
/** Transactions one details request looks up. */
export const DETAILS_BATCH = 50;
/** History requests one run makes, and details requests after them. */
export const RUN_REQUESTS = 8;
export const RUN_DETAIL_REQUESTS = 2;

/** How long a node that answered without the archive is left alone. */
export const NO_ARCHIVE_RETRY_MS = 60 * 60_000;

const REQUEST_TIMEOUT_MS = 8_000;
// What a node without the archive answers: its GraphQL has no history fields.
const NO_ARCHIVE = /Unknown field\W+(?:moonlightHistory|contractEvents)\b/i;
const MAX_WINDOW = 2 ** 40;
const MAX_U64 = (1n << 64n) - 1n;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const HASH = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const PRESETS = new Set(["mainnet", "testnet", "devnet", "local"]);

/**
 * The archive to read a network's history from: the configured archiver, or
 * the node when the archiver is on another known network (an install whose
 * settings kept Mainnet's archiver beside a Testnet node).
 * @param {{ nodeUrl?: string, archiverUrl?: string }} urls
 * @returns {string}
 */
export function historyArchiverUrl({ nodeUrl, archiverUrl } = {}) {
  const node = String(nodeUrl ?? "").trim();
  const archiver = String(archiverUrl ?? "").trim();
  if (!archiver) return node;
  const nodeNet = detectPresetIdFromNodeUrl(node);
  const archiverNet = detectPresetIdFromNodeUrl(archiver);
  return PRESETS.has(nodeNet) && PRESETS.has(archiverNet) && nodeNet !== archiverNet ? node : archiver;
}

/**
 * The network a history belongs to: Mainnet and Testnet by name, any other
 * node by its origin.
 * @param {string} nodeUrl
 */
export function activityNetworkKey(nodeUrl) {
  const preset = detectPresetIdFromNodeUrl(String(nodeUrl ?? ""));
  if (preset === "mainnet" || preset === "testnet") return preset;
  try {
    return new URL(String(nodeUrl)).origin;
  } catch {
    return String(nodeUrl ?? "");
  }
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

// Integers of 16 digits or more become strings, so no amount loses precision.
function losslessJson(text) {
  const parts = String(text).split(/("(?:\\.|[^"\\])*")/g);
  return JSON.parse(
    parts
      .map((part, index) =>
        index % 2 ? part : part.replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, (_, prefix, n) => `${prefix}"${n}"`)
      )
      .join("")
  );
}

/** A node that answered without the archive, or was left alone for having done so. */
export class NoArchiveError extends Error {
  constructor(url, message = `${url} has no archive`) {
    super(message);
    this.name = "NoArchiveError";
    this.url = url;
  }
}

/**
 * One GraphQL request to a node's `/on/graphql/query`. A node without the
 * archive's fields throws a NoArchiveError.
 * @param {string} baseUrl
 * @param {string} query
 * @returns {Promise<object>} the data
 */
export async function archiveQuery(baseUrl, query, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const res = await fetchWithTimeout(
    new URL("/on/graphql/query", baseUrl).toString(),
    { method: "POST", headers: { "Content-Type": "text/plain" }, body: query },
    timeoutMs
  );
  if (!res.ok) throw new Error(`Archive request failed (${res.status})`);
  const json = losslessJson(await res.text());
  if (Array.isArray(json?.errors) && json.errors.length) {
    const message = json.errors.map((e) => e?.message || String(e)).join("; ");
    throw NO_ARCHIVE.test(message) ? new NoArchiveError(baseUrl, message) : new Error(message);
  }
  return json?.data && typeof json.data === "object" ? json.data : json ?? {};
}

/**
 * Throw a NoArchiveError, without a request, for a node that answered
 * without the archive in the last hour.
 * @param {string} url
 */
export async function assertArchive(url, store = defaultStore, now = Date.now()) {
  const at = await store.getArchiveRefusal(url).catch(() => null);
  if (at !== null && now - at >= 0 && now - at < NO_ARCHIVE_RETRY_MS) throw new NoArchiveError(url);
}

/** Keep `url`'s refusal when `error` was one, for assertArchive. */
export async function rememberNoArchive(url, error, store = defaultStore) {
  if (error instanceof NoArchiveError && error.url === url) await store.putArchiveRefusal(url, Date.now()).catch(() => {});
}

const history = (alias, direction, account, { from, to, page }) => {
  const args = [`${direction}: ${JSON.stringify(account)}`, `fromBlock: ${from}`];
  if (to !== undefined) args.push(`toBlock: ${to}`);
  args.push(`maxCount: ${PAGE}`);
  if (page > 1) args.push(`pageCount: ${page}`);
  return `${alias}: moonlightHistory(${args.join(", ")}) { json }`;
};

/** The range `[from, to]` of both directions, `to` open when undefined: one request. */
function rangeQuery(account, { from, to, page = 1, head = false }) {
  const fields = [
    head ? "pair: lastBlockPair { json } genesis: block(height: 0) { header { hash } }" : "",
    history("out", "sender", account, { from, to, page }),
    history("in", "receiver", account, { from, to, page }),
  ];
  return `query { ${fields.filter(Boolean).join(" ")} }`;
}

const HEAD_QUERY = "query { pair: lastBlockPair { json } genesis: block(height: 0) { header { hash } } }";

function readHead(data) {
  const finalized = Number(data?.pair?.json?.last_finalized_block?.[0]);
  const tip = Number(data?.pair?.json?.last_block?.[0]);
  const genesis = String(data?.genesis?.header?.hash ?? "");
  if (!Number.isSafeInteger(finalized) || finalized < 0) throw new Error("Archive gave no finalized height");
  return { finalized, tip: Number.isSafeInteger(tip) ? tip : finalized, genesis };
}

const listOf = (field) => (Array.isArray(field?.json) ? field.json : []);

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

function u64(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return 0n;
  const n = BigInt(text);
  return n <= MAX_U64 ? n : 0n;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

// A memo as text when it is UTF-8 without control characters, else as 0x hex.
function memoText(hex) {
  const h = String(hex ?? "");
  if (!h || h.length % 2 || !/^[0-9a-f]+$/i.test(h)) return "";
  const bytes = Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
  try {
    const text = utf8.decode(bytes);
    // eslint-disable-next-line no-control-regex
    if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return text;
  } catch {
    // not text
  }
  return `0x${h.toLowerCase()}`;
}

const moonlightOf = (receiver) => (receiver && typeof receiver === "object" ? receiver.Moonlight ?? null : null);
const phoenixOf = (receiver) => (receiver && typeof receiver === "object" ? receiver.Phoenix ?? null : null);

/**
 * One archive entry as `account` sees it, from the transfer contract's
 * events; reverted events don't count. Null for an entry of another shape.
 *
 * `value` is what left or reached the account, fees aside; `direction` says
 * which, "self" for a transfer to itself. `payer` is whether the account
 * paid the fee.
 *
 * @param {string} account
 * @param {{ block_height: number, origin: string, events: object[] }} entry
 */
export function parseHistoryEntry(account, entry) {
  const hash = String(entry?.origin ?? "").toLowerCase();
  const blockHeight = Number(entry?.block_height);
  if (!HASH.test(hash) || !Number.isSafeInteger(blockHeight) || blockHeight < 0) return null;

  let inValue = 0n;
  let outValue = 0n;
  let selfValue = null;
  let payer = false;
  let memo = "";
  let kind = null;
  let counterparty = null;
  // The first counterparty each way, for kinds that don't name their own.
  let sentTo = null;
  let receivedFrom = null;
  const stakeTopics = new Set();

  for (const event of Array.isArray(entry?.events) ? entry.events : []) {
    if (!event || typeof event !== "object" || event.reverted === true) continue;
    const target = String(event.target ?? "").toLowerCase();
    const topic = String(event.topic ?? "");
    if (target === STAKE_CONTRACT) {
      stakeTopics.add(topic);
      continue;
    }
    const d = event.data;
    if (target !== TRANSFER_CONTRACT || !d || typeof d !== "object") continue;

    if (topic === "moonlight") {
      const value = u64(d.value);
      // No receiver means the sender's own account (dusk-core's
      // MoonlightTransaction::receiver), as for a contract call.
      const receiver = d.receiver ?? d.sender;
      const ours = d.sender === account || receiver === account;
      if (d.sender === account) payer = true;
      if (ours) memo = memoText(d.memo);
      if (d.sender === account && receiver === account) {
        selfValue = (selfValue ?? 0n) + value;
      } else if (d.sender === account) {
        outValue += value;
        sentTo ??= receiver;
      } else if (receiver === account) {
        inValue += value;
        receivedFrom ??= d.sender;
      }
      // Unspent gas refunded to the account when another one sent the tx.
      if (Array.isArray(d.refund_info) && d.refund_info[0] === account && d.sender !== account) {
        inValue += u64(d.refund_info[1]);
        receivedFrom ??= d.sender;
      }
    } else if (topic === "convert") {
      const value = u64(d.value);
      if (d.sender === account) {
        outValue += value;
        kind = TX_KIND.SHIELD;
        counterparty = phoenixOf(d.receiver);
      } else if (moonlightOf(d.receiver) === account) {
        inValue += value;
        kind = TX_KIND.UNSHIELD;
      }
    } else if (topic === "deposit") {
      if (d.sender !== account) continue;
      outValue += u64(d.value);
      const to = String(d.receiver ?? "").toLowerCase();
      kind ??= to === STAKE_CONTRACT ? TX_KIND.STAKE : TX_KIND.CONTRACT_CALL;
      counterparty ??= to || null;
    } else if (topic === "withdraw" || topic === "mint") {
      if (moonlightOf(d.receiver) !== account) continue;
      inValue += u64(d.value);
      const from = String(d.sender ?? "").toLowerCase();
      if (from === STAKE_CONTRACT) kind ??= topic === "mint" ? TX_KIND.WITHDRAW_REWARD : TX_KIND.UNSTAKE;
      receivedFrom ??= from || null;
    } else if (topic === "contract_to_account") {
      if (d.receiver !== account) continue;
      inValue += u64(d.value);
      receivedFrom ??= String(d.sender ?? "").toLowerCase() || null;
    }
  }

  // The stake contract's own events say which stake operation a withdraw was.
  if (kind === TX_KIND.UNSTAKE && stakeTopics.has("withdraw") && !stakeTopics.has("unstake")) {
    kind = TX_KIND.WITHDRAW_REWARD;
  }

  const net = inValue - outValue;
  let direction;
  let value;
  if (net > 0n) {
    direction = "in";
    value = net;
  } else if (net < 0n) {
    direction = "out";
    value = -net;
  } else if ((selfValue ?? 0n) > 0n && inValue === 0n) {
    direction = "self";
    value = selfValue;
  } else {
    // Nothing moved but the fee: a contract call without a deposit, or one
    // that failed.
    direction = payer ? "out" : "in";
    value = 0n;
  }

  if (!kind) {
    if (direction === "self" || sentTo || receivedFrom) kind = TX_KIND.TRANSFER;
    else kind = payer ? TX_KIND.CONTRACT_CALL : TX_KIND.TRANSFER;
  }
  if (!counterparty) {
    if (direction === "self") counterparty = account;
    else if (direction === "out") counterparty = sentTo;
    else counterparty = receivedFrom;
  }

  return { hash, blockHeight, direction, kind, counterparty: counterparty || null, value, memo, payer };
}

// ---------------------------------------------------------------------------
// Coverage: disjoint [lo, hi] ranges of heights whose entries are all kept,
// highest first.
// ---------------------------------------------------------------------------

/**
 * `covered` with `[lo, hi]` added, touching and overlapping ranges joined.
 * @param {number[][]} covered
 * @param {number} lo
 * @param {number} hi
 * @returns {number[][]}
 */
export function addCoverage(covered, lo, hi) {
  if (!(hi >= lo)) return covered.map((r) => [...r]);
  const ranges = [...covered.map((r) => [...r]), [lo, hi]].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of ranges) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out.reverse();
}

/**
 * The highest range of `[0, target]` that `covered` misses, or null.
 * @param {number[][]} covered - highest first
 * @param {number} target
 * @returns {[number, number] | null}
 */
export function topGap(covered, target) {
  let hi = target;
  for (const [a, b] of covered) {
    if (b < hi) return [b + 1, hi];
    hi = Math.min(hi, a - 1);
    if (hi < 0) return null;
  }
  return hi >= 0 ? [0, hi] : null;
}

/**
 * The lowest height Activity shows entries down to: the bottom of the range
 * that reaches `target`, or of the highest range while the top is still
 * being filled; null before anything is covered. Below it, newer entries
 * may be missing.
 */
export function shownDownTo(covered, target) {
  const top = covered.find(([a, b]) => a <= target && b >= target) ?? covered[0];
  return top ? top[0] : null;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

let warnedUnavailable = false;

/** Says once per page that the archive is unavailable. */
function warnUnavailable(error) {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  try {
    console.warn("Activity history is unavailable; showing this wallet's own transactions.", error?.message ?? error);
  } catch {
    // ignore
  }
}

function toStored(parsed) {
  return { ...parsed, value: parsed.value.toString() };
}

/**
 * One range of both directions, `to` open when undefined. With `head`, the
 * same request reads the last finalized block and the genesis hash.
 *
 * The range holds `entries`; it is complete from `from` up to `completeTo`
 * (inclusive), which is `to` unless a direction filled its page, and then
 * the height under that page's last entry, which may have more.
 */
async function readRange(url, account, { from, to, head = false }) {
  const data = await archiveQuery(url, rangeQuery(account, { from, to, head }));
  const out = listOf(data.out);
  const inn = listOf(data.in);
  const entries = [];
  for (const raw of [...out, ...inn]) {
    const parsed = parseHistoryEntry(account, raw);
    if (parsed) entries.push(parsed);
  }
  let completeTo = to;
  let fullPages = 0;
  for (const list of [out, inn]) {
    if (list.length < PAGE) continue;
    fullPages += 1;
    const last = Number(list[list.length - 1]?.block_height);
    const below = Number.isSafeInteger(last) ? last - 1 : from - 1;
    completeTo = completeTo === undefined ? below : Math.min(completeTo, below);
  }
  return { head: head ? readHead(data) : null, entries, completeTo, fullPages, count: Math.max(out.length, inn.length) };
}

/**
 * One block holding more than a page, a page at a time from `fromPage`, while
 * the budget lasts: `page` is where to carry on when it is not `complete`.
 */
async function readBlock(url, account, height, budget, fromPage) {
  const entries = [];
  let page = fromPage;
  for (; budget.left > 0; page++) {
    budget.left -= 1;
    const data = await archiveQuery(url, rangeQuery(account, { from: height, to: height, page }));
    const out = listOf(data.out);
    const inn = listOf(data.in);
    for (const raw of [...out, ...inn]) {
      const parsed = parseHistoryEntry(account, raw);
      if (parsed) entries.push(parsed);
    }
    if (out.length < PAGE && inn.length < PAGE) return { entries, complete: true, page: page + 1 };
  }
  return { entries, complete: false, page };
}

function nextWindow(window, count) {
  if (count < PAGE / 4) return Math.min(window * 8, MAX_WINDOW);
  if (count < PAGE / 2) return Math.min(window * 2, MAX_WINDOW);
  return window;
}

/**
 * Run a sync of `account`'s history: the newest heights first, then older
 * ones, at most `maxRequests` history requests and `maxDetailRequests`
 * details requests. Each step is kept as it lands, so a run that stops
 * anywhere is carried on by the next. `onStep` hears every kept step. A node
 * that answered without the archive is asked nothing for an hour.
 *
 * @param {{
 *   nodeUrl: string, archiverUrl?: string, account: string,
 *   maxRequests?: number, maxDetailRequests?: number,
 *   store?: typeof defaultStore, onStep?: (meta: object) => void,
 *   epoch?: number,
 * }} opts - `epoch`: the store's lifecycle epoch when the caller first saw
 *   the account (getActivityEpoch); after a wallet reset since, nothing is
 *   kept and the run rejects with StaleActivityError. Read at the start when
 *   not given.
 * @returns {Promise<{ meta: object, requests: number, added: number }>}
 */
export async function syncActivity(opts = {}) {
  const url = historyArchiverUrl(opts);
  const store = opts.store ?? defaultStore;
  if (url) await assertArchive(url, store);
  try {
    return await syncOnce(opts);
  } catch (error) {
    await rememberNoArchive(url, error, store);
    throw error;
  }
}

async function syncOnce({
  nodeUrl,
  archiverUrl,
  account,
  maxRequests = RUN_REQUESTS,
  maxDetailRequests = RUN_DETAIL_REQUESTS,
  store = defaultStore,
  onStep,
  epoch: seen,
} = {}) {
  if (!BASE58.test(String(account ?? ""))) throw new Error("A public account is required");
  const url = historyArchiverUrl({ nodeUrl, archiverUrl });
  if (!url) throw new Error("No archive configured");
  const ownerKey = store.activityOwnerKey(activityNetworkKey(nodeUrl), account);

  // A wallet reset during the run makes its writes fail (StaleActivityError).
  const epoch = seen ?? (await store.getActivityEpoch());
  let meta = await store.getActivityMeta(ownerKey);
  const budget = { left: Math.max(1, Math.floor(maxRequests)) };
  let detailsLeft = Math.max(0, Math.floor(maxDetailRequests));
  let added = 0;

  const commit = async (entries, patch) => {
    meta = await store.commitActivityStep(
      ownerKey,
      entries.map(toStored),
      (kept) => {
        // Two pages syncing at once: keep what the other one covered too.
        let covered = kept?.covered ?? [];
        for (const [lo, hi] of patch.cover ?? []) covered = addCoverage(covered, lo, hi);
        return {
          ...(kept ?? {}),
          ...patch.set,
          account,
          covered,
          updatedAt: Date.now(),
        };
      },
      epoch
    );
    added += entries.length;
    onStep?.(meta);
    // The first entries a run finds are the newest: their times and outcomes
    // come at once, before the run reads further down.
    if (entries.length && added === entries.length && detailsLeft > 0) {
      detailsLeft -= 1;
      await fillDetails({ url, ownerKey, store, epoch, maxRequests: 1, onStep: () => onStep?.(meta) });
    }
  };

  // The head: the last finalized block, and with it, when a range is kept,
  // everything above that range.
  const keptTop = meta?.covered?.[0]?.[1];
  budget.left -= 1;
  const first =
    keptTop === undefined
      ? { head: readHead(await archiveQuery(url, HEAD_QUERY)), entries: [] }
      : await readRange(url, account, { from: keptTop + 1, head: true });
  const { finalized, genesis } = first.head;
  const target = finalized - FINALITY_MARGIN;

  // Another chain under the same name (a reset devnet or local node): start over.
  if (meta?.genesis && genesis && meta.genesis !== genesis) {
    // Still the run's own: a reset meanwhile refuses both (StaleActivityError).
    await store.clearActivity(ownerKey, epoch);
    meta = null;
    return syncOnce({ nodeUrl, archiverUrl, account, maxRequests: budget.left + 1, maxDetailRequests, store, onStep, epoch });
  }

  const head = { genesis: genesis || meta?.genesis || "", finalized, target, headAt: Date.now() };
  if (keptTop === undefined) {
    await commit([], { set: { ...head, window: FIRST_WINDOW } });
  } else {
    const top = Math.min(first.completeTo ?? target, target);
    await commit(first.entries, { set: head, cover: top > keptTop ? [[keptTop + 1, top]] : [] });
  }

  // Fill what is missing from the top down.
  let window = Number(meta?.window) || FIRST_WINDOW;
  while (budget.left > 0) {
    const gap = topGap(meta.covered ?? [], target);
    if (!gap) break;
    const [a, b] = gap;
    // A block with more than a page at the top of what is missing: its pages
    // carry on where an earlier step left them.
    if (meta.crowded?.height === b) {
      const block = await readBlock(url, account, b, budget, meta.crowded.page);
      await commit(block.entries, block.complete ? { cover: [[b, b]], set: { crowded: null } } : { set: { crowded: { height: b, page: block.page } } });
      continue;
    }
    const lo = Math.max(a, b - window + 1);
    budget.left -= 1;
    const range = await readRange(url, account, { from: lo, to: b });
    if (!range.fullPages) {
      window = nextWindow(window, range.count);
      await commit(range.entries, { cover: [[lo, b]], set: { window } });
      continue;
    }
    // A page filled: what is under its last entry is complete; the rest of
    // the window gets a narrower one, sized to fit in a page.
    const completeTo = range.completeTo;
    if (completeTo >= lo) {
      const span = completeTo - lo + 2;
      window = Math.max(1, Math.floor(span / 2));
      await commit(range.entries, { cover: [[lo, completeTo]], set: { window } });
      continue;
    }
    // A page filled within the window's lowest block, which holds more than
    // a page: the heights above it come first, then its pages, from the
    // second, kept as they go.
    if (lo < b) {
      window = b - lo;
      await commit(range.entries, { set: { window, crowded: { height: lo, page: 2 } } });
      continue;
    }
    const block = await readBlock(url, account, lo, budget, 2);
    window = 1;
    await commit(
      [...range.entries, ...block.entries],
      block.complete ? { cover: [[lo, lo]], set: { window, crowded: null } } : { set: { window, crowded: { height: lo, page: block.page } } }
    );
  }

  await fillDetails({ url, ownerKey, store, epoch, maxRequests: detailsLeft, onStep: () => onStep?.(meta) });
  return { meta, requests: Math.max(1, Math.floor(maxRequests)) - budget.left, added };
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

/**
 * Times, outcomes, fees and calls of transactions, from one aliased request:
 * by hash, for those the node has.
 * @param {string} url
 * @param {string[]} hashes - at most DETAILS_BATCH
 * @returns {Promise<Map<string, object>>}
 */
export async function fetchTxDetails(url, hashes) {
  const list = hashes.filter((h) => HASH.test(h)).slice(0, DETAILS_BATCH);
  const out = new Map();
  if (!list.length) return out;
  const fields = list.map(
    (hash, i) =>
      `t${i}: tx(hash: "${hash}") { err gasSpent blockHash blockTimestamp tx { gasPrice gasLimit callData { contractId fnName } } }`
  );
  const data = await archiveQuery(url, `query { ${fields.join(" ")} }`);
  list.forEach((hash, i) => {
    const tx = data?.[`t${i}`];
    if (!tx || typeof tx !== "object") return;
    const gasSpent = u64(tx.gasSpent);
    const gasPrice = u64(tx.tx?.gasPrice);
    const seconds = Number(tx.blockTimestamp);
    const err = tx.err == null ? "" : typeof tx.err === "string" ? tx.err : JSON.stringify(tx.err);
    out.set(hash, {
      timestamp: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
      success: !err,
      error: err || undefined,
      gasSpent: gasSpent.toString(),
      gasPrice: gasPrice.toString(),
      gasLimit: u64(tx.tx?.gasLimit).toString(),
      fee: (gasSpent * gasPrice).toString(),
      blockHash: HASH.test(String(tx.blockHash ?? "")) ? String(tx.blockHash) : undefined,
      fnName: tx.tx?.callData?.fnName ? String(tx.tx.callData.fnName) : undefined,
      contractId: tx.tx?.callData?.contractId ? String(tx.tx.callData.contractId) : undefined,
      detailsAt: Date.now(),
    });
  });
  return out;
}

/** Details for the newest kept entries that have none, a batch per request. */
async function fillDetails({ url, ownerKey, store, epoch, maxRequests, onStep, entries }) {
  let requests = Math.max(0, Math.floor(maxRequests));
  if (!requests) return;
  const missing = (entries ?? (await store.listActivityEntries(ownerKey, { limit: DETAILS_BATCH * requests })))
    .filter((e) => !e.detailsAt)
    .map((e) => e.hash);
  for (let i = 0; i < missing.length && requests > 0; i += DETAILS_BATCH, requests--) {
    const details = await fetchTxDetails(url, missing.slice(i, i + DETAILS_BATCH));
    // A transaction the node doesn't have yet is looked up again next time.
    await store.patchActivityEntries(ownerKey, details, epoch);
    onStep?.();
  }
}

/**
 * Details for kept entries shown before a sync gave them any, as older ones
 * are: one request per 50.
 * @param {{ nodeUrl: string, archiverUrl?: string, account: string, entries: object[], store?: typeof defaultStore, epoch?: number }} opts
 *   `epoch` as for syncActivity
 */
export async function fillActivityDetails({ nodeUrl, archiverUrl, account, entries, store = defaultStore, epoch: seen }) {
  const url = historyArchiverUrl({ nodeUrl, archiverUrl });
  const ownerKey = store.activityOwnerKey(activityNetworkKey(nodeUrl), account);
  const missing = entries.filter((e) => !e.detailsAt);
  const epoch = seen ?? (await store.getActivityEpoch());
  await fillDetails({ url, ownerKey, store, epoch, entries: missing, maxRequests: Math.ceil(missing.length / DETAILS_BATCH) });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * A kept entry as Activity uses it: amounts as bigints.
 * @param {object} row
 */
export function activityEntry(row) {
  return {
    hash: row.hash,
    blockHeight: row.blockHeight,
    timestamp: row.timestamp ?? null,
    direction: row.direction,
    kind: row.kind,
    counterparty: row.counterparty ?? null,
    value: u64(row.value),
    memo: row.memo ?? "",
    success: row.success ?? null,
    error: row.error,
    // The fee is the sender's: shown only on what the account sent.
    fee: row.payer && row.fee != null ? u64(row.fee) : null,
    gasSpent: row.gasSpent,
    gasPrice: row.gasPrice,
    gasLimit: row.gasLimit,
    blockHash: row.blockHash,
    fnName: row.fnName,
    contractId: row.contractId,
    detailsAt: row.detailsAt,
  };
}

/**
 * The kept history of `account`, newest first, without asking the archive.
 * @param {{ nodeUrl: string, account: string, limit?: number, before?: number, store?: typeof defaultStore }} opts
 * @returns {Promise<{ entries: object[], meta: object|null, coveredTo: number|null, complete: boolean }>}
 *   `coveredTo`: the lowest height down to which the history has no gap; `complete`: no gap at all
 */
export async function readActivity({ nodeUrl, account, limit = 200, before, store = defaultStore } = {}) {
  const ownerKey = store.activityOwnerKey(activityNetworkKey(nodeUrl), account);
  const [meta, rows] = await Promise.all([
    store.getActivityMeta(ownerKey),
    store.listActivityEntries(ownerKey, { limit, before }),
  ]);
  const downTo = meta ? shownDownTo(meta.covered ?? [], meta.target) : null;
  // Only entries above the first gap: below it, newer ones may be missing.
  const entries = downTo === null ? [] : rows.filter((row) => row.blockHeight >= downTo).map(activityEntry);
  return { entries, meta, coveredTo: downTo, complete: downTo === 0 };
}

/**
 * The newest `limit` entries of `account`'s public history, newest first:
 * from this device, after a sync run asks the archive for what is new (and
 * carries on an older sync). When the archive is unreachable, the kept
 * entries, and a warning in the console once.
 *
 * @param {{ nodeUrl: string, archiverUrl?: string, account: string, limit?: number, before?: number }} opts
 * @returns {Promise<object[]>} `{ hash, blockHeight, timestamp, direction, counterparty, value, memo, success, … }`
 */
export async function fetchRecentActivity({ nodeUrl, archiverUrl, account, limit = 20, before, store = defaultStore } = {}) {
  try {
    await syncActivity({ nodeUrl: nodeUrl ?? archiverUrl, archiverUrl, account, store });
  } catch (error) {
    warnUnavailable(error);
  }
  try {
    return (await readActivity({ nodeUrl: nodeUrl ?? archiverUrl, account, limit, before, store })).entries;
  } catch {
    return [];
  }
}

export { warnUnavailable as noteActivityUnavailable };
