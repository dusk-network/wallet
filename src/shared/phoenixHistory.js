// A profile's shielded (Phoenix) history, from the notes the shielded sync
// already keeps. Phoenix is off on Mainnet and Testnet, so this history is
// final: it is worked out once and kept.
//
// Each note the profile owns is kept as the note tree's leaf (map_owned keeps
// whole NoteLeafs): its block height and position are in its bytes, and its
// value comes from the wallet's own keys. What a leaf doesn't say is which
// transaction made it, and whether that transaction also spent the
// profile's notes: a received transfer, or the change of one the profile
// sent. The blocks at the notes' heights do: every Phoenix transaction's
// `phoenix` event lists the nullifiers it spent and the notes it made, byte
// for byte as the leaves hold them. Phoenix transactions always make change
// for their sender, so the notes' heights hold every transaction that spent
// the profile's notes too.
//
// Asking a node for the blocks at those heights would tell it where the
// profile's transactions are, so each one hides among four other heights
// that hold Phoenix notes, from the whole note tree. The tree's heights are
// read off the stream the shielded sync downloads anyway when it starts from
// the first note, or else from one stream of it (9.5 MB on Mainnet, once).

import { archiveQuery } from "./activityHistory.js";
import { TX_KIND } from "./constants.js";

export const TRANSFER_CONTRACT = "0100000000000000000000000000000000000000000000000000000000000000";
const STAKE_CONTRACT = "0200000000000000000000000000000000000000000000000000000000000000";

/** A NoteLeaf in the note-tree stream: the note (728 bytes), then its block height. */
export const LEAF_BYTES = 736;
/** The note's position in the tree, inside the note. */
export const LEAF_POS_OFFSET = 648;
/** The block height the note entered the tree at. */
export const LEAF_HEIGHT_OFFSET = 728;
/** The note as a `phoenix` event carries the notes a transaction made. */
export const NOTE_BYTES = 728;
/** The part of a note a `convert`, `mint` or `withdraw` event to a shielded receiver carries. */
const RECEIVER_SLICE = [328, 392];
/** Other heights each of the profile's heights is asked for among. */
export const DECOYS_PER_HEIGHT = 4;
/** Heights one request asks for. */
export const HEIGHTS_PER_REQUEST = 15;

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * A leaf's position and block height.
 * @param {Uint8Array} leaf
 * @returns {{ pos: bigint, height: number }}
 */
export function leafInfo(leaf) {
  const view = new DataView(leaf.buffer, leaf.byteOffset, leaf.byteLength);
  return {
    pos: view.getBigUint64(LEAF_POS_OFFSET, true),
    height: Number(view.getBigUint64(LEAF_HEIGHT_OFFSET, true)),
  };
}

/**
 * A pass-through for the note-tree stream (`leaves_from_pos` from position 0)
 * that notes each leaf's height on the way, for the decoy heights. `stream()`
 * makes the transform; `heights(total)` gives the distinct heights of the
 * first `total` leaves once all of them passed in order, else null. It never
 * changes or stops the stream, whatever it reads.
 */
export function createLeafHeightTap() {
  let rest = new Uint8Array(0);
  let next = 0n;
  let broken = false;
  const heights = [];

  const take = (chunk) => {
    const bytes = rest.length ? concat(rest, chunk) : chunk;
    let at = 0;
    for (; at + LEAF_BYTES <= bytes.length; at += LEAF_BYTES) {
      const { pos, height } = leafInfo(bytes.subarray(at, at + LEAF_BYTES));
      if (pos !== next) throw new Error("Leaves out of order");
      next += 1n;
      heights.push(height);
    }
    rest = bytes.slice(at);
  };

  return {
    stream: () =>
      new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          if (broken) return;
          try {
            take(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
          } catch {
            broken = true;
          }
        },
      }),
    heights(total) {
      const n = Number(total);
      if (broken || !Number.isSafeInteger(n) || n <= 0 || heights.length < n) return null;
      return [...new Set(heights.slice(0, n))];
    },
  };
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * The note tree's heights from one stream of every leaf.
 * @param {object} network - a w3sper Network
 * @param {bigint} total - the tree's size (num_notes)
 */
