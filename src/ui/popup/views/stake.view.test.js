import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The fake DOM goes before the views: it defines HTMLElement for the gas editor.
import { accessibleName, installFakeDom, isShown, pastClickGuard, screenReaderText, settle, typeInto, visibleText } from "../../testing/fakeDom.js";
import { networks } from "@dusk-network/networks";
import { REWARDS_COUNTED } from "@dusk-network/app-core/export";
import { entryOf } from "../../../shared/fixtures/rows.js";
import { activityKey } from "../activity.js";
import { lookupPrimaryName } from "../../../shared/duskNames.js";
import { maxAmountLux } from "../../../shared/amount.js";
import { GAS_PRICE_BUSY } from "../../../shared/txDefaults.js";
import { stakeConfirmView, stakeFormView } from "./stake.js";
import { SOZU_UNSTAKE_LINE, sozuConfirmView } from "./sozu.js";
import { screenShown } from "../../lib/clickGuard.js";
import { reviewOf, sentView } from "./sent.js";
import { switchContext } from "../context.js";

// The profile's verified name, as the header shows it: none unless a test gives one.
vi.mock("../../../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: vi.fn(async () => null),
}));
// The archive has no event of a stake here: its deposit fee is what the rate comes to now.
// A test can give it the pool's events (archiveWith).
const archive = vi.hoisted(() => ({ query: async () => ({}) }));
vi.mock("../../../shared/activityHistory.js", async (importOriginal) => ({
  ...(await importOriginal()),
  archiveAt: () => ({ query: (text) => archive.query(text) }),
}));

// What native staking paid lately, as app-core measures it from the chain: nothing read here.
vi.mock("@dusk-network/app-core/sozu", async (importOriginal) => ({
  ...(await importOriginal()),
  nativeRewards: vi.fn(async () => null),
}));

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const OTHER =
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const dusk = (n) => (BigInt(n) * 1_000_000_000n).toString();
const POOL = `${"72".repeat(32)}`;
const ST_DUSK = `${"5d".repeat(32)}`;

// Profile 1 (selected) has no stake and 1,482.9383 DUSK public. `related`
// adds Profile 2's stake, which Profile 1 owns.
const owner = (over = {}) => ({
  profileIndex: 0,
  account: ACCOUNT,
  publicBalance: { value: "1482938300000" },
  hasStake: false,
  info: { amount: null, reward: "0", faults: 0, hardFaults: 0 },
  ownerKind: "none",
  ownerProfileIndex: 0,
  manageable: true,
  profiles: [{ profileIndex: 0 }, { profileIndex: 1 }],
  relatedStakes: [],
  ...over,
});
const related = (over = {}) => ({
  profileIndex: 1,
  account: OTHER,
  publicBalance: { value: dusk(500) },
  hasStake: true,
  info: {
    amount: { value: dusk(2000), locked: dusk(10), eligibility: "4687000", total: dusk(2000) },
    reward: dusk(42),
    faults: 1,
    hardFaults: 0,
  },
  ownerKind: "local",
  ownerProfileIndex: 0,
  manageable: true,
  ...over,
});
const staking = (ownerStatus = owner(), over = {}) => ({
  loaded: true,
  loading: false,
  profileIndex: 0,
  minimumStakeLux: dusk(1000),
  actionKind: "topup",
  stakeAmountDusk: "",
  ownerProfileIndex: 0,
  ownerStatus,
  ...over,
});
// Sozu's pool: 3,071.932 DUSK staked for 1,000 stDUSK, so each stDUSK is worth
// about 3.07 DUSK. Testnet's fees: 0.25% of a deposit and 10% of rewards.
const sozu = (over = {}) => ({
  action: "deposit",
  depositAmountDusk: "",
  withdrawAmountDusk: "",
  loaded: true,
  loading: false,
  error: null,
  profileIndex: 0,
  readAccount: ACCOUNT,
  status: {
    configured: true,
    networkKey: "testnet",
    contracts: { pool: POOL, "staked-dusk": ST_DUSK },
    publicBalance: { value: "1482938300000" },
    fees: { deposit: { numerator: "25", denominator: "10000" }, reward: { numerator: "10", denominator: "100" } },
    features: { maintenance: false, synchronization: false },
  },
  pool: { totalStakeLux: "3071932000000", tokenTotalSupply: dusk(1000) },
  position: { poolBalanceLux: "0", stDuskBalanceLux: "0" },
  ...over,
});

const ov = (over = {}) => ({ isUnlocked: true, accounts: [ACCOUNT], selectedAccountIndex: 0, nodeUrl: "https://testnet.nodes.dusk.network", networkName: "Testnet", ...over });
// What Liquid staking says after leaving a stake's Review the popup moved away from: nothing was sent, as the
// network or profile changed, or as the wallet locked; each said for its own case, never the other's.
const SWITCHED = { says: /network|profile/i, never: /lock/i };
const LOCKED = { says: /lock/i, never: /network|profile/i };

let dom;
let body;

beforeEach(() => {
  dom = installFakeDom();
  body = dom.document.body;
  lookupPrimaryName.mockReset();
  lookupPrimaryName.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  archive.query = async () => ({});
});

// What the wallet says waits in the node's mempool, as Reviews ask for it.
const MEDIAN_ONE = { min: "1", median: "1", max: "1" };
let gasAnswer = MEDIAN_ONE;

// Draws Staking, its Review and Sent as app.js routes them, and redraws on
// render. Sozu's status, read again before a stake is sent, is the one Staking
// holds, unless `sozuStatus` gives what the node says by then.
function popup(state, overview = ov(), { sozuStatus, rewardRate = null, stakingFigures = null } = {}) {
  const actions = {
    send: vi.fn(async (message) => {
      if (message.type === "DUSK_UI_GET_CACHED_GAS_PRICE") return gasAnswer;
      if (message.type === "DUSK_UI_GET_REWARD_RATE") return { ok: true, result: rewardRate };
      if (message.type === "DUSK_UI_GET_STAKING_FIGURES") return { ok: true, result: stakingFigures };
      if (message.type === "DUSK_UI_SEND_TX") return { ok: true, result: { hash: "ab".repeat(32) } };
      if (message.type === "DUSK_UI_GET_SOZU_STATUS") {
        const st = state.sozu;
        return { ok: true, result: sozuStatus ? await sozuStatus() : { ...st?.status, pool: st?.pool, position: st?.position } };
      }
      return {};
    }),
    render: vi.fn(async () => draw()),
    showToast: vi.fn(),
    announce: vi.fn(),
  };
  const draw = () => {
    const view =
      state.route === "stake_confirm"
        ? stakeConfirmView
        : state.route === "sozu_confirm"
          ? sozuConfirmView
          : state.route === "sent"
            ? sentView
            : state.route === "stake"
              ? stakeFormView
              : () => [];
    // What the screen is drawn for, as render() gives it (reviewOf).
    body.replaceChildren(...view(overview, { state, actions: { ...actions, review: reviewOf(overview, state) } }));
  };
  draw();
  return { actions, draw };
}

// What the wallet keeps on this device between popups.
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
  };
}

const button = (text) => body.querySelectorAll("button").find((b) => isShown(b) && visibleText(b) === text);
// A Review's own button (Confirm), whatever it says; none off a Review.
const confirm = () => body.querySelectorAll(".review-actions .btnrow > button").find(isShown);

// A figure exactly as written: not inside a longer number, not signed or bounded unless written so, and not followed by
// more digits, letters or a decimal part (1.0025 ≠ 11.0025, 0.005 ≠ −0.005, 2,000,000 ≠ 2,000,000.5, BNB ≠ BNBX).
const exactly = (text) => new RegExp(`(?<![\\d.,+\\-−<>≤≥~])(?<![+\\-−<>≤≥~]\\s)${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\dA-Za-z]|[.,]\\d)`);
// Figures said in one line, each exactly so, in their order or in any; and a name on its own: Profile 2, never
// Profile 20.
const inOrder = (...texts) => new RegExp(texts.map((text) => exactly(text).source).join("[\\s\\S]*"));
const allOf = (...texts) => new RegExp(`^${texts.map((text) => `(?=[\\s\\S]*${exactly(text).source})`).join("")}`);
const standalone = (name) => new RegExp(`(?<![\\w.-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`);
// A figure hidden with the balances: the dots, and none of its digits.
const hiddenFigure = (text) => typeof text === "string" && text.includes("••••") && !/\d/.test(text);

// A row's value, by its label, without the buttons beside it: To, From, Owner, Deposit fee, Sozu's Worth now and
// stDUSK.
const rowValue = (label) => {
  const row = body.querySelectorAll(".kv").find((kv) => visibleText(kv.querySelector(".kv-label")) === label);
  return row ? row.querySelector(".kv-value").childNodes.filter((node) => node.localName !== "button").map(visibleText).join("") : undefined;
};
// The value of a Review's row that matches: what a stake with Sozu gets, in stDUSK, and what that's worth.
const reviewValue = (match) => body.querySelectorAll(".row > .group .kv-value").map(visibleText).find((value) => match.test(value));
// A figure on Staking's summary, by its label: what it shows, as written ("2,000 DUSK"); and all of them.
const figureOf = (label) => {
  const lbl = body.querySelectorAll(".stake-sum .stake-lbl").find((el) => label.test(visibleText(el)));
  return lbl ? visibleText(lbl.parentNode.querySelector(".stake-big")) : undefined;
};
const figures = () => body.querySelectorAll(".stake-sum .stake-big").map(visibleText);
// A Review's fee, at most, and the row under it: the total, or what an unstake or a claim brings back.
const gasFee = () => visibleText(body.querySelector(".gas-fee-value"));
const gasTotal = () => visibleText(body.querySelector(".gas-total-value"));
// A fact on a form, by its title: the network fee, or Sozu's fees (its share of rewards in the title, the deposit
// fee under it).
const fact = (title) =>
  body.querySelectorAll(".group.info .list-row").find((row) => {
    const t = row.querySelector(".row-title");
    return Boolean(t) && title.test(visibleText(t));
  });
const factPart = (title, part) => {
  const el = fact(title)?.querySelector(part);
  return el ? visibleText(el) : "";
};
// The notice on Liquid staking's form: that nothing was sent, said for its own case.
const noticeSays = (notice) => {
  const text = visibleText(body.querySelector(".sozu-notice"));
  expect(text).toMatch(/nothing was sent/i);
  expect(text).toMatch(notice.says);
  expect(text).not.toMatch(notice.never);
};
const buttonStarting = (text) => body.querySelectorAll("button").find((b) => isShown(b) && visibleText(b).startsWith(text));
const field = (name) => body.querySelectorAll("input").find((i) => accessibleName(i) === name);

