import { ETH_BRIDGE_FINALIZED_TOPIC } from "@dusk-network/app-core/bridge";
import { networks } from "@dusk-network/networks";
import { evmAddressOf } from "@dusk-network/networks/duskevm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeChain, topicOf, wordOf } from "../../shared/fixtures/chain.js";
import { installFakeDom, settle, visibleText } from "../testing/fakeDom.js";

vi.mock("../../wallet/bus.js", () => ({ send: vi.fn() }));
vi.mock("../../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: vi.fn(async () => null),
}));
// A look that found nothing is followed by another after 30 ms, not 5 seconds.
vi.mock("../../shared/bridgeArrival.js", async (importOriginal) => ({
  ...(await importOriginal()),
  arrivalCheckDelay: () => 30,
}));

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const TESTNET = "https://testnet.nodes.dusk.network";
const MAINNET = "https://nodes.dusk.network";
const TO = "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F";
const L2 = "0x029e2c6ebfe60452800c97eaa2ac36f40039812679c9cee414ea6a8b1877d61b";
const duskEvm = networks.testnet.duskEvm;

// A deposit of 0.5 DUSK to TO, gone through three minutes ago in Dusk block 4,697,290.
const deposit = (over = {}) => ({
  hash: "ee".repeat(32),
  kind: "contract_call",
  contractId: duskEvm.contracts.l1_standard_bridge.contractId,
  fnName: "depositETHToWithValue",
  amount: "0",
  deposit: "500000000",
  bridgeTo: TO,
  status: "executed",
  submittedAt: Date.now() - 190_000,
  executedAt: Date.now() - 180_000,
  // Its block's time and height, as the node gave them.
  finalizedAt: Date.now() - 185_000,
  blockHeight: "4697290",
  profileIndex: 0,
  nodeUrl: TESTNET,
  ...over,
});
// The deposit as the archive lists it in ACCOUNT's history.
const sent = {
  block_height: 4_697_290,
  events: [
    {
      data: { receiver: duskEvm.contracts.l1_standard_bridge.contractId, sender: ACCOUNT, value: "500000000" },
      reverted: false,
      target: networks.testnet.contracts.transfer,
      topic: "deposit",
    },
  ],
  origin: "ee".repeat(32),
};

const overview = (over = {}) => ({
  hasVault: true,
  isUnlocked: true,
  networkName: "Testnet",
  nodeUrl: TESTNET,
  chainId: 2,
  accounts: [ACCOUNT],
  accountCount: 1,
  selectedAccountIndex: 0,
  balance: { value: "0" },
  txs: [deposit()],
  ...over,
});

function memoryStorage() {
  const store = new Map();
  return {
    get length() {
      return store.size;
    },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => store.get(String(k)) ?? null,
    setItem: (k, v) => store.set(String(k), String(v)),
    removeItem: (k) => store.delete(String(k)),
    clear: () => store.clear(),
  };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await settle();
};

// The popups opened, each its own app.js: one that draws again after its
// test (its address book loading) is off Activity by then, as if closed.
const opened = [];
afterEach(() => {
  for (const state of opened.splice(0)) state.route = "send";
  vi.unstubAllGlobals();
});

