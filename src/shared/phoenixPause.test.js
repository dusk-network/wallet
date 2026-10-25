import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ERROR_CODES } from "./errors.js";
import {
  U64_MAX,
  fetchPhoenixPaused,
  getPhoenixPause,
  isFeatureActiveAt,
  isPhoenixPausedAt,
  nodeFeature,
  parseFeatureActivation,
  phoenixPausedError,
  phoenixPausedMessage,
  txNeedsPhoenix,
} from "./phoenixPause.js";

// /on/node/info as mainnet and testnet answered on 2026-10-25 (features only).
// Parsed from text so u64::MAX goes through JSON.parse the way it does live.
const MAINNET_INFO = JSON.parse(`{
  "chain_id": 1,
  "vm_config": { "features": {
    "DISABLE_3RD_PARTY": [[2710376, 2873420]],
    "DISABLE_PHOENIX": 4414095,
    "DISABLE_WASM64": [[2710376, 18446744073709551615]],
    "HARDFORK_BOREAS": 4414095
  } }
}`);
const TESTNET_INFO = JSON.parse(`{
  "chain_id": 2,
  "vm_config": { "features": {
    "DISABLE_3RD_PARTY": 18446744073709551615,
    "DISABLE_PHOENIX": 4000000
  } }
}`);

const infoWith = (features) => ({ vm_config: { features } });

describe("parseFeatureActivation", () => {
  it("reads an activation height", () => {
    expect(parseFeatureActivation(4414095)).toEqual({ height: 4414095n });
    expect(parseFeatureActivation("4414095")).toEqual({ height: 4414095n });
    expect(parseFeatureActivation(4414095n)).toEqual({ height: 4414095n });
  });

  it("reads height ranges", () => {
    expect(parseFeatureActivation([[2710376, 2873420]])).toEqual({ ranges: [[2710376n, 2873420n]] });
    expect(parseFeatureActivation([[1, 2], [5, 9]])).toEqual({ ranges: [[1n, 2n], [5n, 9n]] });
  });

  it("reads u64::MAX after JSON parsing rounds it", () => {
    const raw = JSON.parse("18446744073709551615");
    expect(Number.isSafeInteger(raw)).toBe(false);
    expect(parseFeatureActivation(raw)).toEqual({ height: U64_MAX });
    expect(parseFeatureActivation("18446744073709551615")).toEqual({ height: U64_MAX });
    expect(parseFeatureActivation(JSON.parse("[[2710376, 18446744073709551615]]"))).toEqual({
      ranges: [[2710376n, U64_MAX]],
    });
  });

  it("treats a missing or unreadable feature as no activation", () => {
    for (const raw of [undefined, null, -1, 1.5, "", "soon", true, {}, Number.NaN]) {
      expect(parseFeatureActivation(raw)).toBeNull();
    }
  });

  it("skips malformed ranges", () => {
    expect(parseFeatureActivation([[1], [2, "x"], "3-4", [5, 6, 7], [8, 9]])).toEqual({ ranges: [[8n, 9n]] });
  });
});

describe("isFeatureActiveAt", () => {
  it("is active from the activation height on", () => {
    const activation = parseFeatureActivation(100);
    expect(isFeatureActiveAt(activation, 99)).toBe(false);
    expect(isFeatureActiveAt(activation, 100)).toBe(true);
    expect(isFeatureActiveAt(activation, 101n)).toBe(true);
  });

  it("is never active at u64::MAX", () => {
    const activation = parseFeatureActivation(JSON.parse("18446744073709551615"));
    expect(isFeatureActiveAt(activation, 0)).toBe(false);
    expect(isFeatureActiveAt(activation, 5_589_794)).toBe(false);
    expect(isFeatureActiveAt(activation, U64_MAX)).toBe(false);
  });

  it("includes both ends of a range", () => {
    const activation = parseFeatureActivation([[100, 200]]);
    expect(isFeatureActiveAt(activation, 99)).toBe(false);
    expect(isFeatureActiveAt(activation, 100)).toBe(true);
    expect(isFeatureActiveAt(activation, 200)).toBe(true);
    expect(isFeatureActiveAt(activation, 201)).toBe(false);
  });

  it("keeps a range that ends at u64::MAX active", () => {
    const activation = parseFeatureActivation(JSON.parse("[[100, 18446744073709551615]]"));
    expect(isFeatureActiveAt(activation, 99)).toBe(false);
    expect(isFeatureActiveAt(activation, 100)).toBe(true);
    expect(isFeatureActiveAt(activation, 9_000_000_000)).toBe(true);
  });

  it("is inactive without an activation or a readable height", () => {
    expect(isFeatureActiveAt(null, 100)).toBe(false);
    expect(isFeatureActiveAt({ ranges: [] }, 100)).toBe(false);
    expect(isFeatureActiveAt(parseFeatureActivation(1), "tip")).toBe(false);
  });
});