// Round 40's review: Staking's figures were the profile index's, read for whichever wallet asked, and a stake whose
// read failed came as none at all.
describe("staking's figures, read for a profile", () => {
  const STAKED = { amount: { value: dusk(2000), locked: "0", eligibility: "4687000", total: dusk(2000) }, reward: dusk(3), faults: 0, hardFaults: 0 };
  // Staking drawn for `shownOv`, each owner status asked kept for the test to answer.
  const asking = (state) => {
    const answers = [];
    const view = { ov: ov(), answers };
    const actions = {
      send: vi.fn((message) => {
        if (message.type === "DUSK_UI_GET_MINIMUM_STAKE") return Promise.resolve({ ok: true, result: dusk(1000) });
        if (message.type === "DUSK_UI_GET_STAKE_OWNER_STATUS") return new Promise((resolve) => answers.push(resolve));
        if (message.type === "DUSK_UI_GET_SOZU_STATUS") return new Promise(() => {});
        return Promise.resolve({});
      }),
      render: vi.fn(async () => view.draw()),
      showToast: vi.fn(),
    };
    view.draw = () => body.replaceChildren(...stakeFormView(view.ov, { state, actions }));
    return view;
  };
  const staked = () => visibleText(body.querySelector(".stake-sum") ?? body).includes("2,000");
  const stale = () => body.querySelectorAll(".stake-stale").filter(isShown).map(visibleText);

  it("draws another wallet's Profile 1 with its own figures, never those read for the wallet before it", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const state = { route: "stake" };
    const view = asking(state);
    view.draw();
    // Another wallet, its Profile 1 as the first's was, while the first's figures are read.
    view.ov = ov({ accounts: [OTHER] });
    view.draw();
    expect(view.answers).toHaveLength(2);
    view.answers[0]({ ok: true, result: owner({ hasStake: true, info: STAKED }) });
    await settle();
    expect(staked()).toBe(false);
    view.answers[1]({ ok: true, result: owner({ account: OTHER }) });
    await settle();
    expect([staked(), state.staking.ownerStatus.account]).toEqual([false, OTHER]);
  });

  it("keeps what's with Sozu, read before, where a read of it brings no position, and takes nothing held as read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 09:30 on this machine's clock, whatever its time zone.
    vi.setSystemTime(new Date(2026, 10, 18, 9, 30));
    vi.stubGlobal("localStorage", memoryStorage());
    const held = sozu({ position: { poolBalanceLux: dusk(3), stDuskBalanceLux: dusk(1) } });
    let position = held.position;
    const state = { route: "stake" };
    const actions = {
      send: vi.fn(async (message) => {
        if (message.type === "DUSK_UI_GET_MINIMUM_STAKE") return { ok: true, result: dusk(1000) };
        if (message.type === "DUSK_UI_GET_STAKE_OWNER_STATUS") return { ok: true, result: owner() };
        if (message.type === "DUSK_UI_GET_SOZU_STATUS") return { ok: true, result: { ...held.status, pool: held.pool, position } };
        return {};
      }),
      render: vi.fn(async () => draw()),
      showToast: vi.fn(),
    };
    const draw = () => body.replaceChildren(...stakeFormView(ov(), { state, actions }));
    // What's with Sozu, by its figure; and the one note on it: that it may be out of date, read last at 09:30, never
    // that it's current.
    const withSozu = () => figureOf(/sozu/i) === "3 DUSK";
    const staleSince0930 = () => {
      expect(stale()).toEqual([expect.stringMatching(/may be out of date[\s\S]*last read at 09:30(?![\d])/i)]);
      expect(stale()[0]).not.toMatch(/\bcurrent\b|up to date/i);
    };
    draw();
    await settle();
    expect([withSozu(), stale()]).toEqual([true, []]);
    const readAt = Date.now();
    // Read again later, its position not read: the one read before, with when.
    vi.setSystemTime(readAt + 20 * 60_000);
    position = null;
    state.sozu.loaded = false;
    draw();
    await settle();
    expect(withSozu()).toBe(true);
    staleSince0930();
    // Opened anew, none in hand: the one kept on this device.
    const opened = state.sozu;
    delete state.sozu;
    delete state.staking;
    draw();
    await settle();
    await settle();
    expect(withSozu()).toBe(true);
    staleSince0930();
    expect(state.sozu).not.toBe(opened);
    // Read as nothing held: nothing held, as read.
    position = { poolBalanceLux: "0", stDuskBalanceLux: "0" };
    state.sozu.loaded = false;
    draw();
    await settle();
    expect([withSozu(), stale()]).toEqual([false, []]);
    expect(figures()).not.toContain("3 DUSK");
  });

  // Its second review: with the stake unread and nothing kept, the error drew Staking again, which asked again at once,
  // over and over, and "can't be read" never stayed; and a status read for another wallet's profile, as another window
  // switched wallets, was shown and kept as this one's.
  it("keeps saying Staking can't be read, asking no more till the overview's read again, and takes no other account's", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { keptBalancesOf } = await import("../../../shared/keptBalances.js");
    let asked = 0;
    let answer = owner({ infoRead: false });
    const state = { route: "stake" };
    const actions = {
      send: vi.fn((message) => {
        if (message.type === "DUSK_UI_GET_MINIMUM_STAKE") return Promise.resolve({ ok: true, result: dusk(1000) });
        if (message.type === "DUSK_UI_GET_STAKE_OWNER_STATUS") return ++asked > 5 ? new Promise(() => {}) : Promise.resolve({ ok: true, result: answer });
        if (message.type === "DUSK_UI_GET_SOZU_STATUS") return new Promise(() => {});
        return Promise.resolve({});
      }),
      render: vi.fn(async () => draw()),
      showToast: vi.fn(),
    };
    const draw = () => body.replaceChildren(...stakeFormView(ov(), { state, actions }));
    const said = () => body.querySelectorAll(".err").filter(isShown).map(visibleText);
    const settled = async () => {
      for (let i = 0; i < 10; i++) await settle();
    };
    draw();
    await settled();
    expect([asked, said().length]).toEqual([1, 1]);
    draw();
    await settled();
    expect(asked).toBe(1);
    // The overview read again: asked again, and answered for another wallet's Profile 1.
    answer = owner({ account: OTHER, hasStake: true, info: STAKED });
    Object.assign(state.staking, { loaded: false, error: null });
    draw();
    await settled();
    expect([asked, staked(), said().length]).toEqual([2, false, 1]);
    expect((await keptBalancesOf({ nodeUrl: ov().nodeUrl, account: ACCOUNT }))?.staking).toBeUndefined();
  });

  // Its second review: a profile's account is the same on Testnet and Mainnet; switched to Mainnet, a read that brought
  // no position took Testnet's, which Liquid staking offered to unstake.
  it("never takes one network's position with Sozu for another's, the same account on both", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const held = sozu({ position: { poolBalanceLux: dusk(3), stDuskBalanceLux: dusk(1) } });
    let answer = { ...held.status, pool: held.pool, position: held.position };
    const state = { route: "stake" };
    const actions = {
      send: vi.fn(async (message) => {
        if (message.type === "DUSK_UI_GET_MINIMUM_STAKE") return { ok: true, result: dusk(1000) };
        if (message.type === "DUSK_UI_GET_STAKE_OWNER_STATUS") return { ok: true, result: owner() };
        if (message.type === "DUSK_UI_GET_SOZU_STATUS") return { ok: true, result: answer };
        return {};
      }),
      render: vi.fn(async () => draw()),
      showToast: vi.fn(),
    };
    let shownOv = ov();
    const draw = () => body.replaceChildren(...stakeFormView(shownOv, { state, actions }));
    // What's with Sozu, by its figure.
    const withSozu = () => figureOf(/sozu/i) === "3 DUSK";
    draw();
    await settle();
    expect(withSozu()).toBe(true);
    // Mainnet, the same account, its position not read: nothing of Testnet's.
    shownOv = ov({ nodeUrl: "https://nodes.dusk.network", networkName: "Mainnet" });
    state.context = "mainnet";
    answer = { ...held.status, networkKey: "mainnet", pool: held.pool, position: null };
    draw();
    await settle();
    await settle();
    expect([withSozu(), state.sozu.position]).toEqual([false, null]);
  });
});

