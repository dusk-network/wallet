import { afterEach, describe, expect, it, vi } from "vitest";

import { accessibleName, installFakeDom, settle, typeInto } from "../testing/fakeDom.js";

vi.mock("../../wallet/bus.js", () => ({ send: vi.fn() }));
vi.mock("../../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: vi.fn(async () => null),
}));

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const OTHER =
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const TESTNET = {
  hasVault: true,
  isUnlocked: true,
  networkName: "Testnet",
  nodeUrl: "https://testnet.nodes.dusk.network",
  accounts: [ACCOUNT, OTHER],
  accountCount: 2,
  selectedAccountIndex: 0,
  balance: { value: "0" },
};
// Testnet's Sozu, as Staking read it, and as it still is.
const SOZU = {
  configured: true,
  networkKey: "testnet",
  contracts: { pool: "72".repeat(32), "staked-dusk": "5d".repeat(32) },
  publicBalance: { value: "1482938300000" },
  fees: { deposit: { numerator: "25", denominator: "10000" }, reward: { numerator: "10", denominator: "100" } },
  features: { maintenance: false, synchronization: false },
  pool: { totalStakeLux: "3071932000000", tokenTotalSupply: "1000000000000" },
  position: { poolBalanceLux: "0", stDuskBalanceLux: "0" },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const flush = async () => {
  for (let i = 0; i < 5; i++) await settle();
};

// The header's network pill and actions, and the app, as popup.html has them.
function popupPage() {
  const dom = installFakeDom({ pathname: "/popup.html" });
  dom.document.body.innerHTML = "";
  const pill = dom.document.createElement("button");
  pill.id = "network-pill";
  pill.className = "network-pill";
  const label = dom.document.createElement("span");
  label.className = "network-pill__label";
  pill.appendChild(label);
  const actions = dom.document.createElement("div");
  actions.id = "header-actions";
  const app = dom.document.createElement("div");
  app.id = "app";
  dom.document.body.append(pill, actions, app);
  return { dom, pill, app };
}

const menuItem = (dom, menu, text) =>
  dom.document.body
    .querySelectorAll(`${menu} [role=menuitemradio]`)
    .find((el) => el.querySelector(".net-menu-item-label").textContent === text);

describe("a stake with Sozu whose terms are read again as the header switches", () => {
  it.each([
    [
      "network",
      "DUSK_UI_SET_NODE_URL",
      { networkName: "Mainnet", nodeUrl: "https://nodes.dusk.network" },
      (dom, pill) => {
        pill.click();
        menuItem(dom, ".net-menu", "Mainnet").click();
      },
    ],
    [
      "profile",
      "DUSK_UI_SET_ACCOUNT_INDEX",
      { selectedAccountIndex: 1 },
      (dom) => {
        dom.document.body.querySelector(".account-chip").click();
        menuItem(dom, ".acct-menu", "Profile 2").click();
      },
    ],
  ])("sends nothing once the %s switch has started, though the overview still names the old one", async (_, switchType, after, startSwitch) => {
    const { dom, pill, app } = popupPage();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    vi.resetModules();
    const { send } = await import("../../wallet/bus.js");
    const { state } = await import("./state.js");
    send.mockReset();
    const terms = Promise.withResolvers();
    const switched = Promise.withResolvers();
    // Overviews read since the switch was asked for: the switch's own is slow.
    let sinceSwitch = null;
    send.mockImplementation(async (message) => {
      switch (message.type) {
        case "DUSK_UI_OVERVIEW":
          if (sinceSwitch === null) return TESTNET;
          return sinceSwitch++ === 0 ? switched.promise : { ...TESTNET, ...after };
        case switchType:
          sinceSwitch = 0;
          return { ok: true, result: true };
        case "DUSK_UI_GET_SOZU_STATUS":
          return terms.promise;
        case "DUSK_UI_GET_CACHED_GAS_PRICE":
          return { min: "1", median: "1", max: "1" };
        case "DUSK_UI_SEND_TX":
          return { ok: true, result: { hash: "ab".repeat(32) } };
        default:
          return {};
      }
    });
    const sent = () => send.mock.calls.filter(([m]) => m.type === "DUSK_UI_SEND_TX");
    const confirm = () => app.querySelectorAll("button").find((b) => b.textContent === "Confirm");

    // Staking drafts a 100 DUSK stake at Sozu's terms and opens its Review.
    const { sozuLiquidStakingView } = await import("./views/sozu.js");
    state.sozu = { action: "deposit", depositAmountDusk: "", loaded: true, loading: false, profileIndex: 0, status: SOZU, pool: SOZU.pool, position: SOZU.position };
    app.replaceChildren(...sozuLiquidStakingView(TESTNET, { state, actions: { send, render: async () => {} } }));
    typeInto(app.querySelectorAll("input").find((i) => accessibleName(i) === "Stake amount"), "100");
    app.querySelectorAll("button").find((b) => b.textContent === "Review stake").click();
    expect(state.route).toBe("sozu_confirm");
    const { render } = await import("./app.js");
    await render();
    await flush();

    // Confirm reads Sozu's terms again; the switch starts while they're read.
    confirm().click();
    await flush();
    startSwitch(dom, pill);
    await flush();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: switchType }));
    expect(state.overview).toBe(TESTNET);

    // The terms come back unchanged, as the old network or profile has them.
    terms.resolve({ ok: true, result: SOZU });
    await flush();
    expect(sent()).toEqual([]);

    // The switch's overview lands: the Review, drawn again, can be confirmed.
    switched.resolve({ ...TESTNET, ...after });
    await flush();
    expect(state.route).toBe("sozu_confirm");
    expect(confirm().disabled).toBe(false);
    expect(sent()).toEqual([]);
  });

  it("ends whatever began unlocked the moment the wallet says it locked", async () => {
    popupPage();
    let onMessage = null;
    vi.stubGlobal("browser", {
      runtime: { id: "dusk-wallet", sendMessage: () => {}, onMessage: { addListener: (fn) => (onMessage = fn) } },
    });
    vi.resetModules();
    const { send } = await import("../../wallet/bus.js");
    send.mockReset();
    send.mockImplementation(async (message) => (message.type === "DUSK_UI_OVERVIEW" ? TESTNET : {}));
    const { state } = await import("./state.js");
    await import("./app.js");
    const before = state.context;
    onMessage({ type: "DUSK_UI_LOCK_STATE", isUnlocked: false });
    expect([state.context, state.overview?.isUnlocked]).toEqual([before + 1, false]);
    await flush();
  });
});