describe("isPhoenixPausedAt", () => {
  it("checks the next block after the tip", () => {
    const info = infoWith({ DISABLE_PHOENIX: 100 });
    expect(isPhoenixPausedAt(info, 98)).toBe(false);
    expect(isPhoenixPausedAt(info, 99)).toBe(true);
  });

  it("checks the next block against ranges", () => {
    const info = infoWith({ DISABLE_PHOENIX: [[100, 200]] });
    expect(isPhoenixPausedAt(info, 98)).toBe(false);
    expect(isPhoenixPausedAt(info, 99)).toBe(true);
    expect(isPhoenixPausedAt(info, 199)).toBe(true);
    expect(isPhoenixPausedAt(info, 200)).toBe(false);
  });

  it("matches the feature name regardless of case", () => {
    expect(isPhoenixPausedAt(infoWith({ disable_phoenix: 10 }), 50)).toBe(true);
    expect(isPhoenixPausedAt(infoWith({ Disable_Phoenix: [[10, 60]] }), 50)).toBe(true);
    expect(nodeFeature(infoWith({ disable_phoenix: 10 }), "DISABLE_PHOENIX")).toBe(10);
  });

  it("is not paused when the feature is missing or never activates", () => {
    expect(isPhoenixPausedAt(infoWith({ HARDFORK_BOREAS: 10 }), 50)).toBe(false);
    expect(isPhoenixPausedAt(infoWith({ DISABLE_PHOENIX: JSON.parse("18446744073709551615") }), 50)).toBe(false);
    expect(isPhoenixPausedAt({}, 50)).toBe(false);
    expect(isPhoenixPausedAt(null, 50)).toBe(false);
  });

  it("reads mainnet and testnet as they are today", () => {
    expect(isPhoenixPausedAt(MAINNET_INFO, 5_589_793)).toBe(true);
    expect(isPhoenixPausedAt(MAINNET_INFO, 4_414_093)).toBe(false);
    expect(isPhoenixPausedAt(MAINNET_INFO, 4_414_094)).toBe(true);
    expect(isPhoenixPausedAt(TESTNET_INFO, 4_684_309)).toBe(true);
    expect(isPhoenixPausedAt(TESTNET_INFO, 3_999_998)).toBe(false);
  });
});

function makeLocalStorage() {
  const store = new Map();
  return {
    get length() {
      return store.size;
    },
    key: (i) => Array.from(store.keys())[i] ?? null,
    getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
    setItem: (k, v) => store.set(String(k), String(v)),
    removeItem: (k) => store.delete(String(k)),
    clear: () => store.clear(),
  };
}