describe("staking overview", () => {
  it("estimates with the Sozu of the node's own network: asked again once a custom node's chain ID is read, never another network's fee", async () => {
    // What a choice, by its name, says it pays a year: its line with a rate. Sozu's is 20% less its fee, 10% on
    // Testnet: 18%, then the fee.
    const rateOf = (choice) => {
      const button = body.querySelectorAll(".stake-choices > button").find((b) => choice.test(visibleText(b.querySelector(".row-title"))));
      return button?.querySelectorAll(".row-sub").map(visibleText).find((line) => line.includes("%")) ?? "";
    };
    const testnetFee = (line) => inOrder("18%", "10%").test(line) && !exactly("15%").test(line);
    const statusReads = (actions) => actions.send.mock.calls.filter(([m]) => m.type === "DUSK_UI_GET_SOZU_STATUS").length;
    const testnet = sozu().status;
    const unread = { configured: false, networkKey: "custom" };
    // A custom node chosen while it couldn't say its network: no Sozu there
    // yet, even from an engine already told it's Testnet's.
    const state = { route: "stake", staking: staking(), sozu: sozu({ status: unread }) };
    const custom = ov({ nodeUrl: "https://my-node.example", networkName: "Custom", chainId: null });
    popup(state, custom, { rewardRate: 0.2, sozuStatus: async () => testnet });
    await vi.waitFor(() => expect(rateOf(/native/i)).toMatch(exactly("20%")));
    expect(rateOf(/sozu/i)).toBe("");

    // Read since: Testnet, whose Sozu is asked for, past the status held of before.
    const later = popup(state, { ...custom, chainId: 2 }, { rewardRate: 0.2, sozuStatus: async () => testnet });
    await vi.waitFor(() => expect(testnetFee(rateOf(/sozu/i))).toBe(true));
    expect(statusReads(later.actions)).toBe(1);

    // Mainnet's Sozu, held from before a switch, isn't Testnet's.
    const mainnet = { ...testnet, networkKey: "mainnet", fees: { ...testnet.fees, reward: { numerator: "15", denominator: "100" } } };
    const switched = { route: "stake", staking: staking(), sozu: sozu({ status: mainnet }) };
    const next = popup(switched, ov(), { rewardRate: 0.2, sozuStatus: async () => testnet });
    await vi.waitFor(() => expect(testnetFee(rateOf(/sozu/i))).toBe(true));
    expect(statusReads(next.actions)).toBe(1);
  });

  it("reads Sozu again for what was read before a switch of wallet, and doesn't show the old figure", async () => {
    const position = { poolBalanceLux: "99749998", stDuskBalanceLux: "31800000" };
    const held = sozu({ position: { poolBalanceLux: "5000000000", stDuskBalanceLux: "1600000000" }, readContext: {} });
    const thisWallet = { ...held.status, position, pool: held.pool };
    const state = { route: "stake", staking: staking(), sozu: held, context: {} };
    popup(state, ov(), { sozuStatus: async () => thisWallet });
    expect(figures()).not.toContain("5 DUSK");
    await settle();
    expect(figureOf(/sozu/i)).toBe("0.0997 DUSK");
  });

  it("reads Sozu again when the network came to be known after the read, with no switch", async () => {
    const position = { poolBalanceLux: "99749998", stDuskBalanceLux: "31800000" };
    const held = sozu({ position });
    const thisNetwork = { ...held.status, position, pool: held.pool };
    held.status = { ...held.status, networkKey: "mainnet" };
    popup({ route: "stake", staking: staking(), sozu: held }, ov(), { sozuStatus: async () => thisNetwork });
    await settle();
    expect(figureOf(/sozu/i)).toBe("0.0997 DUSK");
  });

  it("leaves out an answer for the wallet switched from, though it came under the new context", async () => {
    const theirs = { ...sozu().status, position: { poolBalanceLux: "5000000000", stDuskBalanceLux: "1600000000" }, pool: sozu().pool };
    const answers = [];
    const state = { route: "stake", staking: staking(), sozu: sozu({ loaded: false, position: null }), overview: ov() };
    popup(state, ov(), { sozuStatus: () => new Promise((resolve) => answers.push(resolve)) });

    // The overview has moved on to the new wallet by the time the answer comes.
    state.overview = ov({ accounts: [OTHER] });
    answers[0](theirs);
    await settle();
    expect(figures()).not.toContain("5 DUSK");
    expect(state.sozu.position).toBeNull();
    expect(answers).toHaveLength(2);
  });

  it("leaves out an answer from before a switch of wallet, and asks again", async () => {
    const position = { poolBalanceLux: "99749998", stDuskBalanceLux: "31800000" };
    const theirs = { ...sozu().status, position: { poolBalanceLux: "5000000000", stDuskBalanceLux: "1600000000" }, pool: sozu().pool };
    const ours = { ...sozu().status, position, pool: sozu().pool };
    const answers = [];
    const state = { route: "stake", staking: staking(), sozu: sozu({ loaded: false, position: null }), context: {} };
    popup(state, ov(), { sozuStatus: () => new Promise((resolve) => answers.push(resolve)) });

    switchContext(state);
    answers[0](theirs);
    await settle();
    expect(figures()).not.toContain("5 DUSK");
    expect(answers).toHaveLength(2);

    answers[1](ours);
    await settle();
    expect(figureOf(/sozu/i)).toBe("0.0997 DUSK");
  });

  it("says nothing of Sozu for what another network read", () => {
    const position = { poolBalanceLux: "99749998", stDuskBalanceLux: "31800000" };
    const other = sozu({ position });
    other.status = { ...other.status, networkKey: "mainnet" };
    popup({ route: "stake", staking: staking(), sozu: other }, ov(), { sozuStatus: async () => other.status });
    expect(visibleText(body.querySelector(".stake-sum"))).not.toMatch(/0\.0997|0\.0318/);
  });

  it("says on a native unstake's Review how much the fee is short, from the stake's own profile", async () => {
    const state = { route: "stake", staking: staking(owner({ hasStake: true, info: { amount: { total: dusk(1000), locked: "0" }, reward: "0" } })), sozu: sozu() };
    const app = popup(state);
    state.stakeDraft = { kind: "unstake", stakeProfileIndex: 0, profileIndex: 0, ownerProfileIndex: 0, payment: "account", displayLux: dusk(1000), hasStake: true };
    state.staking.ownerStatus.profiles = [{ profileIndex: 0, publicBalance: { value: "1000" } }];
    state.route = "stake_confirm";
    app.draw();
    await settle();
    expect(body.querySelector(".pay-guard").textContent).toMatch(exactly("0.05 DUSK"));
    expect(confirm().disabled).toBe(true);
  });

  it("says why Unstake and Claim rewards can't be pressed", () => {
    popup({ route: "stake", staking: staking(), sozu: sozu() });
    const sum = body.querySelector(".stake-sum");
    expect([figureOf(/staked/i), figureOf(/rewards/i)]).toEqual(["0 DUSK", "0 DUSK"]);
    expect([button("Unstake").disabled, button("Claim rewards").disabled]).toEqual([true, true]);
    // One reason for both, said once: nothing is staked.
    expect(sum.querySelectorAll(".stake-cap").map(visibleText)).toEqual([expect.stringMatching(/nothing staked/i)]);

    // A stake whose profile can't pay the fee says that instead: whose balance, and how much is short.
    popup({ route: "stake", staking: staking(owner({ relatedStakes: [related({ publicBalance: { value: "0" } })] })) });
    expect([button("Unstake").disabled, button("Claim rewards").disabled]).toEqual([true, true]);
    const short = body.querySelectorAll(".stake-sum .stake-cap").map(visibleText).find((cap) => exactly("0.05 DUSK").test(cap));
    expect(short).toMatch(standalone("Profile 2"));

    // An owner the wallet can't sign for: a contract, or a key it doesn't hold; each said for its own case.
    for (const [ownerKind, reason, never] of [
      ["contract", /contract/i, /key/i],
      ["missing", /key/i, /contract/i],
    ]) {
      popup({ route: "stake", staking: staking(owner({ relatedStakes: [related({ ownerKind, manageable: false })] })) });
      expect(button("Unstake").disabled).toBe(true);
      const caps = body.querySelectorAll(".stake-sum .stake-cap").map(visibleText).join(" ");
      expect(caps).toMatch(reason);
      expect(caps).not.toMatch(never);
    }
  });

  it("drafts a full unstake and a claim of all rewards with the stake's and the owner's profiles", () => {
    for (const [label, kind, displayLux] of [
      ["Unstake", "unstake", dusk(2000)],
      ["Claim rewards", "withdraw_reward", dusk(42)],
    ]) {
      const state = { route: "stake", staking: staking(owner({ relatedStakes: [related()] })) };
      popup(state);
      // The stake with a stake shows, named, its account as written, with what it holds.
      const account = body.querySelector(".stake-account .mono");
      expect(visibleText(body.querySelector(".stake-account"))).toMatch(standalone("Profile 2"));
      expect([visibleText(account), account.title]).toEqual(["21n5nc…fMMLNz", OTHER]);
      expect([figureOf(/staked/i), figureOf(/rewards/i)]).toEqual(["2,000 DUSK", "42 DUSK"]);
      button(label).click();
      expect(state.route).toBe("stake_confirm");
      expect(state.stakeDraft).toMatchObject({
        kind,
        profileIndex: 1,
        stakeProfileIndex: 1,
        ownerProfileIndex: 0,
        amountLux: null,
        amountMode: "all",
        displayLux,
      });
    }
  });

  it("names a contract or a missing key as the owner, under Advanced on both screens", () => {
    const state = {
      route: "stake",
      staking: staking(owner({ relatedStakes: [related({ ownerKind: "contract", ownerProfileIndex: null, manageable: false })] })),
    };
    popup(state);
    expect(rowValue("Owner")).toMatch(/contract/i);
    expect(rowValue("Owner")).not.toMatch(/profile/i);
    state.staking.screen = "native";
    popup(state);
    expect(rowValue("Owner")).toMatch(/contract/i);
    expect(rowValue("Owner")).not.toMatch(/profile/i);
    // Blocked: a note says why, and Review stays off.
    expect(body.querySelector(".amount-note").textContent).toMatch(/contract/i);
    expect(button("Review stake").disabled).toBe(true);
  });
});

describe("native staking", () => {
  it("says the minimum under the amount as it is typed, and Review stays off", async () => {
    const state = { route: "stake", staking: staking(owner(), { screen: "native" }) };
    popup(state);
    const amount = field("Stake amount");
    expect(amount).toBeTruthy();

    typeInto(amount, "100");
    const error = body.querySelector(".amount-field__error");
    expect(isShown(error)).toBe(true);
    expect(error.textContent).toMatch(exactly("1,000 DUSK"));

    // Review doesn't go on.
    const review = button("Review stake");
    review.click();
    await settle();
    expect(state.route).toBe("stake");
    expect(review.disabled).toBe(true);
  });

  it("fixes the amount with Use 1,000 or Max, and drafts the stake from the public balance", async () => {
    const state = { route: "stake", staking: staking(owner(), { screen: "native" }) };
    popup(state);
    typeInto(field("Stake amount"), "100");

    button("Use 1,000").click();
    expect(field("Stake amount").value).toBe("1000");
    expect(body.querySelector(".amount-field__error").hidden).toBe(true);
    expect(button("Review stake").disabled).toBe(false);
    expect(visibleText(body.querySelector(".amount-avail"))).toMatch(exactly("1,482.9383 DUSK"));

    // Max leaves this stake's fee and the fee to unstake later, and says both: all it keeps, then each.
    button("Max").click();
    expect(field("Stake amount").value).toBe("1482.8383");
    expect(visibleText(body.querySelector(".amount-note"))).toMatch(inOrder("0.1 DUSK", "0.05", "0.05"));

    // Too much says by how much, fee included.
    typeInto(field("Stake amount"), "5000");
    expect(body.querySelector(".amount-field__error").textContent).toMatch(exactly("3,517.1117 DUSK"));

    typeInto(field("Stake amount"), "1000");
    button("Review stake").click();
    expect(state.route).toBe("stake_confirm");
    expect(state.stakeDraft).toMatchObject({
      kind: "stake",
      profileIndex: 0,
      ownerProfileIndex: 0,
      amountLux: dusk(1000),
      amountMode: "custom",
      fundingLabel: "Profile 1 public balance",
    });
  });

  it("sets aside the fee Review starts from, with custom gas from Settings", async () => {
    // Price 3 and staking's own 50M limit, as the custom 2.5M is under its minimum.
    const state = { route: "stake", staking: staking(owner(), { screen: "native" }) };
    popup(state, ov({ customGas: { limit: "2500000", price: "3" } }));
    expect(factPart(/fee/i, ".row-title")).toMatch(exactly("0.15 DUSK"));
    typeInto(field("Stake amount"), "1482.8");
    expect(body.querySelector(".amount-field__error").textContent).toMatch(exactly("0.0117 DUSK"));
    button("Max").click();
    expect(field("Stake amount").value).toBe("1482.6383");
    expect(visibleText(body.querySelector(".amount-note"))).toMatch(inOrder("0.3 DUSK", "0.15", "0.15"));
    button("Review stake").click();
    await settle();
    expect([gasFee(), gasTotal()]).toEqual([expect.stringMatching(exactly("0.15 DUSK")), expect.stringMatching(exactly("1,482.7883 DUSK"))]);
  });

  it("sets aside Sozu's fees with custom gas from Settings: its price, and its limit where it clears the call's minimum", async () => {
    // The stake takes the custom 2.5M, its minimum; the unstake Max keeps a fee for, its own 10M.
    const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu() };
    popup(state, ov({ customGas: { limit: "2500000", price: "3" } }));
    button("Max").click();
    expect(field("Stake amount").value).toBe("1482.9008");
    button("Review stake").click();
    await settle();
    expect([gasFee(), gasTotal()]).toEqual([expect.stringMatching(exactly("0.0075 DUSK")), expect.stringMatching(exactly("1,482.9083 DUSK"))]);
    expect(confirm().disabled).toBe(false);
  });

  it("has no minimum for adding to a stake, and drafts Max as a top-up", () => {
    const state = {
      route: "stake",
      staking: staking(owner({ hasStake: true, ownerKind: "self", info: related().info }), { screen: "native" }),
    };
    popup(state);
    typeInto(field("Amount to add"), "5");
    expect(body.querySelector(".amount-field__error").hidden).toBe(true);
    expect(button("Use 1,000")).toBeUndefined();
    button("Max").click();
    button("Review stake").click();
    expect(state.stakeDraft).toMatchObject({ kind: "stake", amountMode: "max", hasStake: true });
  });

  it("drafts the stake for the owner chosen under Advanced", () => {
    const state = { route: "stake", staking: staking(owner(), { screen: "native" }) };
    popup(state);
    const select = body.querySelector("#stake-owner-profile");
    select.value = "1";
    select.dispatchEvent({ type: "change", bubbles: true, target: select, preventDefault() {}, stopPropagation() {} });
    typeInto(field("Stake amount"), "1000");
    button("Review stake").click();
    expect(state.stakeDraft).toMatchObject({ kind: "stake", profileIndex: 0, ownerProfileIndex: 1 });
  });
});

