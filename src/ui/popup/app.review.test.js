import { afterEach, describe, expect, it, vi } from "vitest";

import { accessibleName, fakeEvent, installFakeDom, pastClickGuard, settle } from "../testing/fakeDom.js";

vi.mock("../../wallet/bus.js", () => ({ send: vi.fn() }));
// Deposits' arrivals, read as the popup draws: held for wallet B, to stop a
// redraw where the overview names B and the DOM is still A's.
const arrivals = vi.hoisted(() => ({ gate: null, heldFor: "" }));
vi.mock("../../shared/bridgeArrival.js", async (importOriginal) => ({
  ...(await importOriginal()),
  loadArrivals: vi.fn(async (walletId) => {
    if (arrivals.gate && walletId === arrivals.heldFor) await arrivals.gate.promise;
  }),
}));

const A =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const B =
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const TO =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck929";
const wallet = (account, key) => ({
  hasVault: true,
  isUnlocked: true,
  networkName: "Testnet",
  nodeUrl: "https://testnet.nodes.dusk.network",
  accounts: [account],
  accountCount: 1,
  selectedAccountIndex: 0,
  balance: { value: "1500000000000" },
  shieldedBalance: { value: "0", spendable: "0" },
  txs: [],
  walletKey: key,
  wallets: [
    { key: "wa", n: 1, name: "", walletId: A, accounts: [A], accountNames: {}, active: key === "wa" },
    { key: "wb", n: 2, name: "", walletId: B, accounts: [B], accountNames: {}, active: key === "wb" },
  ],
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  arrivals.gate = null;
});

const flush = async () => {
  for (let i = 0; i < 8; i++) await settle();
};

