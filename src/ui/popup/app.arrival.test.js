import { networks } from "@dusk-network/networks";
import { afterEach, describe, expect, it, vi } from "vitest";

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

// A deposit of 0.5 DUSK to TO, gone through three minutes ago.
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
  // Its block's time, as the node gave it.
  finalizedAt: Date.now() - 185_000,
  profileIndex: 0,
  nodeUrl: TESTNET,
  ...over,
});
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

// The popup at `route` with `ov`, DuskEVM's explorer listing the L2 bridge's
// payment of 0.5 DUSK to TO a minute ago (or nothing yet); nothing else answers.
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
  const explorer = vi.fn(async () =>
    new Response(
      JSON.stringify({
        items: !arrived ? [] : [
          {
            transaction_hash: L2,
            from: { hash: duskEvm.predeploys.l2StandardBridge },
            to: { hash: TO },
            value: "500000000000000000",
            success: true,
            timestamp: new Date(Date.now() - 60_000).toISOString(),
          },
        ],
      })
    )
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => (String(url).startsWith(`${duskEvm.blockscoutApiUrl}/addresses/`) ? explorer(url) : Promise.reject(new Error("offline"))))
  );
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
  return { dom, render, explorer, status, tell };
}

describe("a deposit to DuskEVM on its way, in the popup", () => {
  it("is asked for on DuskEVM's explorer at once, Arrived once there, and not asked for again", async () => {
    const view = await popup(overview());
    expect(view.explorer.mock.calls.map(([url]) => url)).toEqual([`${duskEvm.blockscoutApiUrl}/addresses/${TO.toLowerCase()}/internal-transactions?filter=to`]);
    expect(view.status()).toEqual(["Arrived"]);
    await view.render({ forceRefresh: true });
    await flush();
    expect([view.explorer.mock.calls.length, view.status()]).toEqual([1, ["Arrived"]]);
  });

  it("stops looking once the wallet locks: a look due after it asks nothing, though the locked overview still lists the deposit", async () => {
    const ov = overview();
    const view = await popup(ov, "activity", { arrived: false });
    expect(view.explorer).toHaveBeenCalledTimes(1);
    ov.isUnlocked = false;
    view.tell({ type: "DUSK_UI_LOCK_STATE", isUnlocked: false });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await flush();
    expect(view.explorer).toHaveBeenCalledTimes(1);
  });

  it("asks nothing with no deposit on its way, on Mainnet, or away from Activity", async () => {
    for (const [ov, route] of [
      [overview({ txs: [deposit({ status: "submitted" })] }), "activity"],
      [overview({ txs: [{ ...deposit(), kind: "transfer", contractId: undefined }] }), "home"],
      [overview({ networkName: "Mainnet", nodeUrl: MAINNET, chainId: 1, txs: [deposit({ nodeUrl: MAINNET })] }), "activity"],
      [overview(), "send"],
    ]) {
      const view = await popup(ov, route);
      expect(view.explorer).not.toHaveBeenCalled();
    }
  });
});