describe("staking with little or nothing", () => {
  it("keeps Review off when the profile can't pay the network fee, and says how much is short", () => {
    const empty = owner({ publicBalance: { value: "0" } });
    popup({ route: "stake", staking: staking(empty, { screen: "native" }) });
    expect(visibleText(body.querySelector(".amount-note"))).toMatch(exactly("0.05 DUSK"));
    expect(button("Review stake").disabled).toBe(true);
  });

  it("keeps Max to the 4 decimals amounts show with, and below what's there", () => {
    expect(maxAmountLux(1_480_550_766_286n, 100_000_000n)).toBe(1_480_450_700_000n);
    expect(maxAmountLux(50_000_000n, 100_000_000n)).toBe(0n);
    // 1,480.550766286 DUSK, less 0.05 for this fee and 0.05 to unstake later.
    popup({ route: "stake", staking: staking(owner({ publicBalance: { value: "1480550766286" } }), { screen: "native" }) });
    button("Max").click();
    expect(field("Stake amount").value).toBe("1480.4507");
    expect(button("Review stake").disabled).toBe(false);
  });
});

describe("staking reviews", () => {
  const named = () => ov({ accounts: [ACCOUNT, OTHER] });
  // What a row names, each on its own: the wallet, the profile, and which balance.
  const names = (label, ...parts) => {
    for (const part of parts) expect(rowValue(label)).toMatch(part instanceof RegExp ? part : standalone(part));
  };

  it("name the profile as the header does, and repeat that it needs your own node", async () => {
    lookupPrimaryName.mockImplementation(async (account) => (account === ACCOUNT ? "alice.dusk" : null));
    const state = { route: "stake", staking: staking(owner(), { screen: "native" }) };
    popup(state, named());
    typeInto(field("Stake amount"), "1000");
    button("Review stake").click();
    await settle();
    // From the profile's public balance, by the profile's name.
    names("From", "alice.dusk", /public/i);
    expect(rowValue("From")).not.toMatch(/shielded/i);
    expect(visibleText(body)).not.toContain("Profile 1");
    expect(visibleText(body.querySelector(".row > .group.info"))).toMatch(/node/i);
  });

  it("show what's staked to the last lux, as it will go", async () => {
    popup({ route: "stake", staking: staking(owner(), { screen: "native" }) }, named());
    typeInto(field("Stake amount"), "1000.123456789");
    button("Review stake").click();
    await settle();
    expect(visibleText(body.querySelector(".balance-amount"))).toBe("1,000.123456789 DUSK");
  });

  it("name the wallet beside the profile with more than one wallet", async () => {
    lookupPrimaryName.mockImplementation(async (account) => (account === ACCOUNT ? "alice.dusk" : null));
    const two = () => ov({ accounts: [ACCOUNT, OTHER], wallets: [{ key: "w1", n: 1, active: false }, { key: "w2", n: 2, name: "Savings", active: true }] });

    popup({ route: "stake", staking: staking(owner(), { screen: "native" }) }, two());
    typeInto(field("Stake amount"), "1000");
    button("Review stake").click();
    await settle();
    names("From", "Savings", "alice.dusk");

    popup({ route: "stake", staking: staking(owner({ relatedStakes: [related()] })) }, two());
    button("Unstake").click();
    await settle();
    names("To", "Savings", "Profile 2");
    names("Owner", "alice.dusk");

    const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu({ position: { poolBalanceLux: dusk(12), stDuskBalanceLux: dusk(4) } }) };
    const app = popup(state, two());
    typeInto(field("Stake amount"), "50");
    button("Review stake").click();
    await settle();
    names("From", "Savings", "alice.dusk");
    state.route = "stake";
    state.sozu.action = "withdraw";
    app.draw();
    typeInto(field("Unstake amount"), "5");
    button("Review unstake").click();
    await settle();
    names("To", "Savings", "alice.dusk");
  });

  // Lena's: the unstake's Review said "Total up to 0.01 DUSK" for the 0.1 DUSK coming back.
  it("say what an unstake or a claim brings back, the fee apart and never a total of the fee alone, with balances hidden too", async () => {
    // The fee, and the row under it: what comes back, never the fee again as a total. With balances hidden the same:
    // a Review shows what it moves, the head and its button too.
    for (const overview of [named(), ov({ hideBalances: true })]) {
      for (const [label, back, verb] of [
        ["Unstake", "2,000 DUSK", "Unstake"],
        ["Claim rewards", "42 DUSK", "Claim"],
      ]) {
        popup({ route: "stake", staking: staking(owner({ relatedStakes: [related()] })) }, overview);
        button(label).click();
        await settle();
        expect([gasFee(), gasTotal()]).toEqual([expect.stringMatching(exactly("0.05 DUSK")), expect.stringMatching(exactly(back))]);
        expect([visibleText(body.querySelector(".balance-amount")), visibleText(confirm())]).toEqual([back, `${verb} ${back}`]);
      }
    }

    // From Sozu, balances hidden: what's typed comes back, and what Max filled in, shown alike.
    const liquid = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu({ action: "withdraw", position: { poolBalanceLux: dusk(12), stDuskBalanceLux: dusk(4) } }) };
    const app = popup(liquid, ov({ hideBalances: true }));
    typeInto(field("Unstake amount"), "5");
    button("Review unstake").click();
    await settle();
    expect([gasFee(), gasTotal()]).toEqual([expect.stringMatching(exactly("0.01 DUSK")), expect.stringMatching(exactly("5 DUSK"))]);
    liquid.route = "stake";
    app.draw();
    button("Max").click();
    expect(field("Unstake amount").value).toBe("12");
    button("Review unstake").click();
    await settle();
    expect([gasFee(), gasTotal()]).toEqual([expect.stringMatching(exactly("0.01 DUSK")), expect.stringMatching(exactly("12 DUSK"))]);
    expect(visibleText(confirm())).toBe("Unstake 12 DUSK");
  });

  it("name another owner", async () => {
    const state = { route: "stake", staking: staking(owner({ relatedStakes: [related()] })) };
    popup(state, named());
    button("Unstake").click();
    await settle();
    names("To", "Profile 2", /public/i);
    names("Owner", "Profile 1");
    // No node warning to unstake.
    expect(body.querySelector(".row > .group.info")).toBeNull();
  });

  it("say on Sozu's what it's worth now and how the DUSK comes back, its contract under Custom fee", async () => {
    lookupPrimaryName.mockResolvedValue("alice.dusk");
    const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu({ position: { poolBalanceLux: dusk(12), stDuskBalanceLux: dusk(4) } }) };
    const app = popup(state, named());
    typeInto(field("Stake amount"), "50");
    button("Review stake").click();
    await settle();
    // What it gets, and what that's worth now, in its own row.
    expect(reviewValue(/stDUSK/)).toMatch(inOrder("16.2357 stDUSK", "49.875 DUSK"));
    // The contract it calls, to check before Confirm: its ID as written, whole in its title, and whole with Copy.
    const pool = "72".repeat(32);
    const contract = body.querySelector(".sozu-contract");
    const id = contract.querySelector(".mono");
    expect([visibleText(id), id.title]).toEqual([`${pool.slice(0, 6)}…${pool.slice(-6)}`, pool]);
    contract.querySelector("button").click();
    await settle();
    expect(dom.clipboard.writeText).toHaveBeenLastCalledWith(pool);

    state.route = "stake";
    state.sozu.action = "withdraw";
    app.draw();
    typeInto(field("Unstake amount"), "5");
    button("Review unstake").click();
    await settle();
    names("To", "alice.dusk", /public/i);
    // The DUSK comes back at once, with no Sozu fee: said in its own words, which are the app's.
    const unstakeLine = body.querySelectorAll(".row > .stake-cap").map(visibleText).find((cap) => /no sozu fee/i.test(cap));
    expect(unstakeLine).toMatch(/same transaction/i);
    expect(unstakeLine).toBe(SOZU_UNSTAKE_LINE);
  });
});

