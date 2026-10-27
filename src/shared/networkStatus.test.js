import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./storage.js", () => {
  const items = {};
  return {
    STORAGE_KEYS: { NETWORK_STATUS: "dusk_network_status_v1" },
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
});
