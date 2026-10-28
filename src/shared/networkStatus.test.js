import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const items = vi.hoisted(() => ({}));
vi.mock("./storage.js", () => ({
  STORAGE_KEYS: { NETWORK_STATUS: "dusk_network_status_v1", SETTINGS: "dusk_settings_v1" },
  storage: {
    get: async (key) => ({ [key]: items[key] }),
    set: async (patch) => {
      Object.assign(items, patch);
    },
  },
}));

const ENDPOINTS = {
  nodeUrl: "https://testnet.nodes.dusk.network",
  proverUrl: "https://testnet.provers.dusk.network",
  archiverUrl: "https://testnet.nodes.dusk.network",
};

describe("checkAllEndpoints", () => {
  let checkAllEndpoints;
  let node;

  beforeEach(async () => {
    vi.resetModules();
    for (const key of Object.keys(items)) delete items[key];
    node = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", node);
    ({ checkAllEndpoints } = await import("./networkStatus.js"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("probes each endpoint once for the callers that ask while a check runs", async () => {
    const [a, b, c] = await Promise.all([
      checkAllEndpoints(ENDPOINTS),
      checkAllEndpoints(ENDPOINTS),
      checkAllEndpoints({ ...ENDPOINTS }),
    ]);

    expect(node).toHaveBeenCalledTimes(3);
    expect(node.mock.calls.map(([url]) => new URL(url).pathname).sort()).toEqual([
      "/on/graphql/query",
      "/on/node/info",
      "/on/prover/prove",
    ]);
    expect(a).toMatchObject({ nodeStatus: "online", proverStatus: "online", archiverStatus: "online" });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("checks again once the last check is over, and apart for other endpoints", async () => {
    await checkAllEndpoints(ENDPOINTS);
    await checkAllEndpoints(ENDPOINTS);

    expect(node).toHaveBeenCalledTimes(6);

    await Promise.all([
      checkAllEndpoints(ENDPOINTS),
      checkAllEndpoints({ ...ENDPOINTS, nodeUrl: "https://nodes.dusk.network" }),
    ]);

    expect(node).toHaveBeenCalledTimes(12);
  });

  it("keeps a chain ID it reads with the settings while they name that node, and asks again until it has one", async () => {
    const { getSettings, setSettings } = await import("./settings.js");
    const custom = { ...ENDPOINTS, nodeUrl: "https://my-node.example:8443" };
    // Chosen while the node couldn't say.
    await setSettings({ nodeUrl: custom.nodeUrl, chainId: null });
    node.mockImplementation(async () => new Response("", { status: 503 }));
    await checkAllEndpoints(custom);
    expect((await getSettings()).chainId).toBeNull();

    // Not given up: the next check asks again.
    node.mockImplementation(async (url) =>
      new URL(url).pathname === "/on/node/info" ? new Response('{"chain_id":2,"version":"1.7.1"}') : new Response("{}")
    );
    await checkAllEndpoints(custom);
    expect((await getSettings()).chainId).toBe(2);

    // A check that finishes after a switch changes nothing of the node switched to.
    await setSettings({ nodeUrl: "https://other.example", chainId: 1 });
    await checkAllEndpoints(custom);
    expect(await getSettings()).toMatchObject({ nodeUrl: "https://other.example", chainId: 1 });
  });

  it("asks a node for its info with the headers Rusk wants, so one that checks them answers", async () => {
    const { probeNode } = await import("./networkStatus.js");
    node.mockImplementation(async (_url, init) =>
      new Headers(init.headers).get("rusk-version") ? new Response('{"chain_id":2}') : new Response("Mismatched rusk version", { status: 400 })
    );
    await expect(probeNode("https://rusk.example.io")).resolves.toEqual({ ok: true, chainId: 2 });
    // One that still refuses is up, though it hasn't said its network.
    node.mockResolvedValueOnce(new Response("", { status: 424 }));
    await expect(probeNode("https://rusk.example.io")).resolves.toEqual({ ok: true, chainId: null });
  });
});

describe("readChainId", () => {
  let node;

  beforeEach(() => {
    vi.resetModules();
    node = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", node);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("knows a network's own node at once, reads any other's, once more after a failure, and gives null after two", async () => {
    const { readChainId } = await import("./networkStatus.js");
    expect(await readChainId("https://testnet.nodes.dusk.network")).toBe(2);
    expect(node).not.toHaveBeenCalled();

    node.mockResolvedValueOnce(new Response("", { status: 502 })).mockResolvedValueOnce(new Response('{"chain_id":1}'));
    expect(await readChainId("https://rusk.example.io", { waitMs: 0 })).toBe(1);
    expect(node).toHaveBeenCalledTimes(2);

    node.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await readChainId("https://rusk.example.io", { waitMs: 0 })).toBeNull();
    expect(node).toHaveBeenCalledTimes(4);
  });
});