describe("a stake with Sozu in figures", () => {
  const PILOT = networks.testnet.sozu.fallbacks.pool;
  const HEIGHT = 4_700_000;
  // The profile's history as Activity keeps it, read as Liquid staking asks for it whole.
  const activityOf = (overview, history, over = {}) => ({
    key: activityKey(overview),
    account: ACCOUNT,
    profileIndex: 0,
    entries: [],
    names: new Map(),
    shielded: [],
    epoch: Promise.resolve(1),
    history: {
      sync: vi.fn(async () => ({})),
      read: vi.fn(async () => ({ entries: history, state: { finalized: HEIGHT + 100 }, complete: true, coveredTo: 0 })),
      needsDetails: () => false,
      fillDetails: vi.fn(async () => {}),
    },
    ...over,
  });
  const held = { position: { poolBalanceLux: dusk(120), stDuskBalanceLux: dusk(39) } };
  // The years listed; and a year's line of one kind, found by the word its label has (claimed, grown, taken out): what
  // it says after its label, as written.
  const KINDS = { claimed: /claimed/i, sozuGrown: /grown/i, sozu: /taken out/i };
  const yearsListed = () => body.querySelectorAll(".stake-years .kv-label").map(visibleText);
  const yearLine = (year, kind) => {
    const row = body.querySelectorAll(".stake-years .kv").find((kv) => visibleText(kv.querySelector(".kv-label")) === String(year));
    const line = row?.querySelectorAll(".stake-year-part").map(visibleText).find((text) => text.includes(": ") && KINDS[kind].test(text.slice(0, text.indexOf(": "))));
    return line?.slice(line.indexOf(": ") + 2);
  };

  // Lena's wish: staking rewards per tax year.
  it("says the rewards of each calendar year on Staking, newest first: native rewards claimed, from the whole history", async () => {
    const overview = ov();
    const claim = (n, lux, at) => entryOf({ hash: String(n).repeat(64).slice(0, 64), kind: "withdraw_reward", counterparty: networks.testnet.contracts.stake, direction: "in", payer: true, value: lux, fee: "5000000", blockHeight: HEIGHT + n, timestamp: at });
    const history = [claim(1, dusk(12), Date.UTC(2025, 5, 1, 12)), claim(2, "500000000", Date.UTC(2025, 11, 31, 12)), claim(3, dusk(3), Date.UTC(2026, 2, 1, 12))];
    const state = { route: "stake", staking: staking(owner()), sozu: sozu(held), activity: activityOf(overview, history) };
    popup(state, overview);
    await vi.waitFor(() => expect(yearsListed()).toEqual(["2026", "2025"]));
    // Each in its own year: 3 DUSK in 2026; 12 and 0.5 in 2025, the last on its last day.
    expect([yearLine(2026, "claimed"), yearLine(2025, "claimed")]).toEqual(["3 DUSK", "12.5 DUSK"]);

    // Hidden with the other balances.
    popup(state, ov({ hideBalances: true }));
    expect([hiddenFigure(yearLine(2026, "claimed")), hiddenFigure(yearLine(2025, "claimed"))]).toEqual([true, true]);
  });

  // Lena's: 2026 said 0.0062 DUSK with Sozu, and Sozu "Rewards so far 0.0295".
  describe("Sozu's part of each year, as app-core works it out", () => {
    // What the pool's events and the token's burn hold, as the archive lists a
    // block's transactions: u64s little-endian, the account a key's tag and 193 bytes.
    const u64 = (n) => Array.from({ length: 8 }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, "0")).join("");
    const key = `01${"ab".repeat(193)}`;
    const poolEvent = (topic, figures) => ({ target: PILOT, topic, data: `${figures.map(u64).join("")}${key}${"00".repeat(6)}` });
    const burn = (lux) => ({ target: ST_DUSK, topic: "transfer", data: `${u64(lux)}${key}${"00".repeat(33)}${"00".repeat(161)}${"00".repeat(4)}` });
    const move = (hash, fnName, lux, blockHeight, timestamp) =>
      entryOf({ hash, kind: "contract_call", contractId: PILOT, counterparty: PILOT, fnName, direction: fnName === "sozu_stake" ? "out" : "in", payer: true, value: lux, fee: "5000000", blockHeight, timestamp });
    // The archive: each stake's and unstake's events by its block; nothing of
    // the pool's restakes, so a new year's rate can't be read.
    const archiveWith = (events) => async (text) =>
      Object.fromEntries([...String(text).matchAll(/(h\d+): moonlightHistory\([^)]*?fromBlock: (\d+)/g)].map(([, alias, height]) => [alias, { json: events[height] ?? [] }]));
    // Sozu's status as the engine reads it, with what's held and its worth now.
    const holding = (stDusk, worth) => {
      const st = sozu({ position: { poolBalanceLux: String(worth), stDuskBalanceLux: String(stDusk) } });
      st.status = { ...st.status, position: st.position };
      return st;
    };
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.UTC(2026, 10, 11, 12));
    });

    it("says what grew while held and what unstaking took out, from the pool's events and Sozu's status", async () => {
      const [staked, unstaked] = ["5a".repeat(32), "5b".repeat(32)];
      // 100 DUSK staked at 2 DUSK an stDUSK, 0.25 deposit fee: 49.875 stDUSK. 15 of
      // them unstaked at 2.02: 30.3 DUSK back, 0.2248 over what they cost with their part of the fee. 34.875 left, worth 2.04 each now.
      archive.query = archiveWith({
        4800001: [{ origin: staked, events: [poolEvent("deposit", [100_000_000_000n, 250_000_000n, 2_000_000_000_000n, 1_000_000_000_000n])] }],
        4800002: [{ origin: unstaked, events: [poolEvent("unstake", [0n, 30_300_000_000n, 2_020_000_000_000n, 1_000_000_000_000n]), burn(15_000_000_000n)] }],
      });
      const overview = ov();
      const history = [move(staked, "sozu_stake", "100000000000", 4_800_001, Date.UTC(2026, 2, 1, 12)), move(unstaked, "sozu_unstake", "30300000000", 4_800_002, Date.UTC(2026, 5, 1, 12))];
      popup({ route: "stake", staking: staking(owner()), sozu: holding(34_875_000_000n, 71_145_000_000n), activity: activityOf(overview, history) }, overview);
      // Held from March at 2 to June at 2.02 (49.875 stDUSK), then on to now at 2.04 (34.875): 0.9975 and 0.6975,
      // less the stake's 0.25 deposit fee, the cost unstaking counts too (Lena's and Nandini's: two cost bases), which
      // the line says, as the card's rewards are before it. Each in its own line.
      await vi.waitFor(() => expect([yearLine(2026, "sozuGrown"), yearLine(2026, "sozu")]).toEqual(["1.445 DUSK", "0.2248 DUSK"]));
      // Lena's: the two lines read as two rewards to add. Under them, in both wallets' words, that one is part of the other, and how it's counted.
      const counted = visibleText(body.querySelector(".stake-years-counted"));
      expect(counted).toMatch(/taken out by unstaking is part of grown while held/i);
      expect(counted).toBe(REWARDS_COUNTED);
    });

    // With Hide balances, what's held with Sozu is a balance looked at, as Staking's are: hidden on Liquid staking's
    // card and in its history under Details, deposits open or paused, with no tooltip to give it away, nor a loss's
    // sign. The forms under it show theirs, as they're used.
    it("hides what's held on Liquid staking's card and in its history with Hide balances, a loss's sign too, deposits open or paused, while its forms show theirs", async () => {
      const staked = "5c".repeat(32);
      archive.query = archiveWith({ 4800021: [{ origin: staked, events: [poolEvent("deposit", [100_000_000_000n, 250_000_000n, 2_000_000_000_000n, 1_000_000_000_000n])] }] });
      const history = [move(staked, "sozu_stake", "100000000000", 4_800_021, Date.UTC(2026, 2, 1, 12))];
      // 100 DUSK put in for 49.875 stDUSK, worth 90 DUSK now: a loss.
      const liquid = (overview, maintenance) => {
        const st = holding(49_875_000_000n, 90_000_000_000n);
        st.status = { ...st.status, features: { maintenance, synchronization: false } };
        return { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: st, activity: activityOf(overview, history) };
      };
      // All a part says: its text, its tooltips and its labels.
      const said = (el) => [el.textContent, ...[el, ...el.querySelectorAll("*")].flatMap((n) => [n.getAttribute("title"), n.getAttribute("aria-label")])].filter(Boolean).join(" ");
      const earned = () => body.querySelectorAll(".sozu-history .kv").find((kv) => visibleText(kv.querySelector(".kv-label")) === "Rewards so far, before deposit fees")?.querySelector(".kv-value");

      // Shown, the position's a loss, its sign before it.
      popup(liquid(ov(), false), ov());
      await vi.waitFor(() => expect(visibleText(earned())).toMatch(/^−\d/));

      const overview = ov({ hideBalances: true });
      for (const maintenance of [false, true]) {
        const state = liquid(overview, maintenance);
        const app = popup(state, overview);
        await vi.waitFor(() => expect(hiddenFigure(rowValue("Rewards so far, before deposit fees"))).toBe(true));
        for (const label of ["Worth now", "stDUSK", "Put in", "Rewards so far, before deposit fees"]) expect(hiddenFigure(rowValue(label)), `${label}, paused: ${maintenance}`).toBe(true);
        expect([said(body.querySelector(".sozu-position")), said(body.querySelector(".sozu-history"))]).toEqual([expect.not.stringMatching(/\d/), expect.not.stringMatching(/\d/)]);
        expect([visibleText(earned()), screenReaderText(earned())]).toEqual([expect.not.stringMatching(/[−-]/), expect.not.stringMatching(/[−-]/)]);
        // The stake's form: what's available, as Send says it.
        expect(visibleText(body.querySelector(".amount-avail > span"))).toMatch(exactly("1,482.9383 DUSK"));
        // The unstake's: what's staked with Sozu, which Max fills in.
        state.sozu.action = "withdraw";
        app.draw();
        expect(visibleText(body.querySelector(".amount-avail > span"))).toMatch(exactly("90 DUSK"));
        button("Max").click();
        expect(field("Unstake amount").value).toBe("90");
        expect(said(body.querySelector(".sozu-position"))).not.toMatch(/\d/);
      }
    });

    // Lena's: what unstaking took out is a figure for a tax return, its deposit fee counted as part of the cost; a stake
    // and its unstake at one rate then lose that fee, which is said as the loss it is, never hidden as nothing.
    it("says a year where unstaking didn't make up the deposit fee as a loss, with its minus sign, in DUSK and in the currency", async () => {
      vi.stubGlobal("navigator", { ...globalThis.navigator, language: "en-US" });
      const prices = [[Date.UTC(2026, 2, 1, 12), 0.07], [Date.UTC(2026, 2, 2, 12), 0.07]];
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ prices }), { headers: { "content-type": "application/json" } })));
      const [staked, unstaked] = ["6a".repeat(32), "6b".repeat(32)];
      // 100 DUSK staked at 2 with a 0.1 fee: 49.95 stDUSK; all unstaked at 2: 99.9 back, 0.1 less than they cost.
      archive.query = archiveWith({
        4800011: [{ origin: staked, events: [poolEvent("deposit", [100_000_000_000n, 100_000_000n, 2_000_000_000_000n, 1_000_000_000_000n])] }],
        4800012: [{ origin: unstaked, events: [poolEvent("unstake", [0n, 99_900_000_000n, 2_000_000_000_000n, 1_000_000_000_000n]), burn(49_950_000_000n)] }],
      });
      const overview = ov();
      const history = [move(staked, "sozu_stake", "100000000000", 4_800_011, Date.UTC(2026, 2, 1, 12)), move(unstaked, "sozu_unstake", "99900000000", 4_800_012, Date.UTC(2026, 2, 2, 12))];
      const state = { route: "stake", staking: staking(owner()), sozu: holding(0n, 0n), activity: activityOf(overview, history) };
      popup(state, overview);
      // Nandini's: "grown while held 0" beside "taken out −0.0005": the loss shows in both now, one part of the other.
      await vi.waitFor(() => expect([yearLine(2026, "sozuGrown"), yearLine(2026, "sozu")]).toEqual(["−0.1 DUSK", "−0.1 DUSK"]));

      // Its worth: under a cent, a loss all the same, never $0.00.
      body.querySelector("#stake-years-value").checked = true;
      body.querySelector("#stake-years-value").dispatchEvent(new Event("change"));
      const lossUnderACent = expect.stringMatching(/^−0\.1 DUSK[\s\S]*\bloss\b[\s\S]*(?:under|<)\s*\$0\.01(?![\dA-Za-z]|[.,]\d)/);
      await vi.waitFor(() => expect([yearLine(2026, "sozuGrown"), yearLine(2026, "sozu")]).toEqual([lossUnderACent, lossUnderACent]));
      expect([yearLine(2026, "sozuGrown"), yearLine(2026, "sozu")].join(" ")).not.toMatch(/\$0\.00/);
    });
  });
});

