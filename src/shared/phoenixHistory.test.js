import { afterEach, describe, expect, it, vi } from "vitest";

import recorded from "./fixtures/phoenix-testnet.json";
import {
  DECOYS_PER_HEIGHT,
  HEIGHTS_PER_REQUEST,
  LEAF_BYTES,
  blocksQuery,
  buildShieldedHistory,
  createLeafHeightTap,
  fetchBlocks,
  leafInfo,
  pickHeights,
  readNoteHeights,
} from "./phoenixHistory.js";

const bytes = (hex) => Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));
const leavesOf = (hex) => {
  const all = bytes(hex);
  return Array.from({ length: all.length / LEAF_BYTES }, (_, i) => all.slice(i * LEAF_BYTES, (i + 1) * LEAF_BYTES));
};
const FIRST = leavesOf(recorded.firstLeaves); // positions 0-5
const [L492, L493, L494, L495] = leavesOf(recorded.leaves492);
const DUSK = 1_000_000_000n;

// The blocks as fetchBlocks gives them.
function recordedBlocks() {
  const data = recorded.blocks;
  return new Map(
    [3602438, 3861643].map((h) => [
      h,
      {
        timestamp: data[`b${h}`].header.timestamp * 1000,
        events: data[`e${h}`].json,
        txs: new Map(data[`b${h}`].transactions.map((tx) => [tx.id, tx])),
      },
    ])
  );
}

// The unshield at 3602438 spent two notes: its phoenix event starts with their nullifiers.
const phoenixEvent = recorded.blocks.e3602438.json.find((e) => e.topic === "phoenix");
const NULLIFIERS = [phoenixEvent.data.slice(0, 64), phoenixEvent.data.slice(64, 128)];
const UNSHIELD = "3b0c1b4bcc517e91bf63525f232689452b6b51e46ccb1a5be4f8a0af73ddac11";
const SHIELD = recorded.blocks.e3861643.json.find((e) => e.topic === "convert").origin;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("leafInfo", () => {
  it("reads a note's position and height from its leaf", () => {
    expect([L492, L493, L494, L495].map(leafInfo)).toEqual([
      { pos: 492n, height: 3577762 },
      { pos: 493n, height: 3602438 },
      { pos: 494n, height: 3602438 },
      { pos: 495n, height: 3861643 },
    ]);
  });
});

describe("createLeafHeightTap", () => {
  const stream = (leaves, cut = 1000) => {
    const all = new Uint8Array(leaves.length * LEAF_BYTES);
    leaves.forEach((leaf, i) => all.set(leaf, i * LEAF_BYTES));
    // Chunks that don't line up with leaves.
    return new ReadableStream({
      start(controller) {
        for (let at = 0; at < all.length; at += cut) controller.enqueue(all.slice(at, at + cut));
        controller.close();
      },
    });
  };
  const drain = async (readable) => {
    const parts = [];
    const reader = readable.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) parts.push(...r.value);
    return Uint8Array.from(parts);
  };

  it("notes the tree's heights on the way and passes the stream on unchanged", async () => {
    const tap = createLeafHeightTap();
    const passed = await drain(stream(FIRST).pipeThrough(tap.stream()));
    expect(passed).toEqual(Uint8Array.from(FIRST.flatMap((leaf) => [...leaf])));
    expect(tap.heights(6)).toEqual([184423, 226951, 234329, 234369]);
    // Fewer leaves than the tree has: no heights.
    expect(tap.heights(7)).toBeNull();
  });

  it("gives nothing for a stream that doesn't start at the first note", async () => {
    const tap = createLeafHeightTap();
    await drain(stream([L492, L493]).pipeThrough(tap.stream()));
    expect(tap.heights(2)).toBeNull();
  });

  it("reads the tree's heights from one stream from position 0", async () => {
    const call = vi.fn(async () => new Response(stream(FIRST, 333)));
    const network = { contracts: { transferContract: { call: { leaves_from_pos: call } } } };
    await expect(readNoteHeights(network, 6n)).resolves.toEqual([184423, 226951, 234329, 234369]);
    expect(Array.from(call.mock.calls[0][0])).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(call.mock.calls[0][1]).toEqual({ headers: { "Rusk-Feeder": "true" } });
  });

  it("reads the leaves added since a position, for a tree that grew", async () => {
    const call = vi.fn(async () => new Response(stream([L492, L493, L494, L495], 333)));
    const network = { contracts: { transferContract: { call: { leaves_from_pos: call } } } };
    await expect(readNoteHeights(network, 496n, { from: 492n })).resolves.toEqual([3577762, 3602438, 3861643]);
    expect(Array.from(call.mock.calls[0][0])).toEqual([236, 1, 0, 0, 0, 0, 0, 0]);
    // A stream that doesn't start there gives nothing.
    await expect(readNoteHeights(network, 497n, { from: 491n })).resolves.toBeNull();
  });
});