export async function readNoteHeights(network, total) {
  const tap = createLeafHeightTap();
  const response = await network.contracts.transferContract.call.leaves_from_pos(new Uint8Array(8), {
    headers: { "Rusk-Feeder": "true" },
  });
  if (!response?.body) throw new Error("The node sent no note tree");
  const reader = response.body.pipeThrough(tap.stream()).getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
  return tap.heights(total);
}

function randomIndex(n, random) {
  // An unbiased index below n, from 32 random bits.
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  for (;;) {
    const r = random();
    if (r < limit) return r % n;
  }
}

const cryptoRandom = () => crypto.getRandomValues(new Uint32Array(1))[0];

/**
 * The heights to ask for: the profile's own, each among `perHeight` others
 * drawn from the note tree's, shuffled. `keep`: decoys an earlier build drew,
 * kept so asking again shows nothing new.
 * @param {number[]} pool - the note tree's distinct heights
 * @param {number[]} real - the profile's notes' heights
 * @returns {{ heights: number[], decoys: number[] }}
 */
export function pickHeights(pool, real, { perHeight = DECOYS_PER_HEIGHT, keep = [], random = cryptoRandom } = {}) {
  const own = new Set(real);
  const decoys = keep.filter((h) => !own.has(h));
  const taken = new Set(decoys);
  const free = pool.filter((h) => !own.has(h) && !taken.has(h));
  for (let want = own.size * perHeight - decoys.length; want > 0 && free.length; want--) {
    const i = randomIndex(free.length, random);
    decoys.push(free[i]);
    free[i] = free[free.length - 1];
    free.pop();
  }
  const heights = [...own, ...decoys];
  for (let i = heights.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1, random);
    [heights[i], heights[j]] = [heights[j], heights[i]];
  }
  return { heights, decoys };
}

/** One request's GraphQL: each height's contract events, block time and transactions' gas. */
export function blocksQuery(heights) {
  const fields = heights.map(
    (h) =>
      `e${h}: contractEvents(height: ${h}) { json } b${h}: block(height: ${h}) { header { timestamp } transactions { id err gasSpent tx { gasPrice } } }`
  );
  return `query { ${fields.join(" ")} }`;
}

/**
 * The blocks at `heights`, HEIGHTS_PER_REQUEST a request, in their order.
 * @returns {Promise<Map<number, { timestamp: number|null, events: object[], txs: Map<string, object> }>>}
 */
export async function fetchBlocks(url, heights) {
  const out = new Map();
  for (let i = 0; i < heights.length; i += HEIGHTS_PER_REQUEST) {
    const batch = heights.slice(i, i + HEIGHTS_PER_REQUEST);
    const data = await archiveQuery(url, blocksQuery(batch), { timeoutMs: 30_000 });
    for (const h of batch) {
      const block = data?.[`b${h}`];
      const seconds = Number(block?.header?.timestamp);
      out.set(h, {
        timestamp: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
        events: Array.isArray(data?.[`e${h}`]?.json) ? data[`e${h}`].json : [],
        txs: new Map((Array.isArray(block?.transactions) ? block.transactions : []).map((tx) => [String(tx?.id ?? "").toLowerCase(), tx])),
      });
    }
  }
  return out;
}

// Whether `needle` (hex) is in `hay` (hex) at a whole byte.
function hexHas(hay, needle) {
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    if (at % 2 === 0) return true;
  }
  return false;
}

const u64 = (value) => {
  try {
    return BigInt(String(value ?? "0"));
  } catch {
    return 0n;
  }
};

/**
 * The profile's shielded history: one entry per transaction that made or
 * spent its notes, newest first, in the shape of Activity's rows.
 *
 * A transaction that spent the profile's notes sent what they held less what
 * came back to it (change, the fee's refund) and the fee; one that only made
 * its notes is what it received. A note no event in its block names is left
 * out.
 *
 * @param {{
 *   notes: { nullifier: string, leaf: Uint8Array, value: bigint, spent: boolean }[],
 *   blocks: Map<number, { timestamp: number|null, events: object[], txs: Map<string, object> }>,
 * }} input - the profile's notes, unspent and spent, and the blocks at their heights
 * @returns {object[]}
 */