describe("liquid staking", () => {
  it("says Sozu's deposit fee before and as an amount is typed, and takes it off what the stake gets and is worth", () => {
    const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu() };
    popup(state);
    expect(visibleText(body.querySelector(".stake-estimate"))).toBe("");
    expect(visibleText(body.querySelector(".sozu-terms"))).toMatch(exactly("0.25%"));
    typeInto(field("Stake amount"), "100");
    expect(visibleText(body.querySelector(".sozu-terms"))).toMatch(inOrder("0.25%", "0.25 DUSK"));
    // What it gets, and what that's worth now.
    expect(visibleText(body.querySelector(".stake-estimate"))).toMatch(inOrder("32.4714 stDUSK", "99.75 DUSK"));
    // Sozu's fees as read: its share of rewards in its fact's title, its deposit fee under it; and the network fee.
    expect([factPart(/sozu/i, ".row-title"), factPart(/sozu/i, ".row-sub"), factPart(/fee/i, ".row-title")]).toEqual([
      expect.stringMatching(exactly("10%")),
      expect.stringMatching(exactly("0.25%")),
      expect.stringMatching(exactly("0.005 DUSK")),
    ]);

    // Mainnet's fees, as its substrate gives them.
    state.sozu.status.fees = { deposit: { numerator: "1", denominator: "400" }, reward: { numerator: "15", denominator: "100" } };
    popup(state);
    expect([factPart(/sozu/i, ".row-title"), factPart(/sozu/i, ".row-sub")]).toEqual([expect.stringMatching(exactly("15%")), expect.stringMatching(exactly("0.25%"))]);
    expect(factPart(/sozu/i, ".row-title")).not.toMatch(exactly("10%"));
  });

  it("says what Max keeps of a stake, as native staking does, and on Review the deposit fee it pays", async () => {
    const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu() };
    popup(state);
    const maxNote = () => {
      const note = body.querySelector(".sozu-max");
      return note && isShown(note) ? visibleText(note) : "";
    };
    button("Max").click();
    expect(maxNote()).toMatch(inOrder("0.015 DUSK", "0.005", "0.01"));
    // An amount typed instead keeps nothing back.
    typeInto(field("Stake amount"), "100");
    expect(maxNote()).toBe("");
    button("Review stake").click();
    await settle();
    expect(rowValue("Deposit fee")).toMatch(exactly("0.25 DUSK"));
  });

  it("refuses a stake under the least that gets stDUSK at the rate now, after the fee", () => {
    const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu() };
    popup(state);
    // 1 lux: the fee takes all of it, and Sozu's pool would refuse it.
    for (const tooLittle of ["0.000000001", "0.000000004"]) {
      typeInto(field("Stake amount"), tooLittle);
      expect(body.querySelector(".amount-field__error").textContent).toMatch(exactly("0.000000005 DUSK"));
      expect(button("Review stake").disabled).toBe(true);
    }
    typeInto(field("Stake amount"), "0.000000005");
    expect(body.querySelector(".amount-field__error").hidden).toBe(true);
    expect(visibleText(body.querySelector(".stake-estimate"))).toMatch(inOrder("0.000000001 stDUSK", "0.000000004 DUSK"));
    expect(button("Review stake").disabled).toBe(false);
  });

  it("keeps a stake off until Sozu's fees are read, and says so", () => {
    const status = { ...sozu().status, fees: null };
    const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu({ status }) };
    popup(state);
    // No deposit fee it hasn't read.
    expect(visibleText(body.querySelector(".sozu-terms"))).not.toMatch(/\d/);
    typeInto(field("Stake amount"), "5");
    const error = body.querySelector(".amount-field__error");
    expect([isShown(error), error.textContent]).toEqual([true, expect.stringMatching(/couldn't be read/i)]);
    expect(button("Review stake").disabled).toBe(true);
  });

  it("turns staking off while Sozu has paused deposits, keeps unstaking, and warns while its pool is synchronizing", async () => {
    const status = { ...sozu().status, features: { maintenance: true, synchronization: false } };
    const state = {
      route: "stake",
      staking: staking(owner(), { screen: "liquid" }),
      sozu: sozu({ status, position: { poolBalanceLux: dusk(12), stDuskBalanceLux: dusk(4) } }),
    };
    const app = popup(state);
    // Said, by its key word: paused, or synchronizing.
    const warns = (selector, said) => {
      const el = body.querySelector(selector);
      return Boolean(el) && said.test(visibleText(el));
    };
    expect(warns(".sozu-paused", /paused/i)).toBe(true);
    expect(field("Stake amount").disabled).toBe(true);
    expect(button("Max").disabled).toBe(true);
    expect(button("Review stake").disabled).toBe(true);
    expect(body.querySelector(".sozu-sync")).toBeNull();

    state.sozu.action = "withdraw";
    app.draw();
    expect(body.querySelector(".sozu-paused")).toBeNull();
    typeInto(field("Unstake amount"), "5");
    expect(button("Review unstake").disabled).toBe(false);

    // Synchronizing: a call can fail.
    status.features = { maintenance: false, synchronization: true };
    app.draw();
    expect(warns(".sozu-sync", /synchroniz/i)).toBe(true);
    button("Review unstake").click();
    await settle();
    expect(warns(".sozu-sync", /synchroniz/i)).toBe(true);
    expect(confirm().disabled).toBe(false);

    // Paused after a stake was drafted: its Review says so, and Confirm stays off.
    state.route = "stake";
    state.sozu.action = "deposit";
    app.draw();
    typeInto(field("Stake amount"), "5");
    button("Review stake").click();
    await settle();
    status.features = { maintenance: true, synchronization: false };
    app.draw();
    expect(warns(".review-actions > .field-error", /paused/i)).toBe(true);
    expect(confirm().disabled).toBe(true);
  });

  it("sends a stake with 5M gas and an unstake with 10M at the node's price, never under 2.5M and 4M, nor at the contract call default", async () => {
    const liquid = (action) => ({
      route: "stake",
      staking: staking(owner(), { screen: "liquid" }),
      sozu: sozu({ action, position: { poolBalanceLux: dusk(12), stDuskBalanceLux: dusk(4) } }),
    });
    const sentGas = (app) => app.actions.send.mock.calls.map(([m]) => m).find((m) => m.type === "DUSK_UI_SEND_TX")?.params.gas;

    let app = popup(liquid("deposit"));
    typeInto(field("Stake amount"), "5");
    button("Review stake").click();
    await settle();
    let editor = body.querySelector("dusk-gas-editor");
    expect(String(editor.minLimit)).toBe("2500000");
    expect([gasFee(), gasTotal()]).toEqual([expect.stringMatching(exactly("0.005 DUSK")), expect.stringMatching(exactly("5.005 DUSK"))]);
    // Fields left empty send the stake's own gas.
    editor.setGas(null);
    confirm().click();
    await settle();
    expect(sentGas(app)).toEqual({ limit: "5000000", price: "1" });

    app = popup(liquid("withdraw"));
    typeInto(field("Unstake amount"), "5");
    button("Review unstake").click();
    await settle();
    editor = body.querySelector("dusk-gas-editor");
    expect(String(editor.minLimit)).toBe("4000000");
    // Lena's: "Total up to 0.01 DUSK" for the 5 coming back. What comes back, the fee apart.
    expect([gasFee(), gasTotal()]).toEqual([expect.stringMatching(exactly("0.01 DUSK")), expect.stringMatching(exactly("5 DUSK"))]);
    confirm().click();
    await settle();
    expect(sentGas(app)).toEqual({ limit: "10000000", price: "1" });
  });

  it("reads Sozu's terms again before sending a stake, and shows them for another Confirm when they changed", async () => {
    const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu() };
    // What the node says when Confirm is pressed.
    let now = { ...sozu().status, pool: sozu().pool, position: sozu().position };
    const app = popup(state, ov(), { sozuStatus: () => now });
    const sent = () => app.actions.send.mock.calls.map(([m]) => m).filter((m) => m.type === "DUSK_UI_SEND_TX");
    typeInto(field("Stake amount"), "100");
    button("Review stake").click();
    await settle();
    // What it gets and its worth now, in their row; the deposit fee, as a rate and in DUSK, in its own.
    const terms = () => [reviewValue(/stDUSK/), rowValue("Deposit fee")];
    const said = (gets, worth, rate, fee) => [expect.stringMatching(inOrder(gets, worth)), expect.stringMatching(allOf(rate, fee))];
    expect(terms()).toEqual(said("32.4714 stDUSK", "99.75 DUSK", "0.25%", "0.25 DUSK"));

    // Sozu's manager raises the deposit fee to 5% meanwhile: nothing is sent, and the new figures show.
    now = { ...now, fees: { ...now.fees, deposit: { numerator: "5", denominator: "100" } } };
    confirm().click();
    await settle();
    expect(sent()).toEqual([]);
    expect(visibleText(body.querySelector(".sozu-changed"))).toMatch(/terms changed/i);
    expect(terms()).toEqual(said("30.9251 stDUSK", "95 DUSK", "5%", "5 DUSK"));

    // A Confirm pressed at once isn't for the new figures: it does nothing.
    confirm().click();
    await settle();
    expect(sent()).toEqual([]);

    // Confirmed again on those terms, a moment on: sent, and only the call goes.
    pastClickGuard();
    confirm().click();
    await settle();
    expect(sent()).toHaveLength(1);
    expect(sent()[0].params).toMatchObject({ fnName: "sozu_stake", deposit: dusk(100), contractId: POOL });
    expect(sent()[0].params).not.toHaveProperty("termsChanged");
  });

  it("doesn't send a stake when Sozu's terms can't be read again, or deposits were paused since its Review", async () => {
    const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu() };
    let now = null;
    const app = popup(state, ov(), { sozuStatus: () => now });
    const sent = () => app.actions.send.mock.calls.map(([m]) => m).filter((m) => m.type === "DUSK_UI_SEND_TX");
    const errors = () => body.querySelectorAll(".review-actions > .field-error").filter(isShown).map((e) => e.textContent);
    typeInto(field("Stake amount"), "100");
    button("Review stake").click();
    await settle();

    // Not read: said, that nothing was sent, and Confirm stays on to try again.
    confirm().click();
    await settle();
    expect(sent()).toEqual([]);
    expect(errors()).toEqual([expect.stringMatching(/nothing was sent/i)]);
    expect(confirm().disabled).toBe(false);

    // Paused: said, and Confirm goes off.
    now = { ...sozu().status, pool: sozu().pool, features: { maintenance: true, synchronization: false } };
    confirm().click();
    await settle();
    expect(sent()).toEqual([]);
    expect(errors()).toEqual([expect.stringMatching(/paused/i)]);
    expect(confirm().disabled).toBe(true);
  });

  describe("a stake whose check of Sozu's terms answers late", () => {
    // Review of a 100 DUSK stake, Confirm pressed, and Sozu's status held back
    // until `answer` gives it: unchanged unless told otherwise.
    async function lateCheck() {
      const overview = ov();
      const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu(), overview };
      let release;
      const held = new Promise((resolve) => (release = resolve));
      const app = popup(state, overview, { sozuStatus: () => held });
      typeInto(field("Stake amount"), "100");
      button("Review stake").click();
      await settle();
      const draft = state.sozuDraft;
      confirm().click();
      await settle();
      const messages = (type) => app.actions.send.mock.calls.map(([m]) => m).filter((m) => m.type === type);
      return {
        state,
        app,
        draft,
        reads: () => messages("DUSK_UI_GET_SOZU_STATUS").length,
        sent: () => messages("DUSK_UI_SEND_TX"),
        // Back on the stake's form, with the amount typed for the Review, and why.
        backOnForm: (notice) => {
          expect([state.route, state.staking.screen, state.sozuDraft]).toEqual(["stake", "liquid", null]);
          noticeSays(notice);
          expect(field("Stake amount").value).toBe("100");
        },
        answer: async (over = {}) => {
          release({ ...sozu().status, pool: sozu().pool, position: sozu().position, ...over });
          await settle();
        },
      };
    }

    it("sends nothing when Review is left before the answer comes", async () => {
      const t = await lateCheck();
      expect(t.reads()).toBe(1);
      body.querySelector(".subnav-back").click();
      expect(t.state.route).toBe("stake");
      await t.answer();
      expect(t.sent()).toEqual([]);
      expect(t.state.route).toBe("stake");
    });

    it("sends nothing for a stake whose Review another one took the place of meanwhile", async () => {
      const t = await lateCheck();
      body.querySelector(".subnav-back").click();
      typeInto(field("Stake amount"), "50");
      button("Review stake").click();
      await settle();
      expect(t.state.sozuDraft).not.toBe(t.draft);
      await t.answer();
      expect(t.sent()).toEqual([]);
      // The new stake's own Review stays, its Confirm free to press.
      expect(t.state.route).toBe("sozu_confirm");
      expect(visibleText(body.querySelector(".review-head .balance-amount"))).toBe("50 DUSK");
      expect(confirm().disabled).toBe(false);
    });

    it.each([
      ["the network changes", { nodeUrl: "https://nodes.dusk.network", networkName: "Mainnet" }, SWITCHED],
      ["the profile changes", { selectedAccountIndex: 1 }, SWITCHED],
      ["the wallet locks", { isUnlocked: false }, LOCKED],
    ])("sends nothing when %s before the answer comes, and goes back to the stake to say so", async (_, change, notice) => {
      const t = await lateCheck();
      t.state.overview = ov(change);
      await t.answer();
      expect(t.sent()).toEqual([]);
      t.backOnForm(notice);
    });

    it("sends nothing when a switch starts before the answer comes, though the overview still names the Review's network", async () => {
      const t = await lateCheck();
      // The header's switch has begun: the wallet may be on the new network
      // already, while the overview is still being read again.
      switchContext(t.state);
      await t.answer();
      expect(t.sent()).toEqual([]);
    });

    it("sends nothing when a switch starts as the Sent screen is drawn, and says so", async () => {
      const t = await lateCheck();
      const draw = t.app.actions.render.getMockImplementation();
      t.app.actions.render.mockImplementation(async () => {
        if (t.state.route === "sent") switchContext(t.state);
        return draw();
      });
      await t.answer();
      expect(t.sent()).toEqual([]);
      // Sent says it wasn't sent, in its phase and in its first step's words.
      expect(body.querySelector(".sent").getAttribute("data-phase")).toBe("not_sent");
      expect(visibleText(body.querySelector(".step .step-title"))).toBe("Not sent");
    });

    it("leaves a Review drawn again after a switch at once, and its answer then does nothing", async () => {
      const t = await lateCheck();
      // The switch to Profile 2 is done first, and the popup draws again.
      switchContext(t.state);
      Object.assign(t.state.overview, { selectedAccountIndex: 1 });
      t.app.draw();
      t.backOnForm(SWITCHED);
      expect(confirm()).toBeUndefined();
      await t.answer();
      expect(t.sent()).toEqual([]);
      t.backOnForm(SWITCHED);
    });

    it("goes back to the stake to say so when the answer comes from another network, as one another window switched to", async () => {
      const t = await lateCheck();
      await t.answer({ networkKey: "mainnet" });
      expect(t.sent()).toEqual([]);
      // Not a Confirm that does nothing: the stake's form, the overview read
      // again, the amount kept and checked, and why.
      t.backOnForm(SWITCHED);
      expect(t.state.needsRefresh).toBe(true);
      expect(button("Review stake").disabled).toBe(false);
      // It says so until Staking shows another screen, or the stake is reviewed again.
      body.querySelector(".subnav-back").click();
      buttonStarting("Liquid staking").click();
      expect(t.state.staking.screen).toBe("liquid");
      expect(body.querySelector(".sozu-notice")).toBeNull();
      t.state.sozu.notice = "Nothing was sent.";
      t.app.draw();
      button("Review stake").click();
      expect(t.state.sozu.notice).toBe("");
    });

    it("checks once and sends once however often Confirm is pressed, a redrawn Review's included", async () => {
      const t = await lateCheck();
      confirm().click();
      t.app.draw();
      expect(confirm().disabled).toBe(true);
      confirm().click();
      await settle();
      expect(t.reads()).toBe(1);
      await t.answer();
      expect(t.reads()).toBe(1);
      expect(t.sent()).toHaveLength(1);
      expect(t.sent()[0].params).toMatchObject({ fnName: "sozu_stake", deposit: dusk(100) });
    });
  });

  describe("a stake's Review, drawn again after the popup moved away from where it was drafted", () => {
    const THIRD =
      "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";

    it.each([
      ["a switch to Profile 2", (state) => (switchContext(state), { selectedAccountIndex: 1 }), SWITCHED],
      ["a switch to Mainnet", (state) => (switchContext(state), { nodeUrl: "https://nodes.dusk.network", networkName: "Mainnet" }), SWITCHED],
      ["a lock and an unlock", (state) => (switchContext(state, "lock"), {}), LOCKED],
      ["another wallet unlocked in another window", () => ({ accounts: [THIRD] }), SWITCHED],
    ])("offers no Confirm after %s, and goes back to the stake to say so", async (_, move, notice) => {
      const overview = ov({ accounts: [ACCOUNT, OTHER] });
      const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu(), overview };
      const app = popup(state, overview);
      typeInto(field("Stake amount"), "100");
      button("Review stake").click();
      await settle();
      expect(confirm().disabled).toBe(false);

      // The Review, left idle, is drawn again once the popup moved on: it
      // offers no Confirm, and the stake's form shows instead.
      Object.assign(overview, move(state));
      app.draw();
      expect(confirm()).toBeUndefined();
      expect([state.route, state.staking.screen, state.sozuDraft]).toEqual(["stake", "liquid", null]);
      noticeSays(notice);
      expect(field("Stake amount").value).toBe("100");
      await settle();
      expect(app.actions.send.mock.calls.filter(([m]) => m.type === "DUSK_UI_SEND_TX")).toEqual([]);
    });

    it("leaves a stake drafted on a form drawn before a switch began, at once", async () => {
      const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu() };
      popup(state);
      typeInto(field("Stake amount"), "100");
      // The switch starts while the form shows, and Review stake is pressed
      // before the form is drawn again: its figures are for the old network.
      switchContext(state);
      button("Review stake").click();
      await settle();
      expect(confirm()).toBeUndefined();
      expect([state.route, state.sozuDraft]).toEqual(["stake", null]);
      noticeSays(SWITCHED);
    });
  });

  it("keeps staking off while it can't tell whether Sozu takes deposits, and says so", () => {
    const status = { ...sozu().status, features: { maintenance: null, synchronization: false } };
    const state = {
      route: "stake",
      staking: staking(owner(), { screen: "liquid" }),
      sozu: sozu({ status, position: { poolBalanceLux: dusk(12), stDuskBalanceLux: dusk(4) } }),
    };
    const app = popup(state);
    expect(visibleText(body.querySelector(".sozu-paused"))).toMatch(/couldn't be checked/i);
    expect(field("Stake amount").disabled).toBe(true);
    expect(button("Review stake").disabled).toBe(true);
    state.sozu.action = "withdraw";
    app.draw();
    typeInto(field("Unstake amount"), "5");
    expect(button("Review unstake").disabled).toBe(false);
  });

  it("says on the form when the public balance can't pay an unstake's fee, with how much is missing, before Review", () => {
    const base = sozu({ position: { poolBalanceLux: dusk(1), stDuskBalanceLux: dusk(1) } });
    const status = { ...base.status, publicBalance: { nonce: "0", value: "2863982" } };
    const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: { ...base, status, action: "withdraw" } };
    popup(state);
    typeInto(field("Unstake amount"), "0.1");
    expect(body.querySelector(".amount-field__error").textContent).toMatch(exactly("0.0072 DUSK"));
    expect(button("Review unstake").disabled).toBe(true);
  });

  it("says on an unstake's Review when the fee takes it past the public balance, and keeps Confirm off", async () => {
    const base = sozu({ position: { poolBalanceLux: dusk(1), stDuskBalanceLux: dusk(1) } });
    const status = { ...base.status, publicBalance: { nonce: "0", value: "20000000" } };
    const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: { ...base, status, action: "withdraw" } };
    popup(state);
    typeInto(field("Unstake amount"), "0.1");
    button("Review unstake").click();
    await settle();
    expect(state.route).toBe("sozu_confirm");
    const editor = body.querySelector("dusk-gas-editor");
    editor.setGas({ limit: "10000000", price: "5" });
    await settle();
    expect(body.querySelector(".pay-guard").textContent).toMatch(exactly("0.03 DUSK"));
    expect(confirm().disabled).toBe(true);
  });

  it("says no stake gets stDUSK when Sozu's deposit fee is 100%", () => {
    const status = { ...sozu().status, fees: { ...sozu().status.fees, deposit: { numerator: "1", denominator: "1" } } };
    const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu({ status }) };
    popup(state);
    typeInto(field("Stake amount"), "100");
    expect(body.querySelector(".amount-field__error").textContent).toMatch(/no stake gets stDUSK/i);
    expect(visibleText(body.querySelector(".sozu-terms"))).toMatch(inOrder("100%", "100 DUSK"));
    expect(button("Review stake").disabled).toBe(true);
  });

  it("checks the amount as it is typed, and drafts the stake and the unstake", () => {
    const state = {
      route: "stake",
      staking: staking(owner(), { screen: "liquid" }),
      sozu: sozu({ position: { poolBalanceLux: dusk(12), stDuskBalanceLux: dusk(4) } }),
    };
    const app = popup(state);
    // What's held with Sozu, each in its own row, by the words both wallets give them: its worth now, and its stDUSK.
    expect([rowValue("Worth now"), rowValue("stDUSK")]).toEqual(["12 DUSK", "4 stDUSK"]);
    typeInto(field("Stake amount"), "5000");
    expect(body.querySelector(".amount-field__error").textContent).toMatch(exactly("3,517.0767 DUSK"));
    expect(button("Review stake").disabled).toBe(true);
    button("Max").click();
    expect(field("Stake amount").value).toBe("1482.9233");
    typeInto(field("Stake amount"), "5");
    button("Review stake").click();
    expect(state.sozuDraft).toMatchObject({ kind: "contract_call", fnName: "sozu_stake", amount: "0", deposit: dusk(5) });

    state.route = "stake";
    state.sozu.action = "withdraw";
    app.draw();
    const terms = visibleText(body.querySelector(".sozu-terms"));
    expect(terms).toMatch(/no sozu fee/i);
    expect(terms).toMatch(/same transaction/i);
    expect(terms).toBe(SOZU_UNSTAKE_LINE);
    typeInto(field("Unstake amount"), "13");
    expect(body.querySelector(".amount-field__error").textContent).toMatch(/more than you have staked/i);
    expect(button("Review unstake").disabled).toBe(true);
    button("Max").click();
    expect(field("Unstake amount").value).toBe("12");
    button("Review unstake").click();
    expect(state.sozuDraft).toMatchObject({ fnName: "sozu_unstake", deposit: "0" });
  });

  it("sends the stake as Sozu's call with the deposit typed and its own gas, and nothing of its quote", async () => {
    const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu() };
    const app = popup(state);
    typeInto(field("Stake amount"), "100");
    button("Review stake").click();
    await settle();
    confirm().click();
    await settle();
    const sentTx = app.actions.send.mock.calls.map(([m]) => m).find((m) => m.type === "DUSK_UI_SEND_TX");
    expect(sentTx).toMatchObject({
      params: { kind: "contract_call", fnName: "sozu_stake", profileIndex: 0, deposit: dusk(100) },
      asset: { kind: "sozu", action: "sozu_stake" },
    });
    expect(sentTx.params).not.toHaveProperty("quote");
    expect(sentTx.params.gas).toEqual({ limit: "5000000", price: "1" });
  });

  it("asks the wallet to send a stake or an unstake only on the wallet, profile and network of its Review", async () => {
    const overview = ov({ selectedAccountIndex: 1, accounts: [ACCOUNT, OTHER] });
    for (const [action, amount, review] of [
      ["deposit", "Stake amount", "Review stake"],
      ["withdraw", "Unstake amount", "Review unstake"],
    ]) {
      const state = {
        route: "stake",
        staking: staking(owner(), { screen: "liquid", profileIndex: 1 }),
        sozu: sozu({ action, profileIndex: 1, position: { poolBalanceLux: dusk(12), stDuskBalanceLux: dusk(4) } }),
      };
      const app = popup(state, overview);
      typeInto(field(amount), "5");
      button(review).click();
      await settle();
      confirm().click();
      await settle();
      const sentTx = app.actions.send.mock.calls.map(([m]) => m).find((m) => m.type === "DUSK_UI_SEND_TX");
      expect(sentTx.params).toMatchObject({
        profileIndex: 1,
        _approvalContext: { walletId: ACCOUNT, profileIndex: 1, account: OTHER, nodeUrl: "https://testnet.nodes.dusk.network" },
      });
    }
  });
});

