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

  it("says what the node said, and why nothing is signed when that contradicts the chain it's fixed to", async () => {
    const { getSettings, setSettings } = await import("./settings.js");
    const { statusChainRefusal } = await import("./networkStatus.js");
    const custom = { ...ENDPOINTS, nodeUrl: "https://my-node.example" };
    await setSettings({ nodeUrl: custom.nodeUrl, chainId: 2 });
    node.mockImplementation(async (url) =>
      new URL(url).pathname === "/on/node/info" ? new Response('{"chain_id":1}') : new Response("{}")
    );
    const status = await checkAllEndpoints(custom);
    // Kept as it was added; the check only reports it.
    expect((await getSettings()).chainId).toBe(2);
    expect(status).toMatchObject({ nodeUrl: custom.nodeUrl, nodeChainId: 1 });
    expect(statusChainRefusal(status, custom.nodeUrl, 2)).toBe(
      "my-node.example now says it's on Mainnet (chain 1), not Testnet (chain 2). The wallet won't sign on it, because a signature here could count on the other network."
    );
    // Agreeing, about another node, or not said: nothing to say.
    expect(statusChainRefusal(status, custom.nodeUrl, 1)).toBe("");
    expect(statusChainRefusal(status, "https://other.example", 2)).toBe("");
    expect(statusChainRefusal({ nodeUrl: custom.nodeUrl, nodeChainId: null }, custom.nodeUrl, 2)).toBe("");
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

describe("checkNode", () => {
  let checkNode;
  let getNetworkStatus;
  let node;

  beforeEach(async () => {
    vi.resetModules();
    for (const key of Object.keys(items)) delete items[key];
    node = vi.fn(async () => new Response('{"chain_id":2}', { status: 200 }));
    vi.stubGlobal("fetch", node);
    ({ checkNode, getNetworkStatus } = await import("./networkStatus.js"));
    const { setSettings } = await import("./settings.js");
    await setSettings({ nodeUrl: ENDPOINTS.nodeUrl, chainId: 2 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Lena's and Amélie's: a node that held every request open went unnoticed, the dot green.
  it("says a node that doesn't answer in time can't be reached, asking it alone, once at a time, and the prover and archiver as they were", async () => {
    const { setNetworkStatus } = await import("./networkStatus.js");
    await setNetworkStatus({ nodeStatus: "online", proverStatus: "online", archiverStatus: "offline", lastChecked: 1 });
    // It holds what it's asked until the ask gives up.
    node.mockImplementation((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("signal is aborted without reason")))));
    const asked = checkNode(ENDPOINTS.nodeUrl, { timeoutMs: 50 });
    const again = checkNode(ENDPOINTS.nodeUrl, { timeoutMs: 50 });
    // While it's asked: as it was, never "checking".
    await vi.waitFor(() => expect(node).toHaveBeenCalledTimes(1));
    expect((await getNetworkStatus()).nodeStatus).toBe("online");
    const [a, b] = await Promise.all([asked, again]);
    expect(node).toHaveBeenCalledTimes(1);
    expect(new URL(node.mock.calls[0][0]).pathname).toBe("/on/node/info");
    expect(a).toMatchObject({ nodeStatus: "offline", nodeUrl: ENDPOINTS.nodeUrl, proverStatus: "online", archiverStatus: "offline", lastChecked: 1 });
    expect(b).toEqual(a);

    // It answers again.
    node.mockImplementation(async () => new Response('{"chain_id":2}'));
    await expect(checkNode(ENDPOINTS.nodeUrl)).resolves.toMatchObject({ nodeStatus: "online", nodeError: null, nodeChainId: 2 });
  });

  it("keeps nothing of a node the wallet left while it was asked", async () => {
    const { setSettings } = await import("./settings.js");
    const { setNetworkStatus } = await import("./networkStatus.js");
    await setNetworkStatus({ nodeStatus: "online", nodeUrl: "https://nodes.dusk.network" });
    node.mockImplementation(async () => {
      await setSettings({ nodeUrl: "https://nodes.dusk.network", chainId: 1 });
      return new Response("", { status: 503 });
    });
    await checkNode(ENDPOINTS.nodeUrl);
    expect(await getNetworkStatus()).toMatchObject({ nodeStatus: "online", nodeUrl: "https://nodes.dusk.network" });
  });
});

describe("chainIdForChoice", () => {
  let node;

  beforeEach(() => {
    vi.resetModules();
    for (const key of Object.keys(items)) delete items[key];
    node = vi.fn(async () => new Response('{"chain_id":2}'));
    vi.stubGlobal("fetch", node);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fixes a new node's chain ID as it says it, and refuses a node added before that says another, unless it's accepted", async () => {
    const { chainIdForChoice } = await import("./networkStatus.js");
    const { setSettings } = await import("./settings.js");
    const url = "https://my-node.example";
    await expect(chainIdForChoice(url)).resolves.toBe(2);
    await setSettings({ nodeUrl: url, chainId: 2 });
    // The same again, or nothing said: as it was added.
    await expect(chainIdForChoice(url)).resolves.toBe(2);
    node.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(chainIdForChoice(url)).resolves.toBe(2);

    node.mockResolvedValue(new Response('{"chain_id":1}'));
    node.mockImplementation(async () => new Response('{"chain_id":1}'));
    await expect(chainIdForChoice(url)).rejects.toMatchObject({
      message: expect.stringContaining("my-node.example now says it's on Mainnet (chain 1), not Testnet (chain 2)"),
      data: { chainChanged: { pinned: 2, answered: 1, question: expect.stringContaining("Use it on Mainnet (chain 1) from now on?") } },
    });
    await expect(chainIdForChoice(url, { accept: 1 })).resolves.toBe(1);
    // Agreeing to one chain says nothing of another the node answers by then.
    await expect(chainIdForChoice(url, { accept: 3 })).rejects.toMatchObject({ data: { chainChanged: { answered: 1, pinned: 2 } } });
    // A network's own node is asked nothing.
    node.mockClear();
    await expect(chainIdForChoice("https://testnet.nodes.dusk.network")).resolves.toBe(2);
    expect(node).not.toHaveBeenCalled();
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