// The popup on `route` with wallet A open; `t.open` is what the wallet's
// overview says, `t.deliver` the wallet's own messages to the popup.
async function popupOn(route, extra = {}, answer = async () => undefined, { history, tauri } = {}) {
  const dom = installFakeDom({ pathname: "/popup.html" });
  if (history) dom.window.history = history(dom.window);
  // The app on an Android phone: Tauri's bridge to the wrapper.
  if (tauri) {
    dom.window.__TAURI_INTERNALS__ = tauri;
    vi.stubGlobal("navigator", { ...globalThis.navigator, userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 6; wv) AppleWebKit/537.36 Chrome/156.0 Mobile Safari/537.36" });
  }
  dom.document.body.innerHTML = "";
  const header = dom.document.createElement("div");
  header.id = "header-actions";
  const app = dom.document.createElement("div");
  app.id = "app";
  dom.document.body.append(header, app);
  let onMessage = null;
  vi.stubGlobal("browser", {
    runtime: { id: "dusk-wallet", sendMessage: () => {}, onMessage: { addListener: (fn) => (onMessage = fn) } },
  });
  vi.resetModules();
  const { send } = await import("../../wallet/bus.js");
  const t = { dom, app, send, open: wallet(A, "wa") };
  send.mockReset();
  send.mockImplementation(async (message) => {
    const answered = await answer(message, t);
    if (answered !== undefined) return answered;
    if (message.type === "DUSK_UI_OVERVIEW") return t.open;
    if (message.type === "DUSK_UI_GET_CACHED_GAS_PRICE") return { ok: true, result: { min: "1", median: "1", max: "1" } };
    if (message.type === "DUSK_UI_SEND_TX") return { ok: true, result: { hash: "ab".repeat(32) } };
    return { ok: true, result: null };
  });
  const { state } = await import("./state.js");
  Object.assign(state, { route, ...extra });
  const { render } = await import("./app.js");
  await render();
  await flush();
  return Object.assign(t, { state, render, deliver: (message) => onMessage(message), asked: (type) => send.mock.calls.map(([m]) => m).filter((m) => m.type === type) });
}

describe("a Review drawn for wallet A, with wallet B opened in another window", () => {
  it("sends nothing from the old Confirm pressed while the popup reads B but still shows A", async () => {
    const t = await popupOn("confirm", {
      addressBook: { loaded: true, items: [] },
      draft: { to: TO, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" },
    });
    const { app, send, state } = t;
    const confirm = app.querySelectorAll("button").find((b) => b.textContent === "Confirm");
    expect(confirm).toBeTruthy();

    // Wallet B opens in another window. The popup reads its overview, then
    // waits on B's arrivals before drawing: A's Review is still the screen.
    t.open = wallet(B, "wb");
    arrivals.gate = Promise.withResolvers();
    arrivals.heldFor = B;
    t.deliver({ type: "DUSK_UI_WALLET_CHANGED" });
    await flush();
    expect(state.overview.accounts[0]).toBe(B);
    expect(app.contains(confirm)).toBe(true);

    pastClickGuard();
    confirm.click();
    await flush();
    arrivals.gate.resolve();
    await flush();

    expect(send.mock.calls.map(([m]) => m).filter((m) => m.type === "DUSK_UI_SEND_TX")).toEqual([]);
    expect([state.route, state.sent?.phase, state.sent?.error]).toEqual(["sent", "not_sent", "The network, profile or wallet changed meanwhile."]);
  });
});

describe("a Review's Confirm, the moment the Review is up", () => {
  const review = () => ({
    addressBook: { loaded: true, items: [] },
    draft: { to: TO, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" },
  });
  const confirm = (t) => t.app.querySelectorAll("button").find((b) => b.textContent === "Confirm");

  it("ignores a click as a double-click on Review lands there, sends one a moment later, and a redraw doesn't hold it again", async () => {
    const t = await popupOn("send", review());
    // Review pressed: the Review comes up, and the second click lands on Confirm.
    t.state.route = "confirm";
    await t.render();
    await flush();
    confirm(t).click();
    await flush();
    expect([t.asked("DUSK_UI_SEND_TX"), t.state.route, confirm(t).disabled]).toEqual([[], "confirm", false]);

    // A moment on, drawn again meanwhile (a poll), it's the same Review: Confirm sends.
    pastClickGuard();
    await t.render();
    await flush();
    confirm(t).click();
    await flush();
    expect(t.asked("DUSK_UI_SEND_TX")).toHaveLength(1);
  });

  it("ignores a click as the Review comes back after an unlock, where Unlock was", async () => {
    const t = await popupOn("confirm", review());
    pastClickGuard();
    t.open = { ...wallet(A, "wa"), isUnlocked: false };
    await t.render({ forceRefresh: true });
    await flush();
    expect(confirm(t)).toBeUndefined();

    pastClickGuard();
    t.open = wallet(A, "wa");
    await t.render({ forceRefresh: true });
    await flush();
    confirm(t).click();
    await flush();
    expect(t.asked("DUSK_UI_SEND_TX")).toEqual([]);

    pastClickGuard();
    confirm(t).click();
    await flush();
    expect(t.asked("DUSK_UI_SEND_TX")).toHaveLength(1);
  });
});

describe("a step to a Review", () => {
  it("comes up at once, with no rise, even while the view before it is still rising", async () => {
    const t = await popupOn("home", {
      addressBook: { loaded: true, items: [] },
      draft: { to: TO, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" },
    });
    // Another view rises into place (ui.css: #app.view-animate).
    t.state.route = "send";
    await t.render();
    expect(t.app.classList.contains("view-animate")).toBe(true);
    // Review pressed before that rise is done: it's there at once.
    t.state.route = "confirm";
    await t.render();
    expect(t.app.classList.contains("view-animate")).toBe(false);
    // Back to the form: at once too.
    t.state.route = "send";
    await t.render();
    expect(t.app.classList.contains("view-animate")).toBe(false);
  });
});

describe("a Review's From line", () => {
  it("names the wallet the Review was drawn for, which its Confirm sends from", async () => {
    const t = await popupOn("confirm", {
      addressBook: { loaded: true, items: [] },
      draft: { to: TO, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" },
    });
    const from = () => t.app.querySelectorAll(".send-review > .group > .kv").map((kv) => kv.textContent).find((text) => text.startsWith("From"));
    expect(from()).toBe("FromWallet 1 · Profile 1 · Public");

    // Wallet B opens in another window: the Review drawn again says B, and sends from B.
    t.open = wallet(B, "wb");
    t.deliver({ type: "DUSK_UI_WALLET_CHANGED" });
    await flush();
    expect(from()).toBe("FromWallet 2 · Profile 1 · Public");
    pastClickGuard();
    t.app.querySelectorAll("button").find((b) => b.textContent === "Confirm").click();
    await flush();
    expect(t.asked("DUSK_UI_SEND_TX")).toEqual([expect.objectContaining({ walletId: B })]);
  });
});

describe("a screen's own actions, after another wallet opened", () => {
  it("name the wallet the screen was drawn for, so the wallet refuses them for another", async () => {
    const t = await popupOn("options");
    const select = t.app.querySelectorAll("select").find((el) => accessibleName(el) === "Active profile");
    expect(select).toBeTruthy();
    select.value = "0";
    select.dispatchEvent(fakeEvent("change"));
    await flush();
    expect(t.asked("DUSK_UI_SET_ACCOUNT_INDEX")).toEqual([expect.objectContaining({ index: 0, walletId: A })]);
  });

  it("closes the profile menu that lists the wallet before", async () => {
    const t = await popupOn("home");
    t.dom.document.body.querySelector("#header-actions .account-chip").click();
    await flush();
    expect(t.dom.document.body.querySelector(".acct-menu")).toBeTruthy();
    t.open = wallet(B, "wb");
    t.deliver({ type: "DUSK_UI_WALLET_CHANGED" });
    await flush();
    expect(t.dom.document.body.querySelector(".acct-menu")).toBeNull();
  });
});

describe("a wallet removed in another window", () => {
  it("leaves its Remove form for Settings, and the list is read again", async () => {
    const t = await popupOn("wallet_remove", { walletRemove: "wb" });
    expect(t.app.querySelector(".subnav")?.textContent ?? t.app.textContent).toContain("Remove wallet");
    const reads = t.asked("DUSK_UI_OVERVIEW").length;
    // Wallet B goes in another window: A stays open, so no switch is said.
    t.open = { ...wallet(A, "wa"), wallets: [wallet(A, "wa").wallets[0]] };
    t.deliver({ type: "DUSK_UI_WALLETS_CHANGED" });
    await flush();
    expect(t.asked("DUSK_UI_OVERVIEW").length).toBeGreaterThan(reads);
    expect([t.state.route, t.state.walletRemove]).toEqual(["options", null]);
    expect(t.app.querySelectorAll("button").map((b) => b.textContent)).not.toContain("Remove wallet");
  });
});

describe("stDUSK, found on the dashboard", () => {
  it("is found again for another wallet on the same network and profile", async () => {
    const STDUSK = "5d".repeat(32);
    // Each wallet holds stDUSK with Sozu, and watches no token yet.
    const t = await popupOn("home", {}, async (message) => {
      if (message.type === "DUSK_UI_GET_SOZU_STATUS") {
        return { ok: true, result: { contracts: { "staked-dusk": STDUSK }, position: { stDuskBalanceLux: "5000000000" } } };
      }
      if (message.type === "DUSK_UI_ASSETS_GET") return { ok: true, result: { tokens: [], nfts: [] } };
      return undefined;
    });
    await flush();
    expect(t.asked("DUSK_UI_ASSETS_WATCH_TOKEN").map((m) => m.walletId)).toEqual([A]);

    t.open = wallet(B, "wb");
    t.deliver({ type: "DUSK_UI_WALLET_CHANGED" });
    await flush();
    expect(t.asked("DUSK_UI_ASSETS_WATCH_TOKEN").map((m) => m.walletId)).toEqual([A, B]);
  });
});

describe("a Copy button that says Copied", () => {
  it("keeps the focus when the popup is drawn again meanwhile", async () => {
    const t = await popupOn("receive");
    const copyAddress = () => t.app.querySelectorAll("button").find((b) => b.getAttribute("aria-label") === "Copy address");
    const pressed = copyAddress();
    pressed.focus();
    pressed.click();
    await flush();
    expect(pressed.getAttribute("aria-label")).toBe("Copied");

    // A poll draws the popup again within the 1.5 s: the focus moves to the new Copy.
    await t.render();
    await flush();
    expect(t.dom.document.activeElement).toBe(copyAddress());
  });
});

// The page's history as a browser keeps it: Back (`back`) goes to the entry
// before, with a popstate; with none before, it closes the wallet.
function pageHistory(win) {
  const entries = [{}];
  let at = 0;
  return {
    closed: false,
    get length() {
      return entries.length;
    },
    get at() {
      return at;
    },
    pushState(state) {
      entries.splice(at + 1, Infinity, state);
      at++;
    },
    back() {
      this.go(-1);
    },
    go(delta) {
      if (at + delta < 0) {
        this.closed = true;
        return;
      }
      at += delta;
      setTimeout(() => win.dispatchEvent(fakeEvent("popstate", { state: entries[at] })), 0);
    },
  };
}

describe("the phone's Back button", () => {
  it("keeps one entry for each step in: the page's own Back takes one, and none goes up while no one presses anything", async () => {
    let history;
    const t = await popupOn(
      "send",
      { addressBook: { loaded: true, items: [] }, draft: { to: B, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" } },
      undefined,
      { history: (win) => (history = pageHistory(win)) }
    );
    const button = (text) => t.app.querySelectorAll("button").find((b) => b.textContent === text);
    button("Review").click();
    await flush();
    expect(history.at).toBe(2);
    button("← Back").click();
    await flush();
    expect([t.state.route, history.at]).toEqual(["send", 1]);
    button("Review").click();
    await flush();
    expect(history.at).toBe(2);

    // The person's Back, then the wallet drawing again on its own: no entry goes up,
    // which a WebView would skip, closing the app on the next Back.
    history.back();
    await flush();
    await t.render({ forceRefresh: true });
    await flush();
    expect([t.state.route, history.at]).toEqual(["send", 1]);
  });

  it("goes one screen back inside the wallet, Review to the Send form with what was typed, and leaves only from Home", async () => {
    let history;
    const t = await popupOn(
      "send",
      { addressBook: { loaded: true, items: [] }, draft: { to: B, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" } },
      undefined,
      { history: (win) => (history = pageHistory(win)) }
    );
    const { app, state } = t;
    const button = (text) => app.querySelectorAll("button").find((b) => b.textContent === text);
    const memo = () => app.querySelectorAll("input").find((i) => accessibleName(i) === "Memo");
    // A screen with a way back stands one entry above the page's own.
    expect(history.at).toBe(1);
    memo().value = "Lunch for Léa";
    memo().dispatchEvent(fakeEvent("input"));
    button("Review").click();
    await flush();
    expect(state.route).toBe("confirm");
    // A step in: one entry more.
    expect(history.at).toBe(2);

    history.back();
    await flush();
    expect(state.route).toBe("send");
    expect([app.querySelector(".to-input-wrap textarea").value, memo().value]).toEqual([B, "Lunch for Léa"]);
    expect([history.at, history.closed]).toEqual([1, false]);

    history.back();
    await flush();
    expect(state.route).toBe("home");
    // Home has no way back: Back leaves the wallet, as before.
    expect(history.at).toBe(0);
    history.back();
    expect(history.closed).toBe(true);
  });
});

describe("coming back to the wallet during a payment", () => {
  it("looks the payment up by its ID, and says Completed with its real fee, though nothing was heard while away", async () => {
    const HASH = "9f".repeat(32);
    const t = await popupOn(
      "sent",
      { addressBook: { loaded: true, items: [] }, sent: { phase: "sent", status: "submitted", hash: HASH, title: "Send", amountLux: "30000000", feeCapLux: "2500000", sentAt: Date.now(), startedAt: Date.now() } },
      async (message, t) => {
        // The node has it in a block: the wallet writes that on its record and says so.
        if (message.type === "DUSK_UI_RECHECK_TX" && message.hash === HASH) {
          t.open = { ...t.open, txs: [{ hash: HASH, status: "executed", submittedAt: Date.now() - 40_000, feePaid: "2135802", blockHeight: "4802949" }] };
          t.deliver({ type: "DUSK_UI_TX_STATUS", hash: HASH, status: "executed", ok: true });
          return { ok: true };
        }
        return undefined;
      }
    );
    t.open = { ...t.open, txs: [{ hash: HASH, status: "submitted", submittedAt: Date.now() - 40_000 }] };
    await t.render({ forceRefresh: true });
    expect(t.app.textContent).toContain("Waiting for a block");
    expect(t.asked("DUSK_UI_RECHECK_TX")).toEqual([]);

    // Home pressed, then back after the block: the page shows again.
    t.dom.document.visibilityState = "visible";
    t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    await flush();
    expect(t.asked("DUSK_UI_RECHECK_TX").map((m) => m.hash)).toEqual([HASH]);
    expect(t.app.textContent).toContain("In block 4,802,949");
    expect(t.app.textContent).toContain("0.002135802");
    expect(t.app.textContent).not.toContain("Waiting for a block");
  });
});

// Tauri's bridge to the app's wrapper: what each command answers, and the
// events the wrapper sends (`emit`).
function tauriBridge(answers = {}) {
  const handlers = [];
  const invoke = vi.fn(async (cmd, args) => {
    if (cmd === "plugin:event|listen") return handlers.push(args.handler) - 1;
    return typeof answers[cmd] === "function" ? answers[cmd](args) : (answers[cmd] ?? null);
  });
  return { invoke, transformCallback: (fn) => (handlers.push(fn), handlers.length - 1), emit: (payload) => handlers.forEach((fn) => typeof fn === "function" && fn({ payload })) };
}

describe("the app on a phone", () => {
  const LINK = `dusk:public-${B}@dusk:2?amount=0.01&memo=Deep+link+test`;

  // Chen's wish: lock when I leave the app.
  it("locks as the person leaves it with Lock when I leave the app on, not for the share sheet, and not with it off", async () => {
    const bridge = tauriBridge();
    // The wallet locks when asked, and says so.
    const locks = async (message, t) => {
      if (message.type !== "DUSK_UI_LOCK") return undefined;
      t.open = { ...t.open, isUnlocked: false };
      t.deliver({ type: "DUSK_UI_LOCK_STATE", isUnlocked: false });
      return { ok: true };
    };
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] } }, locks, { tauri: bridge });
    const hide = async () => {
      t.dom.document.visibilityState = "hidden";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      await flush();
    };
    const show = async () => {
      t.dom.document.visibilityState = "visible";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      await flush();
    };
    // Off, as it starts: nothing locks.
    await hide();
    expect(t.asked("DUSK_UI_LOCK")).toEqual([]);
    await show();

    // On, in Settings: the switch is there in the app.
    t.open = { ...t.open, lockOnLeave: true };
    t.state.route = "options";
    await t.render({ forceRefresh: true });
    expect(t.app.querySelector("#lock-on-leave").checked).toBe(true);
    expect(t.app.textContent).toContain("Lock when I leave the app");

    // The wallet's own share sheet is no leaving.
    const { shareText } = await import("../../platform/native.js");
    await shareText("an address");
    await hide();
    expect(t.asked("DUSK_UI_LOCK")).toEqual([]);
    await show();
    // Leaving is: back, the password is asked, not the locked Settings.
    await hide();
    expect(t.asked("DUSK_UI_LOCK")).toHaveLength(1);
    await show();
    expect(t.app.querySelector("input[type=password]")?.getAttribute("placeholder")).toBe("Password");
    expect(t.app.textContent).not.toContain("Lock when I leave the app");
  });

  it("opens Send filled in from a dusk: link it was opened with, and from one opened while it runs", async () => {
    const bridge = tauriBridge({ "plugin:deep-link|get_current": [LINK] });
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] } }, undefined, { tauri: bridge });
    await flush();
    const fields = () => t.app.querySelectorAll("input, textarea").map((f) => f.value);
    expect(t.state.route).toBe("send");
    expect(t.app.querySelector(".to-input-wrap textarea").value).toBe(B);
    expect(fields()).toContain("Deep link test");
    expect(fields()).toContain("0.01");

    // Another, from a chat, as the app runs: Send again, with that one's.
    t.state.route = "home";
    await t.render();
    bridge.emit([LINK.replace("0.01", "0.02").replace("Deep+link+test", "Second")]);
    await flush();
    expect([t.state.route, fields().includes("0.02"), fields().includes("Second")]).toEqual(["send", true, true]);

    // Lena's: one as the app comes back on Activity, while the wallet still
    // reads the node, which a phone just woken can take a minute to answer.
    t.state.route = "activity";
    await t.render();
    const answer = t.send.getMockImplementation();
    const node = Promise.withResolvers();
    t.send.mockImplementation(async (message) => (message.type === "DUSK_UI_OVERVIEW" ? (await node.promise, t.open) : answer(message)));
    bridge.emit([LINK.replace("0.01", "0.03").replace("Deep+link+test", "Third")]);
    await flush();
    expect([t.app.querySelector(".subnav-title")?.textContent, fields().includes("0.03"), fields().includes("Third")]).toEqual(["Send", true, true]);
    node.resolve();
    await flush();
    expect([t.app.querySelector(".subnav-title")?.textContent, fields().includes("0.03"), fields().includes("Third")]).toEqual(["Send", true, true]);
  });
});

// The phone's Back in the app, as Android hands it to the wallet (Tauri's
// back-button event, here a fake): through what people do, into screens,
// Back, the background, back in, a press between, Android answering late.
// Back takes one screen back at a time; on the first screen the app goes to
// the background; the page's history is never touched, and nothing closes.
describe("the phone's Back in the app, as Android hands it over", () => {
  const ROWS = [
    ["two screens in, back out, then to the background", "at once", [["settings", "options"], ["contacts", "contacts"], ["back", "options"], ["back", "home"], ["back", "home"]], 1],
    ["to the background, back in, Back with no press, twice (Lena's)", "at once", [["back", "home"], ["back", "home"], ["back", "home"]], 3],
    ["a press between two Backs to the background", "at once", [["back", "home"], ["tap", "home"], ["back", "home"]], 2],
    ["back in, two screens in and out, to the background again", "at once", [["back", "home"], ["settings", "options"], ["contacts", "contacts"], ["back", "options"], ["back", "home"], ["back", "home"], ["back", "home"]], 3],
    ["into Settings before Android answers (Sol's)", "on answer", [["back", "home"], ["settings", "options"], ["answer", "options"], ["back", "home"], ["back", "home"]], 2],
    ["into Settings and Back before Android answers (the delta review's)", "on answer", [["back", "home"], ["settings", "options"], ["back", "home"], ["answer", "home"], ["back", "home"]], 2],
    ["Android answering after the next Back too", "on answer", [["back", "home"], ["back", "home"], ["answer", "home"], ["answer", "home"], ["back", "home"]], 3],
    // Chen's: Back from Settings and from Add wallet went straight to the dashboard.
    ["Settings opened from Receive, Back to Receive", "at once", [["receive", "receive"], ["settings", "options"], ["back", "receive"], ["back", "home"], ["back", "home"]], 1],
    ["Add wallet from Settings, Back to Settings, then to where Settings was opened", "at once", [["receive", "receive"], ["settings", "options"], ["add", "wallet_add"], ["back", "options"], ["back", "receive"], ["back", "home"]], 0],
  ];

  it.each(ROWS)("%s", async (_, when, steps, toBackground) => {
    let history;
    let backButton;
    const waiting = [];
    const bridge = tauriBridge({
      // Android's Back, from the moment the wallet listens to it.
      "plugin:app|register_listener": (args) => {
        if (args?.event === "back-button") backButton = args.handler;
        return null;
      },
      move_to_back: () => (when === "at once" ? true : new Promise((resolve) => waiting.push(resolve))),
    });
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] } }, undefined, { tauri: bridge, history: (win) => (history = pageHistory(win)) });
    await vi.waitFor(() => expect(backButton).toBeDefined());
    const button = (text) => [...t.dom.document.querySelectorAll("button")].find((b) => b.textContent === text || b.getAttribute("aria-label") === text);
    const done = [];
    for (const [step, route] of steps) {
      if (step === "settings") button("Settings").click();
      if (step === "contacts") button("Contacts").click();
      if (step === "receive") button("Receive").click();
      if (step === "add") [...t.app.querySelectorAll(".settings-row")].find((row) => row.textContent.includes("Add wallet")).click();
      if (step === "tap") t.app.click();
      if (step === "back") backButton.onmessage({ canGoBack: false });
      if (step === "answer") waiting.shift()?.(true);
      await flush();
      done.push(step);
      expect([done.join(" "), t.state.route, history.length, history.closed]).toEqual([done.join(" "), route, 1, false]);
    }
    expect(bridge.invoke.mock.calls.filter(([cmd]) => cmd === "move_to_back")).toHaveLength(toBackground);
  });
});