describe("what Max fills in, with Hide balances", () => {
  // Every Max note shown on the form: what Max kept.
  const maxNotes = () => body.querySelectorAll(".amount-note").filter(isShown).map(visibleText).filter((text) => /^Max keeps/.test(text));

  it("shows a Sozu stake's amount, what it gets and what Max kept, on the form and on Review, as with balances shown", async () => {
    // What the form says once Max is pressed, and then its Review, with balances shown or hidden.
    const said = async (overview) => {
      const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu() };
      popup(state, overview);
      button("Max").click();
      const form = [field("Stake amount").value, ...[".amount-avail", ".sozu-terms", ".stake-estimate"].map((part) => visibleText(body.querySelector(part))), maxNotes()];
      button("Review stake").click();
      await settle();
      const review = [visibleText(body.querySelector(".balance-amount")), reviewValue(/stDUSK/), rowValue("Deposit fee"), gasTotal(), visibleText(confirm())];
      return { form, review, sends: state.sozuDraft.fnArgsAmountLux, page: body.textContent };
    };
    const shown = await said(ov());
    const hidden = await said(ov({ hideBalances: true }));
    expect(hidden).toEqual({ ...shown, page: hidden.page });
    expect(hidden.page).not.toContain("••••");
    // Each a figure: all of the public balance but both fees, and what Max kept of it.
    expect(shown.form[0]).toBe("1482.9233");
    expect(shown.form[1]).toMatch(exactly("1,482.9383 DUSK"));
    expect(shown.form[4]).toEqual([expect.stringMatching(exactly("0.015 DUSK"))]);
    expect(shown.review[0]).toBe("1,482.9233 DUSK");
    expect(shown.sends).toBe("1482923300000");
  });

  it("shows a native stake's amount from Max on the form and on Review, through Back and Review again", async () => {
    const state = { route: "stake", staking: staking(owner({ publicBalance: { value: dusk(2000) } }), { screen: "native" }) };
    popup(state, ov({ hideBalances: true }));
    expect(visibleText(body.querySelector(".amount-avail"))).toMatch(exactly("2,000 DUSK"));
    button("Max").click();
    expect(field("Stake amount").value).toBe("1999.9");
    expect(maxNotes()).toEqual([expect.stringMatching(exactly("0.1 DUSK"))]);
    button("Review stake").click();
    await settle();
    expect(visibleText(body.querySelector(".balance-amount"))).toBe("1,999.9 DUSK");
    expect(gasTotal()).toMatch(exactly("1,999.95 DUSK"));
    expect(visibleText(confirm())).toBe("Stake 1,999.9 DUSK");
    expect(state.stakeDraft.amountLux).toBe("1999900000000");

    // And through Back to the form and Review again.
    body.querySelector(".subnav-back").click();
    await settle();
    expect(field("Stake amount").value).toBe("1999.9");
    button("Review stake").click();
    await settle();
    expect(visibleText(body.querySelector(".balance-amount"))).toBe("1,999.9 DUSK");
    expect(body.textContent).not.toContain("••••");
  });
});

