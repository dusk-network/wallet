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

const SWITCHED = "The network or profile changed, so nothing was sent. Check the stake again.";

// The popup on Testnet at the Review of a 100 DUSK stake, drafted on
// Staking's Sozu screen, with the wallet answering as `answer` says.
async function stakeReview(answer) {
  const { dom, pill, app } = popupPage();
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
  vi.resetModules();
  const { send } = await import("../../wallet/bus.js");
  const { state } = await import("./state.js");
  send.mockReset();
  send.mockImplementation(answer);
  const { sozuLiquidStakingView } = await import("./views/sozu.js");
  state.staking = { screen: "liquid" };
  state.sozu = { action: "deposit", depositAmountDusk: "", loaded: true, loading: false, profileIndex: 0, status: SOZU, pool: SOZU.pool, position: SOZU.position };
  app.replaceChildren(...sozuLiquidStakingView(TESTNET, { state, actions: { send, render: async () => {} } }));
  const amount = () => app.querySelectorAll("input").find((i) => accessibleName(i) === "Stake amount");
  typeInto(amount(), "100");
  app.querySelectorAll("button").find((b) => b.textContent === "Review stake").click();
  expect(state.route).toBe("sozu_confirm");
  const { render } = await import("./app.js");
  await render();
  await flush();
  return {
    dom,
    pill,
    app,
    send,
    state,
    amount,
    sent: () => send.mock.calls.filter(([m]) => m.type === "DUSK_UI_SEND_TX"),
    confirm: () => app.querySelectorAll("button").find((b) => b.textContent === "Confirm"),
  };
}

// The header's switches, as a person makes them.
const switchToMainnet = (dom, pill) => {
  pill.click();
  menuItem(dom, ".net-menu", "Mainnet").click();
};
const switchToProfile2 = (dom) => {
  dom.document.body.querySelector(".account-chip").click();
  menuItem(dom, ".acct-menu", "Profile 2").click();
};

describe("a stake with Sozu whose terms are read again as the header switches", () => {
  it.each([
    ["network", "DUSK_UI_SET_NODE_URL", { networkName: "Mainnet", nodeUrl: "https://nodes.dusk.network" }, switchToMainnet],
    ["profile", "DUSK_UI_SET_ACCOUNT_INDEX", { selectedAccountIndex: 1 }, switchToProfile2],
  ])("sends nothing once the %s switch has started, though the overview still names the old one", async (_, switchType, after, startSwitch) => {
    const terms = Promise.withResolvers();
    const switched = Promise.withResolvers();
    // Overviews read since the switch was asked for: the switch's own is slow.
    let sinceSwitch = null;
    const { dom, pill, app, send, state, amount, sent, confirm } = await stakeReview(async (message) => {
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

    // Confirm reads Sozu's terms again; the switch starts while they're read.
    confirm().click();
    await flush();
    startSwitch(dom, pill);
    await flush();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: switchType }));
    expect(state.overview).toBe(TESTNET);

    // The terms come back unchanged, as the old network or profile has them:
    // nothing is sent, and the stake's own screen says why.
    terms.resolve({ ok: true, result: SOZU });
    await flush();
    expect(sent()).toEqual([]);
    switched.resolve({ ...TESTNET, ...after });
    await flush();
    expect([state.route, state.staking.screen, state.sozuDraft]).toEqual(["stake", "liquid", null]);
    expect(app.querySelector(".sozu-notice")?.textContent).toBe(SWITCHED);
    expect(amount().value).toBe("100");
    expect(sent()).toEqual([]);
  });

  it("offers no Confirm on a Review left idle while the header switches to Profile 2, and sends nothing from Profile 1", async () => {
    let profile = 0;
    const { dom, app, send, state, amount, sent, confirm } = await stakeReview(async (message) => {
      switch (message.type) {
        case "DUSK_UI_OVERVIEW":
          return { ...TESTNET, selectedAccountIndex: profile };
        case "DUSK_UI_SET_ACCOUNT_INDEX":
          profile = message.index;
          return { ok: true, result: true };
        case "DUSK_UI_GET_SOZU_STATUS":
          return { ok: true, result: SOZU };
        case "DUSK_UI_GET_CACHED_GAS_PRICE":
          return { min: "1", median: "1", max: "1" };
        case "DUSK_UI_SEND_TX":
          return { ok: true, result: { hash: "ab".repeat(32) } };
        default:
          return {};
      }
    });
    expect(confirm().disabled).toBe(false);

    // The switch is done and the popup draws again: still on this Review, with
    // the stake drafted for Profile 1.
    switchToProfile2(dom);
    await flush();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "DUSK_UI_SET_ACCOUNT_INDEX", index: 1 }));
    confirm()?.click();
    await flush();
    expect(sent()).toEqual([]);
    expect([state.route, state.staking.screen, state.sozuDraft]).toEqual(["stake", "liquid", null]);
    expect(confirm()).toBeUndefined();
    expect(app.querySelector(".sozu-notice")?.textContent).toBe(SWITCHED);
    expect(amount().value).toBe("100");
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
    expect(state.context).not.toBe(before);
    expect([state.context.reason, state.overview?.isUnlocked]).toEqual(["lock", false]);
    await flush();
  });
});