// A bare node per origin, answering { info, tip }: /on/node/info, and the tip on its own GraphQL
// protocol (a raw query to /on/graphql/query, the answer unwrapped); nothing at /graphql.
// `down: true` fails every request, `tipDown: true` the tip.
function stubNodes(nodes) {
  const fetchMock = vi.fn(async (url, init) => {
    const { origin, pathname } = new URL(url);
    const node = nodes[origin];
    if (!node || node.down) throw new TypeError("Failed to fetch");
    if (pathname === "/on/node/info") return new Response(JSON.stringify(node.info));
    if (pathname === "/on/graphql/query" && String(init?.body).startsWith("query { block(height: -1)")) {
      if (node.tipDown) return new Response("", { status: 502 });
      return new Response(JSON.stringify({ block: { header: { height: node.tip } } }));
    }
    return new Response("", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const MAINNET = "https://nodes.dusk.network";
const TESTNET = "https://testnet.nodes.dusk.network";
const infoCalls = (fetchMock, origin) =>
  fetchMock.mock.calls.filter(([url]) => String(url) === `${origin}/on/node/info`).length;

describe("getPhoenixPause", () => {
  let prevLocalStorage;

  beforeEach(() => {
    prevLocalStorage = globalThis.localStorage;
    globalThis.localStorage = makeLocalStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevLocalStorage) globalThis.localStorage = prevLocalStorage;
    else delete globalThis.localStorage;
  });

  it("asks the node for its info, and for the tip on its own GraphQL protocol", async () => {
    const fetchMock = stubNodes({ [TESTNET]: { info: TESTNET_INFO, tip: 4_684_309 } });

    await expect(fetchPhoenixPaused(`${TESTNET}/some/path`)).resolves.toBe(true);

    const calls = fetchMock.mock.calls.map(([url, init]) => [String(url), init?.method]).sort();
    expect(calls).toEqual([
      [`${TESTNET}/on/graphql/query`, "POST"],
      [`${TESTNET}/on/node/info`, "POST"],
    ]);
    const [, tip] = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/on/graphql/query"));
    expect(tip.headers).toEqual({ "Content-Type": "text/plain" });
    expect(tip.body).toBe("query { block(height: -1) { header { height } } }");
  });

  it("caches the answer per network", async () => {
    const fetchMock = stubNodes({
      [MAINNET]: { info: MAINNET_INFO, tip: 5_589_793 },
      [TESTNET]: { info: infoWith({}), tip: 4_684_309 },
    });

    await expect(getPhoenixPause(MAINNET)).resolves.toMatchObject({ paused: true });
    await expect(getPhoenixPause(`${MAINNET}/`)).resolves.toMatchObject({ paused: true });
    await expect(getPhoenixPause(TESTNET)).resolves.toMatchObject({ paused: false });

    expect(infoCalls(fetchMock, MAINNET)).toBe(1);
    expect(infoCalls(fetchMock, TESTNET)).toBe(1);
  });

  it("asks again once the answer is older than maxAgeMs", async () => {
    const nodes = { [TESTNET]: { info: TESTNET_INFO, tip: 3_000_000 } };
    const fetchMock = stubNodes(nodes);

    await expect(getPhoenixPause(TESTNET)).resolves.toMatchObject({ paused: false });
    nodes[TESTNET].tip = 4_000_000;
    await expect(getPhoenixPause(TESTNET, { maxAgeMs: 0 })).resolves.toMatchObject({ paused: true });
    expect(infoCalls(fetchMock, TESTNET)).toBe(2);
  });

  it("keeps the last known value when the node can't answer", async () => {
    const nodes = { [TESTNET]: { info: TESTNET_INFO, tip: 4_684_309 } };
    stubNodes(nodes);

    await expect(getPhoenixPause(TESTNET)).resolves.toMatchObject({ paused: true });
    nodes[TESTNET].down = true;
    await expect(getPhoenixPause(TESTNET, { maxAgeMs: 0 })).resolves.toMatchObject({ paused: true });
  });

  it("counts a network as not paused while nothing is known", async () => {
    stubNodes({ [TESTNET]: { down: true } });

    await expect(getPhoenixPause(TESTNET)).resolves.toEqual({ paused: false, checkedAt: 0 });
    await expect(getPhoenixPause("not a url")).resolves.toEqual({ paused: false, checkedAt: 0 });
  });

  it("doesn't ask a failing node again within maxAgeMs", async () => {
    const fetchMock = stubNodes({ [TESTNET]: { down: true } });

    await getPhoenixPause(TESTNET);
    await getPhoenixPause(TESTNET);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/on/node/info"))).toHaveLength(1);
  });

  it("doesn't need the tip height when the feature is missing", async () => {
    stubNodes({ [TESTNET]: { info: infoWith({ HARDFORK_BOREAS: 1 }), tipDown: true } });

    await expect(getPhoenixPause(TESTNET)).resolves.toMatchObject({ paused: false });
    expect((await getPhoenixPause(TESTNET)).checkedAt).toBeGreaterThan(0);
  });

  it("keeps the last known value when the tip height is unavailable", async () => {
    const nodes = { [TESTNET]: { info: TESTNET_INFO, tip: 4_684_309 } };
    stubNodes(nodes);

    await expect(getPhoenixPause(TESTNET)).resolves.toMatchObject({ paused: true });
    nodes[TESTNET].tipDown = true;
    await expect(getPhoenixPause(TESTNET, { maxAgeMs: 0 })).resolves.toMatchObject({ paused: true });
  });

  it("shares one request between concurrent callers", async () => {
    const fetchMock = stubNodes({ [TESTNET]: { info: TESTNET_INFO, tip: 4_684_309 } });

    const answers = await Promise.all([getPhoenixPause(TESTNET), getPhoenixPause(TESTNET)]);
    expect(answers.map((a) => a.paused)).toEqual([true, true]);
    expect(infoCalls(fetchMock, TESTNET)).toBe(1);
  });
});

describe("txNeedsPhoenix", () => {
  const TRANSFER_CONTRACT = `0x01${"00".repeat(31)}`;

  it.each([
    ["a shielded transfer", { kind: "transfer", privacy: "shielded", to: "addr", amount: "1" }],
    ["shield", { kind: "shield", amount: "1" }],
    ["unshield", { kind: "unshield", amount: "1" }],
    ["a stake paid from the shielded balance", { kind: "stake", amount: "1", payment: "address" }],
    ["an unstake paid to the shielded balance", { kind: "unstake", payment: "shielded" }],
    ["a reward claim to the shielded balance", { kind: "withdraw_reward", payment: "address" }],
    ["a shielded contract call", { kind: "contract_call", privacy: "shielded", contractId: `0x${"ab".repeat(32)}`, fnName: "transfer" }],
    ["a call to the transfer contract's convert", { kind: "contract_call", privacy: "public", contractId: TRANSFER_CONTRACT, fnName: "convert" }],
    ["convert with a bytes contract id", { kind: "contract_call", contractId: [1, ...new Array(31).fill(0)], fnName: "convert" }],
  ])("is true for %s", (_label, params) => {
    expect(txNeedsPhoenix(params)).toBe(true);
  });

  it.each([
    ["a public transfer", { kind: "transfer", privacy: "public", to: "acct", amount: "1" }],
    ["a public stake", { kind: "stake", amount: "1", payment: "account" }],
    ["a public unstake", { kind: "unstake" }],
    ["a public claim", { kind: "withdraw_reward", payment: "account" }],
    ["a public contract call", { kind: "contract_call", privacy: "public", contractId: `0x${"ab".repeat(32)}`, fnName: "convert" }],
    ["another transfer contract function", { kind: "contract_call", privacy: "public", contractId: TRANSFER_CONTRACT, fnName: "deposit" }],
    ["no params", undefined],
  ])("is false for %s", (_label, params) => {
    expect(txNeedsPhoenix(params)).toBe(false);
  });
});

describe("phoenixPausedMessage", () => {
  it("names the network", () => {
    expect(phoenixPausedMessage("Testnet")).toBe("Shielded transactions are paused on Testnet.");
    expect(phoenixPausedMessage("Mainnet")).toBe("Shielded transactions are paused on Mainnet.");
  });

  it("is a 4200 error for sites", () => {
    expect(phoenixPausedError("Mainnet")).toMatchObject({
      code: ERROR_CODES.UNSUPPORTED,
      message: "Shielded transactions are paused on Mainnet.",
    });
  });
});