export function buildShieldedHistory({ notes, blocks }) {
  const txs = new Map();
  const tx = (origin, height) => {
    const key = String(origin).toLowerCase();
    if (!txs.has(key)) txs.set(key, { hash: key, height, spent: 0n, made: 0n, topics: new Set() });
    return txs.get(key);
  };
  const byHeight = new Map();
  for (const note of notes) {
    const { height } = leafInfo(note.leaf);
    if (!byHeight.has(height)) byHeight.set(height, []);
    byHeight.get(height).push(note);
  }
  const spentNotes = notes.filter((n) => n.spent).map((n) => ({ value: n.value, nullifier: String(n.nullifier).toLowerCase() }));

  for (const [height, own] of byHeight) {
    const block = blocks.get(height);
    if (!block) continue;
    const events = block.events.filter((e) => e && !e.reverted && typeof e.data === "string");
    const made = own.map((n) => ({
      value: n.value,
      whole: hex(n.leaf.subarray(0, NOTE_BYTES)),
      part: hex(n.leaf.subarray(...RECEIVER_SLICE)),
      matched: false,
    }));
    // What each transaction of this block did, by its events.
    for (const event of events) {
      const source = String(event.source ?? event.target ?? "").toLowerCase();
      const origin = String(event.origin ?? "");
      if (!origin) continue;
      const data = String(event.data).toLowerCase();
      if (source === STAKE_CONTRACT) {
        tx(origin, height).topics.add(`stake:${event.topic}`);
        continue;
      }
      if (source !== TRANSFER_CONTRACT) continue;
      const entry = tx(origin, height);
      entry.topics.add(event.topic);
      // A Phoenix transaction names the nullifiers it spent and the notes it
      // made (change and the fee's refund included); a contract or a public
      // account sending to a shielded receiver names part of the note.
      const phoenix = event.topic === "phoenix";
      if (phoenix) {
        for (const n of spentNotes) {
          if (hexHas(data, n.nullifier)) entry.spent += n.value;
        }
      }
      for (const n of made) {
        if (!n.matched && hexHas(data, phoenix ? n.whole : n.part)) {
          entry.made += n.value;
          n.matched = true;
        }
      }
    }
  }

  const entries = [];
  for (const t of txs.values()) {
    if (!t.spent && !t.made) continue;
    const block = blocks.get(t.height);
    const info = block?.txs.get(t.hash);
    const fee = t.spent > 0n && info ? u64(info.gasSpent) * u64(info.tx?.gasPrice) : 0n;
    const net = t.made - t.spent + fee;
    const kind = t.topics.has("stake:stake")
      ? TX_KIND.STAKE
      : t.topics.has("stake:unstake")
      ? TX_KIND.UNSTAKE
      : t.topics.has("stake:withdraw")
      ? TX_KIND.WITHDRAW_REWARD
      : t.topics.has("convert")
      ? t.spent > 0n
        ? TX_KIND.UNSHIELD
        : TX_KIND.SHIELD
      : t.topics.has("deposit")
      ? TX_KIND.CONTRACT_CALL
      : TX_KIND.TRANSFER;
    const direction = net > 0n ? "in" : net < 0n ? "out" : "self";
    const err = info?.err == null ? "" : typeof info.err === "string" ? info.err : JSON.stringify(info.err);
    entries.push({
      hash: t.hash,
      source: "shielded",
      privacy: "shielded",
      kind,
      direction,
      amount: direction === "self" ? undefined : (net < 0n ? -net : net).toString(),
      feePaid: t.spent > 0n && info ? fee.toString() : undefined,
      status: err ? "failed" : "executed",
      error: err || undefined,
      timestamp: block?.timestamp ?? undefined,
      blockHeight: t.height,
    });
  }
  return entries.sort((a, b) => b.blockHeight - a.blockHeight || (a.hash < b.hash ? -1 : 1));
}
