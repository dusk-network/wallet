import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./storage.js", () => {
  const items = {};
  return {
    STORAGE_KEYS: { NETWORK_STATUS: "dusk_network_status_v1", NODE_CHAINS: "dusk_node_chains_v1" },
    storage: {
      get: async (key) => ({ [key]: items[key] }),
      set: async (patch) => {
        Object.assign(items, patch);
      },
    },
  };
});

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

  it("keeps the chain ID a node gives, which names its network", async () => {
    const { knownChainId } = await import("./nodeNetwork.js");
    const custom = { ...ENDPOINTS, nodeUrl: "https://my-node.example:8443/rusk" };
    node.mockImplementation(async (url) =>
      new URL(url).pathname === "/on/node/info" ? new Response('{"chain_id":2,"version":"1.7.1"}') : new Response("{}")
    );
    expect(await knownChainId(custom.nodeUrl)).toBeNull();
    await checkAllEndpoints(custom);
    expect(await knownChainId("https://my-node.example:8443")).toBe(2);

    // A reply without one keeps what the node gave before.
    node.mockImplementation(async () => new Response("{}"));
    await checkAllEndpoints(custom);
    expect(await knownChainId(custom.nodeUrl)).toBe(2);
  });
});