describe("a staking Review's Confirm, the moment the Review is up", () => {
  // Each Review, reached as a person does: from Staking, with what's pressed on the way.
  const withStake = () => ({ route: "stake", staking: staking(owner({ relatedStakes: [related()] })) });
  const liquid = (over) => ({ route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu(over) });
  const amount = (name, value, review) => () => {
    typeInto(field(name), value);
    button(review).click();
  };
  it.each([
    ["Stake", () => ({ route: "stake", staking: staking(owner(), { screen: "native" }) }), amount("Stake amount", "1000", "Review stake")],
    ["Unstake", withStake, () => button("Unstake").click()],
    ["Claim rewards", withStake, () => button("Claim rewards").click()],
    ["Liquid staking", () => liquid(), amount("Stake amount", "100", "Review stake")],
    ["Unstake from Sozu", () => liquid({ action: "withdraw", position: { poolBalanceLux: dusk(12), stDuskBalanceLux: dusk(4) } }), amount("Unstake amount", "5", "Review unstake")],
  ])("ignores a click, as a double-click on the way lands there, and sends one a moment later (%s)", async (_, start, toReview) => {
    const state = start();
    const app = popup(state);
    toReview();
    await settle();
    // Up, as app.js marks a new screen.
    screenShown();
    const review = state.route;
    expect(["stake_confirm", "sozu_confirm"]).toContain(review);
    const sends = () => app.actions.send.mock.calls.filter(([m]) => m.type === "DUSK_UI_SEND_TX");

    confirm().click();
    await settle();
    expect([sends(), state.route, confirm().disabled]).toEqual([[], review, false]);

    pastClickGuard();
    confirm().click();
    await settle();
    expect(sends()).toHaveLength(1);
    expect(state.route).toBe("sent");
  });
});

describe("a staking Review's default gas price", () => {
  // Lena's, three rounds: the extension's unstake paid gas price 2 where the web wallet's paid 1. Sozu's operator
  // sends its own activation at 2 just after a stake, and while that waited alone in the mempool its median was 2.
  const withStake = () => ({ route: "stake", staking: staking(owner({ relatedStakes: [related()] })) });
  const liquid = (over) => ({ route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu(over) });
  const amount = (name, value, review) => () => {
    typeInto(field(name), value);
    button(review).click();
  };
  const sozuActivation = { mempool: [{ gasPrice: "2", gasLimit: "6000000" }] };
  const busyMempool = { mempool: Array.from({ length: 1000 }, () => ({ gasPrice: "900", gasLimit: "2500000" })) };
  afterEach(() => {
    gasAnswer = MEDIAN_ONE;
  });

  it.each([
    ["Stake", () => ({ route: "stake", staking: staking(owner(), { screen: "native" }) }), amount("Stake amount", "1000", "Review stake")],
    ["Unstake", withStake, () => button("Unstake").click()],
    ["Claim rewards", withStake, () => button("Claim rewards").click()],
    ["Liquid staking", () => liquid(), amount("Stake amount", "100", "Review stake")],
    ["Unstake from Sozu", () => liquid({ action: "withdraw", position: { poolBalanceLux: dusk(12), stDuskBalanceLux: dusk(4) } }), amount("Unstake amount", "5", "Review unstake")],
  ])("is the minimum with Sozu's activation waiting alone, and the capped median, said busy, with a full mempool (%s)", async (_, start, toReview) => {
    const priceSent = async (answer) => {
      gasAnswer = answer;
      const state = start();
      const app = popup(state);
      toReview();
      await settle();
      const busy = visibleText(body.querySelector("dusk-gas-editor .gas-busy") ?? { textContent: "" });
      pastClickGuard();
      confirm().click();
      await settle();
      const sent = app.actions.send.mock.calls.map(([m]) => m).find((m) => m.type === "DUSK_UI_SEND_TX");
      return [sent?.params.gas?.price, busy];
    };
    expect(await priceSent(sozuActivation)).toEqual(["1", ""]);
    const busy = await priceSent(busyMempool);
    expect(busy).toEqual(["5", expect.stringMatching(/busy/i)]);
    expect(busy[1]).toBe(GAS_PRICE_BUSY);
  });
});