// The popup at `route` with `ov`: DuskEVM, a block every 2 seconds, with the
// bridge's payment of 0.5 DUSK to TO from ACCOUNT's DuskEVM address a minute
// ago (or nothing yet), and the archive, where ACCOUNT sent nothing else to
// the bridge. Nothing else answers. `duskEvm` lists the RPC's methods asked.
async function popup(ov, route = "activity", { arrived = true } = {}) {
  const dom = installFakeDom({ pathname: "/popup.html" });
  dom.document.body.innerHTML = "";
  for (const [tag, id, className] of [["button", "network-pill", "network-pill"], ["div", "header-actions", ""], ["div", "app", ""]]) {
    const el = dom.document.createElement(tag);
    el.id = id;
    if (className) el.className = className;
    dom.document.body.appendChild(el);
  }
  vi.stubGlobal("localStorage", memoryStorage());
  const head = 3_952_000n;
  const chain = fakeChain({
    blockMs: 2_000,
    head,
    headAt: Date.now(),
    logs: !arrived ? [] : [
      {
        address: duskEvm.predeploys.l2StandardBridge,
        block: head - 30n,
        data: `0x${wordOf(500_000_000_000_000_000n)}${wordOf(0x40)}${wordOf(0)}`,
        hash: L2,
        topics: [ETH_BRIDGE_FINALIZED_TOPIC, topicOf(evmAddressOf(ACCOUNT)), topicOf(TO)],
      },
    ],
    url: duskEvm.rpcUrl,
  });
  // The archive lists the deposit in ACCOUNT's history, and nothing else, on one page.
  const archive = async (url, init) => {
    const body = String(init?.body);
    const range = /^query \{ out: moonlightHistory\(sender: "[^"]+", fromBlock: (\d+)(?:, toBlock: (\d+))?/.exec(body);
    if (String(url) !== `${TESTNET}/on/graphql/query` || !range) return Promise.reject(new Error("offline"));
    const listed = !body.includes("pageCount") && Number(range[1]) <= 4_697_290 && 4_697_290 <= Number(range[2] ?? Infinity);
    return new Response(JSON.stringify({ data: { out: listed ? { json: [sent] } : null } }));
  };
  vi.stubGlobal("fetch", vi.fn(async (url, init) => (chain.answers(url) ? chain.answer(url, init) : archive(url, init))));
  vi.resetModules();
  const { send } = await import("../../wallet/bus.js");
  send.mockReset();
  send.mockImplementation(async (message) => (message.type === "DUSK_UI_OVERVIEW" ? structuredClone(ov) : {}));
  const { state } = await import("./state.js");
  state.route = route;
  opened.push(state);
  const { render } = await import("./app.js");
  await render();
  await flush();
  const status = () => dom.document.body.querySelectorAll(".tx-row .tx-status").map(visibleText);
  // What the wallet tells this page, as the desktop app's does (and the extension's, with runtime messages).
  const tell = (message) =>
    dom.window._listeners.filter((l) => l.type === "dusk-wallet-message").forEach((l) => l.fn({ detail: message }));
  return { dom, render, duskEvm: () => chain.methods(), status, tell };
}

describe("a deposit to DuskEVM on its way, in the popup", () => {
  it("is asked for on DuskEVM at once, Arrived once there, and not asked for again", async () => {
    const view = await popup(overview());
    expect(view.duskEvm()).toContain("eth_getLogs");
    expect(view.status()).toEqual(["Arrived"]);
    const asked = view.duskEvm().length;
    await view.render({ forceRefresh: true });
    await flush();
    expect([view.duskEvm().length, view.status()]).toEqual([asked, ["Arrived"]]);
  });

  it("stops looking once the wallet locks: a look due after it asks nothing, though the locked overview still lists the deposit", async () => {
    const ov = overview();
    const view = await popup(ov, "activity", { arrived: false });
    expect(view.duskEvm()).toContain("eth_getLogs");
    const asked = view.duskEvm().length;
    ov.isUnlocked = false;
    view.tell({ type: "DUSK_UI_LOCK_STATE", isUnlocked: false });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await flush();
    expect(view.duskEvm().length).toBe(asked);
  });

  it("asks nothing with no deposit on its way, on Mainnet, or away from Activity", async () => {
    for (const [ov, route] of [
      [overview({ txs: [deposit({ status: "submitted" })] }), "activity"],
      [overview({ txs: [{ ...deposit(), kind: "transfer", contractId: undefined, fnName: undefined, bridgeTo: undefined }] }), "home"],
      [overview({ networkName: "Mainnet", nodeUrl: MAINNET, chainId: 1, txs: [deposit({ nodeUrl: MAINNET })] }), "activity"],
      [overview(), "send"],
    ]) {
      const view = await popup(ov, route);
      expect(view.duskEvm()).toEqual([]);
    }
  });
});