describe("pickHeights", () => {
  // A fixed sequence of 32-bit numbers in place of crypto.getRandomValues.
  const seq = () => {
    let n = 7;
    return () => (n = (n * 1_103_515_245 + 12_345) % 2 ** 32);
  };

  it(`asks for each of the profile's heights among ${DECOYS_PER_HEIGHT} others from the note tree`, () => {
    const pool = Array.from({ length: 100 }, (_, i) => 1_000 + i);
    const real = [1_010, 1_050];
    const { heights, decoys } = pickHeights(pool, real, { random: seq() });
    expect(decoys).toHaveLength(real.length * DECOYS_PER_HEIGHT);
    expect(new Set(decoys).size).toBe(decoys.length);
    for (const d of decoys) expect(pool).toContain(d);
    expect(decoys).not.toContain(1_010);
    expect([...heights].sort()).toEqual([...real, ...decoys].sort());
    // Shuffled: the real heights don't lead.
    expect(heights.slice(0, 2)).not.toEqual(real);
  });

  it("asks among the same decoys again, so a second look shows nothing new", () => {
    const pool = Array.from({ length: 100 }, (_, i) => 1_000 + i);
    const first = pickHeights(pool, [1_010], { random: seq() });
    const again = pickHeights(pool, [1_010], { keep: first.decoys, random: () => 1 });
    expect(new Set(again.heights)).toEqual(new Set(first.heights));
  });

  it("takes what a small tree has", () => {
    const { heights } = pickHeights([5, 6, 7], [6], { random: seq() });
    expect([...heights].sort()).toEqual([5, 6, 7]);
  });
});

describe("fetchBlocks", () => {
  it(`asks for ${HEIGHTS_PER_REQUEST} heights a request, each with its events, time and gas`, async () => {
    const queries = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        queries.push(String(init.body));
        return { ok: true, status: 200, text: async () => JSON.stringify(recorded.blocks) };
      })
    );
    const heights = [3602438, 3861643, ...Array.from({ length: 18 }, (_, i) => 3_000_000 + i)];
    const blocks = await fetchBlocks("https://testnet.nodes.dusk.network", heights);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toBe(blocksQuery(heights.slice(0, HEIGHTS_PER_REQUEST)));
    expect(queries[0]).toContain(
      "e3602438: contractEvents(height: 3602438) { json } b3602438: block(height: 3602438) { header { timestamp } transactions { id err gasSpent tx { gasPrice } } }"
    );
    expect(blocks.get(3602438)).toMatchObject({ timestamp: 1_782_131_528_000 });
    expect(blocks.get(3602438).events.map((e) => e.topic)).toEqual(["convert", "phoenix", "reward"]);
    expect(blocks.get(3602438).txs.get(UNSHIELD)).toMatchObject({ gasSpent: 12_429_102 });
    expect(blocks.get(3_000_000)).toMatchObject({ timestamp: null, events: [] });
  });
});

describe("buildShieldedHistory", () => {
  // The profile's notes: two spent by the unshield, its two outputs, the
  // shield's note, and one whose block wasn't asked for.
  const notes = () => [
    { nullifier: NULLIFIERS[0], leaf: FIRST[0], value: 10n * DUSK, spent: true },
    { nullifier: NULLIFIERS[1], leaf: FIRST[1], value: DUSK / 2n, spent: true },
    { nullifier: "aa".repeat(32), leaf: L493, value: DUSK, spent: false },
    { nullifier: "bb".repeat(32), leaf: L494, value: 12_000_000n, spent: false },
    { nullifier: "cc".repeat(32), leaf: L495, value: 2n * DUSK, spent: false },
    { nullifier: "dd".repeat(32), leaf: L492, value: 3n * DUSK, spent: false },
  ];

  it("reads a transaction that spent the profile's notes as what left it, less change and fee", () => {
    const entries = buildShieldedHistory({ notes: notes(), blocks: recordedBlocks() });
    expect(entries).toEqual([
      {
        hash: SHIELD,
        source: "shielded",
        privacy: "shielded",
        kind: "shield",
        direction: "in",
        amount: "2000000000",
        feePaid: undefined,
        status: "executed",
        error: undefined,
        timestamp: 1_784_723_688_000,
        blockHeight: 3861643,
      },
      {
        hash: UNSHIELD,
        source: "shielded",
        privacy: "shielded",
        kind: "unshield",
        direction: "out",
        // 10.5 DUSK spent, 1.012 back as change, 0.012429102 the fee.
        amount: String(10_500_000_000n - 1_012_000_000n - 12_429_102n),
        feePaid: "12429102",
        status: "executed",
        error: undefined,
        timestamp: 1_782_131_528_000,
        blockHeight: 3602438,
      },
    ]);
  });

  it("reads a transaction that only made the profile's notes as received", () => {
    // The same unshield, seen by a profile that only got its outputs.
    const received = notes().filter((n) => !n.spent);
    const [, unshield] = buildShieldedHistory({ notes: received, blocks: recordedBlocks() });
    expect(unshield).toMatchObject({ hash: UNSHIELD, direction: "in", amount: "1012000000", feePaid: undefined });
  });

  it("finds nothing of the profile's in other heights' blocks, and leaves reverted events out", () => {
    const blocks = recordedBlocks();
    const decoyOnly = buildShieldedHistory({ notes: [{ nullifier: "ee".repeat(32), leaf: L492, value: DUSK, spent: false }], blocks });
    expect(decoyOnly).toEqual([]);
    for (const e of blocks.get(3602438).events) e.reverted = true;
    expect(buildShieldedHistory({ notes: notes(), blocks }).map((e) => e.hash)).toEqual([SHIELD]);
  });
});
