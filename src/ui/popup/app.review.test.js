import { afterEach, describe, expect, it, vi } from "vitest";

import { accessibleName, fakeEvent, installFakeDom, pastClickGuard, settle, visibleText } from "../testing/fakeDom.js";

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

// A Review's Confirm, whatever it says: the one button at the Review's end (FormControls.js reviewActions).
const confirmOf = (root) => root.querySelector(".review-actions button");
// The question asked before a payment goes (ConfirmDialog.js): Stay is its Back, Leave the other answer.
const question = (t) => t.dom.document.querySelector("[role=alertdialog]");
const stay = (t) => question(t).querySelector("[data-back]").click();
const leave = (t) => question(t).querySelectorAll("button").find((b) => !b.hasAttribute("data-back")).click();
// How a payment's own page says it stands (txDetails.js tx-hero-status): its tone, and its word ("Completed",
// "Failed"...); null while that page isn't drawn.
const paymentStatus = (t) => {
  const el = t.app.querySelector(".tx-hero-status");
  return el ? { ok: el.classList.contains("is-ok"), word: el.textContent } : null;
};
// A figure exactly as written: not inside a longer number, not signed or bounded unless written so, and not followed by
// more digits, letters or a decimal part (1.0025 ≠ 11.0025, 0.005 ≠ −0.005, 2,000,000 ≠ 2,000,000.5, BNB ≠ BNBX).
const exactly = (text) => new RegExp(`(?<![\\d.,+\\-−<>≤≥~])(?<![+\\-−<>≤≥~]\\s)${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\dA-Za-z]|[.,]\\d)`);
// What a row says, found by its label (a string, or a pattern for a label that may be worded otherwise); null for none.
const rowValue = (root, label) => {
  const row = root.querySelectorAll(".kv").find((kv) => {
    const text = kv.querySelector(".kv-label")?.textContent ?? "";
    return typeof label === "string" ? text === label : label.test(text);
  });
  return row ? visibleText(row.querySelector(".kv-value")) : null;
};
// The Sent screen's last step, Completed once it's done, with the block it's in (sent.js steps).
const finalStep = (t) => {
  const step = t.app.querySelectorAll(".stepper .step").at(-1);
  return step ? { done: step.classList.contains("is-done"), sub: step.querySelector(".step-sub")?.textContent ?? "" } : null;
};

// The popup on `route` with wallet A open; `t.open` is what the wallet's
// overview says, `t.deliver` the wallet's own messages to the popup.
// The extension's session store, which outlives a popup: what's in `kept`, as browser.storage.session holds it.
const sessionArea = (kept) => ({
  get: async (key) => Object.fromEntries([key].flat().filter((k) => kept.has(k)).map((k) => [k, structuredClone(kept.get(k))])),
  set: async (items) => {
    for (const [k, v] of Object.entries(items)) kept.set(k, structuredClone(v));
  },
  remove: async (key) => {
    for (const k of [key].flat()) kept.delete(k);
  },
});

// A page's own sessionStorage: a new one for each popup, the same for a tab that reloads.
const pageSession = (kept = new Map()) => {
  vi.stubGlobal("sessionStorage", { getItem: (key) => kept.get(key) ?? null, setItem: (key, value) => kept.set(key, String(value)), removeItem: (key) => kept.delete(key) });
  return kept;
};

async function popupOn(route, extra = {}, answer = async () => undefined, { history, tauri, tab, session } = {}) {
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
    // `tab`: the page in a tab of its own, as the extension's full page.
    ...(tab ? { tabs: { getCurrent: async () => tab } } : {}),
    // `session`: the extension's session store, as it outlives the page.
    ...(session ? { storage: { session: sessionArea(session) } } : {}),
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
  return Object.assign(t, {
    state,
    render,
    deliver: (message, sender = {}, sendResponse = () => {}) => onMessage(message, sender, sendResponse),
    asked: (type) => send.mock.calls.map(([m]) => m).filter((m) => m.type === type),
  });
}

describe("a Review drawn for wallet A, with wallet B opened in another window", () => {
  it("sends nothing from the old Confirm pressed while the popup reads B but still shows A", async () => {
    const t = await popupOn("confirm", {
      addressBook: { loaded: true, items: [] },
      draft: { to: TO, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" },
    });
    const { app, send, state } = t;
    const confirm = confirmOf(app);
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
    expect([state.route, state.sent?.phase]).toEqual(["sent", "not_sent"]);
    // With why.
    expect(state.sent?.error).toBeTruthy();
  });
});

describe("a Review's Confirm, the moment the Review is up", () => {
  const review = () => ({
    addressBook: { loaded: true, items: [] },
    draft: { to: TO, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" },
  });
  const confirm = (t) => confirmOf(t.app);

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
    expect(confirm(t)).toBeNull();

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

describe("a Review's From line", () => {
  it("names the wallet the Review was drawn for, which its Confirm sends from", async () => {
    const t = await popupOn("confirm", {
      addressBook: { loaded: true, items: [] },
      draft: { to: TO, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" },
    });
    const from = () => rowValue(t.app.querySelector(".send-review"), "From");
    expect(from()).toBe("Wallet 1 · Profile 1 · Public");

    // Wallet B opens in another window: the Review drawn again says B, and sends from B.
    t.open = wallet(B, "wb");
    t.deliver({ type: "DUSK_UI_WALLET_CHANGED" });
    await flush();
    expect(from()).toBe("Wallet 2 · Profile 1 · Public");
    pastClickGuard();
    confirmOf(t.app).click();
    await flush();
    expect(t.asked("DUSK_UI_SEND_TX")).toEqual([expect.objectContaining({ walletId: B })]);
  });
});

describe("a screen's own actions, after another wallet opened", () => {
  it("name the wallet the screen was drawn for, so the wallet refuses them for another", async () => {
    const t = await popupOn("options");
    // Settings' active profile.
    const select = t.app.querySelector("select#account");
    expect(select).toBeTruthy();
    select.value = "0";
    select.dispatchEvent(fakeEvent("change"));
    await flush();
    expect(t.asked("DUSK_UI_SET_ACCOUNT_INDEX")).toEqual([expect.objectContaining({ index: 0, walletId: A })]);
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

// Astra's: called off on its Sent, a payment that waited said "Sent" on Home though nothing went out, and one
// whose try failed and whose record went said the same. Leaving the waiting list says nothing of how it left:
// one that went out is in Activity by then, as the wallet keeps it as sent first.
describe("a payment that waited, on Home", () => {
  it("never says it was sent for leaving the waiting list, called off on its Sent or failed", async () => {
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] } });
    const waiting = (sendId, memo) => ({ sendId, walletId: A, nodeUrl: t.open.nodeUrl, profileIndex: 0, privacy: "public", to: B, lux: "10000000", feeLux: "2500000", memo, at: Date.now() - 60_000, waiting: true, waits: false });
    const cards = () => t.app.querySelectorAll(".home-waiting");
    t.open = { ...t.open, waitingSends: [waiting("send-0201", "Hors ligne un"), waiting("send-0202", "Hors ligne deux")] };
    await t.render({ forceRefresh: true });
    // Both on their way, neither as Home's card for one gone out (home.js wentBox).
    expect(cards()).toHaveLength(2);
    expect(t.app.querySelectorAll(".home-waiting--went")).toEqual([]);
    // Called off on its Sent, the other's try failed and its record went: both leave the list, nothing went out,
    // and no card says either went.
    t.open = { ...t.open, waitingSends: [] };
    await t.render({ forceRefresh: true });
    expect(cards()).toEqual([]);
  });
});

// Amélie's: Wi-Fi off at Confirm, the browser closed; opened again, Home said "Not sent … Send it now". Send it now
// opened its Review, she closed the popup, and it opened again on a filled Send form, with no word of that payment.
describe("a payment Home says wasn't sent, its Review closed", () => {
  it("opens again on Home's word for it, Send it now and all, not on a filled Send", async () => {
    // Each popup a page of its own; the extension's session store outlives them.
    const session = new Map();
    pageSession();
    const unsent = { sendId: "send-0301", walletId: A, nodeUrl: "https://testnet.nodes.dusk.network", profileIndex: 0, privacy: "public", to: B, lux: "10000000", feeLux: "2500000", memo: "Wi-Fi coupé", at: Date.now() - 60_000, waiting: false, waits: false, ended: "closed" };
    const first = await popupOn("home", { addressBook: { loaded: true, items: [] } }, undefined, { session });
    first.open = { ...first.open, waitingSends: [unsent] };
    await first.render({ forceRefresh: true });
    first.app.querySelectorAll(".home-waiting--unsent button").find((b) => b.textContent === "Send it now").click();
    await flush();
    expect(first.state.route).toBe("confirm");
    first.dom.window.dispatchEvent(fakeEvent("pagehide"));
    await flush();

    pageSession();
    const again = await popupOn("home", { addressBook: { loaded: true, items: [] } }, async (message, t) => (message.type === "DUSK_UI_OVERVIEW" ? { ...t.open, waitingSends: [unsent] } : undefined), { session });
    expect(again.state.route).toBe("home");
    // Home's card for that payment not sent, its amount in its title, with its two answers.
    expect(again.app.querySelector(".home-waiting--unsent .callout-title")?.textContent).toMatch(exactly("0.01 DUSK"));
    expect(again.app.querySelectorAll(".home-waiting--unsent button")).toHaveLength(2);
  });

  // Round 40's review: back from Send it now's Review, the payment changed, the popup closed before Review again: the
  // changes went, and Home only had the payment as it was. Changed, it's a payment of its own, kept as any Send is;
  // as it was, Home's word for it stands.
  it("keeps it as your unfinished payment once it's changed back from its Review, and not while it's as it was", async () => {
    const session = new Map();
    const unsent = { sendId: "send-0302", walletId: A, nodeUrl: "https://testnet.nodes.dusk.network", profileIndex: 0, privacy: "public", to: B, lux: "10000000", feeLux: "2500000", memo: "Wi-Fi coupé", at: Date.now() - 60_000, waiting: false, waits: false, ended: "closed" };
    const withUnsent = async (message, t) => (message.type === "DUSK_UI_OVERVIEW" ? { ...t.open, waitingSends: [unsent] } : undefined);
    const field = (t, name) => t.app.querySelectorAll("input, textarea").find((f) => accessibleName(f) === name);
    const backFromReview = async (edit) => {
      pageSession();
      const t = await popupOn("home", { addressBook: { loaded: true, items: [] } }, withUnsent, { session });
      t.app.querySelectorAll(".home-waiting--unsent button").find((b) => b.textContent === "Send it now").click();
      await flush();
      expect(t.state.route).toBe("confirm");
      t.app.querySelector(".subnav-back").click();
      await flush();
      expect(t.state.route).toBe("send");
      if (edit) {
        field(t, "Amount").value = "0.2";
        field(t, "Amount").dispatchEvent(fakeEvent("input"));
      }
      // The popup closed: out of sight, then gone.
      t.dom.document.visibilityState = "hidden";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      t.dom.window.dispatchEvent(fakeEvent("pagehide"));
      await flush();
      pageSession();
      return popupOn("home", { addressBook: { loaded: true, items: [] } }, withUnsent, { session });
    };
    const asWas = await backFromReview(false);
    expect(asWas.state.route).toBe("home");
    expect(asWas.app.querySelectorAll(".home-waiting--unsent button")).toHaveLength(2);
    const changed = await backFromReview(true);
    expect(changed.state.route).toBe("send");
    expect(["To", "Amount", "Memo"].map((name) => field(changed, name).value)).toEqual([B, "0.2", "Wi-Fi coupé"]);
    // Said to be your unfinished payment, not a link's.
    expect(visibleText(changed.app.querySelector(".send-filled-note"))).toMatch(/unfinished/i);
  });
});

describe("a half-typed Send", () => {
  it("comes back as your unfinished payment once the tab reloads, and choosing another recipient clears what it held", async () => {
    pageSession();
    const field = (t, name) => t.app.querySelectorAll("input, textarea").find((f) => accessibleName(f) === name);
    const values = (t) => ["To", "Amount", "Memo"].map((name) => field(t, name).value);
    const typed = await popupOn("send", { addressBook: { loaded: true, items: [] }, draft: null });
    for (const [name, value] of [["To", B], ["Amount", "0.1"], ["Memo", "Send 0.1 DUSK back"]]) {
      field(typed, name).value = value;
      field(typed, name).dispatchEvent(fakeEvent("input"));
    }
    typed.dom.window.dispatchEvent(fakeEvent("pagehide"));

    const back = await popupOn("home", { addressBook: { loaded: true, items: [] }, draft: null });
    expect([back.state.route, ...values(back)]).toEqual(["send", B, "0.1", "Send 0.1 DUSK back"]);
    // Said to be your unfinished payment, not a link's.
    expect(visibleText(back.app.querySelector(".send-filled-note"))).toMatch(/unfinished/i);
    // Another recipient: what it held for the first goes, and so does what it said.
    const CHEN = "26JfWKvhYdVY71bdSPVLNJ51Buy4GjimCT7zcsoxNQtydDbdoH2AwZaH8W7rjcAc9riAu39Vw9Lx1w7yrkBgotSjWmUdkSyQuaTKDZWVCKp9g1GxiEnnksv3W3onToB5NsNi";
    field(back, "To").value = CHEN;
    field(back, "To").dispatchEvent(fakeEvent("input", { inputType: "insertFromPaste" }));
    await flush();
    expect(values(back)).toEqual([CHEN, "", ""]);
    expect(back.app.querySelector(".send-filled-note").hidden).toBe(true);
  });

  it("is gone once it's sent", async () => {
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] }, draft: null });
    const button = (text) => t.app.querySelectorAll("button").find((b) => b.textContent === text);
    const field = (name) => t.app.querySelectorAll("input, textarea").find((f) => accessibleName(f) === name);
    const type = (name, value) => {
      field(name).value = value;
      field(name).dispatchEvent(fakeEvent("input"));
    };
    const openSend = async () => {
      t.app.querySelectorAll("button").find((b) => b.textContent === "Send" && b.closest(".action-bar, .dashboard-top-actions")).click();
      await flush();
      expect(t.state.route).toBe("send");
    };
    await openSend();
    type("To", B);
    type("Amount", "0.02");
    button("Review").click();
    await flush();
    pastClickGuard();
    confirmOf(t.app).click();
    await flush();
    expect(t.asked("DUSK_UI_SEND_TX")).toHaveLength(1);
    button("Done").click();
    await flush();
    await openSend();
    expect(["To", "Amount"].map((name) => field(name).value)).toEqual(["", ""]);
  });
});

describe("a request's Send", () => {
  // Sofía's: a scanned request left with Back came back, 0.03 and its memo, in the next Send.
  // Astra's: a Testnet request kept that way could be paid on Mainnet.
  it("isn't kept once left with Back, and leaves nothing to pay on another network", async () => {
    let history;
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] }, draft: null }, undefined, { history: (win) => (history = pageHistory(win)) });
    const field = (name) => t.app.querySelectorAll("input, textarea").find((f) => accessibleName(f) === name);
    const values = () => ["To", "Amount", "Memo"].map((name) => field(name).value);
    const openSend = async () => {
      t.app.querySelectorAll("button").find((b) => b.textContent === "Send" && b.closest(".action-bar, .dashboard-top-actions")).click();
      await flush();
      expect(t.state.route).toBe("send");
    };
    const { makePaymentLink } = await import("@dusk-network/app-core/payment-links");
    const pasteLink = async () => {
      field("To").value = makePaymentLink({ amount: "0.02", memo: "satay", network: "testnet", to: B }).dusk;
      field("To").dispatchEvent(fakeEvent("input", { inputType: "insertFromPaste" }));
      await flush();
      expect(values()).toEqual([B, "0.02", "satay"]);
    };
    await openSend();
    await pasteLink();
    // What the link filled in says so, with the network it pays on.
    const filledNote = () => visibleText(t.app.querySelector(".send-filled-note"));
    // Edited, and Review and back, it's still the link's.
    field("Memo").value = "satay twice";
    field("Memo").dispatchEvent(fakeEvent("input"));
    t.app.querySelectorAll("button").find((b) => b.textContent === "Review").click();
    await flush();
    expect(t.state.route).toBe("confirm");
    t.app.querySelector(".subnav-back").click();
    await flush();
    expect(values()).toEqual([B, "0.02", "satay twice"]);
    expect(filledNote()).toMatch(/Testnet/);
    // Amélie's and Chen's: the phone's Back threw the link's payment away without a word. It asks.
    history.back();
    await flush();
    expect(question(t)).toBeTruthy();
    // The question's own Back is Stay: the payment stays.
    history.back();
    await flush();
    expect([question(t), t.state.route, ...values(), history.closed]).toEqual([null, "send", B, "0.02", "satay twice", false]);
    // Asked again, Stay keeps it too.
    t.app.querySelector(".subnav-back").click();
    await flush();
    stay(t);
    await flush();
    expect([question(t), t.state.route, ...values()]).toEqual([null, "send", B, "0.02", "satay twice"]);
    // Leave: Home, and none of it in the next Send.
    history.back();
    await flush();
    leave(t);
    await flush();
    expect(t.state.route).toBe("home");
    await openSend();
    expect(values()).toEqual(["", "", ""]);
    expect(filledNote()).toBe("");

    await pasteLink();
    // Mainnet, the form still open: nothing of the request stays to pay there.
    t.open = { ...t.open, nodeUrl: "https://nodes.dusk.network", networkName: "Mainnet" };
    await t.render({ forceRefresh: true });
    await flush();
    expect([t.state.route, ...values()]).toEqual(["send", "", "", ""]);
    // Saying why, the only thing said under the fields: the request's network, Testnet, and the one it's on, Mainnet,
    // each in its place; and as the wallet's own words have it.
    const said = t.app.querySelectorAll(".field-error").map(visibleText).filter(Boolean);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/request[^.]*Testnet/i);
    expect(said[0]).toMatch(/you[^.]*Mainnet/i);
    const { chainMismatchText } = await import("./views/send.js");
    expect(said).toEqual([chainMismatchText("dusk:2", "https://nodes.dusk.network")]);
  });
});

// The page's history with each entry's address, as a browser keeps it: an
// entry pushed takes the address shown, replaceState rewrites the one it's on,
// Back and go() move with a popstate, and `location` (what a reload opens) is
// the address of the entry it's on.
function addressedHistory(win, first) {
  const entries = [{ state: null, url: first }];
  let at = 0;
  const shown = () => new URL(entries[at].url, "moz-extension://wallet");
  vi.stubGlobal("location", {
    get pathname() {
      return shown().pathname;
    },
    get search() {
      return shown().search;
    },
  });
  return {
    closed: false,
    get state() {
      return entries[at].state;
    },
    get at() {
      return at;
    },
    get url() {
      return entries[at].url;
    },
    get urls() {
      return entries.map((entry) => entry.url);
    },
    pushState(state, _title, url) {
      entries.splice(at + 1, Infinity, { state, url: url ?? entries[at].url });
      at++;
    },
    replaceState(state, _title, url) {
      entries[at] = { state, url: url ?? entries[at].url };
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
      setTimeout(() => win.dispatchEvent(fakeEvent("popstate", { state: entries[at].state })), 0);
    },
  };
}

// Amélie's: after paying a link and Done, or after Back from its Send, pulling the
// page down brought the same payment back, filled in: the wallet's entries for
// the phone's Back kept the link in their address, and Done stepped back onto one.
describe("a request link the extension's tab opened with", () => {
  const opened = async () => {
    const { makePaymentLink } = await import("@dusk-network/app-core/payment-links");
    const link = makePaymentLink({ amount: "0.02", memo: "Cadeau", network: "testnet", to: B }).https;
    let history;
    const t = await popupOn("send", { addressBook: { loaded: true, items: [] } }, undefined, {
      history: (win) => (history = addressedHistory(win, `/full.html?route=send&link=${encodeURIComponent(link)}`)),
    });
    const field = (name) => t.app.querySelectorAll("input, textarea").find((f) => accessibleName(f) === name);
    expect(["To", "Amount", "Memo"].map((name) => field(name).value)).toEqual([B, "0.02", "Cadeau"]);
    return { t, history, button: (text) => t.app.querySelectorAll("button").find((b) => b.textContent === text) };
  };
  // Pulling the page down: it opens again at the address it's on.
  const reloaded = async () => {
    vi.resetModules();
    const { state } = await import("./state.js");
    return [state.route, state.draft];
  };
  const settled = async () => {
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flush();
  };

  it("is off the page's address once it's paid and Done, from every entry it comes back to", async () => {
    const { t, history, button } = await opened();
    button("Review").click();
    await settled();
    pastClickGuard();
    confirmOf(t.app).click();
    await settled();
    expect(t.state.route).toBe("sent");
    button("Done").click();
    await settled();

    expect(t.state.route).toBe("home");
    expect(history.url).toBe("/full.html");
    expect(await reloaded()).toEqual(["home", null]);
  });

  it("is off it once its Send is left with Back, and stays while it's paid", async () => {
    const { t, history, button } = await opened();
    // Review and back to the form: still the link's.
    button("Review").click();
    await settled();
    t.app.querySelector(".subnav-back").click();
    await settled();
    expect(t.state.route).toBe("send");
    expect(history.url).toContain("link=");

    t.app.querySelector(".subnav-back").click();
    await settled();
    // It asks first; Leave goes.
    leave(t);
    await settled();
    expect(t.state.route).toBe("home");
    expect(history.url).toBe("/full.html");
    expect(await reloaded()).toEqual(["home", null]);

    // Firefox's Forward, onto an entry the wallet put up for Review: no link there either.
    expect(history.urls.at(-1)).toContain("link=");
    history.go(history.urls.length - 1 - history.at);
    await settled();
    expect(history.url).not.toContain("link=");
    expect(await reloaded()).toEqual(["home", null]);
  });
});

describe("coming back to the wallet during a payment", () => {
  // Amélie's, in Firefox for Android: back online, she confirmed again, and Sent said "Waiting
  // for a block" for 4.5 minutes, the payment long in its block: its watcher never answered.
  it("looks the payment up by its ID once its watcher has said nothing for 20 seconds", async () => {
    const HASH = "9d".repeat(32);
    const t = await popupOn(
      "sent",
      { addressBook: { loaded: true, items: [] }, sent: { phase: "sent", status: "submitted", hash: HASH, title: "Send", amountLux: "10000000", feeCapLux: "2500000", sentAt: Date.now() - 21_000, startedAt: Date.now() - 22_000 } },
      async (message, t) => {
        if (message.type === "DUSK_UI_RECHECK_TX" && message.hash === HASH) {
          t.open = { ...t.open, txs: [{ hash: HASH, status: "executed", submittedAt: Date.now() - 21_000, feePaid: "1856521", blockHeight: "4831109" }] };
          return { ok: true };
        }
        return undefined;
      }
    );
    // Completed, in its block, with its fee.
    await vi.waitFor(() => expect(finalStep(t)).toEqual({ done: true, sub: expect.stringMatching(exactly("4,831,109")) }));
    expect(t.asked("DUSK_UI_RECHECK_TX").map((m) => m.hash)).toEqual([HASH]);
    expect(rowValue(t.app, /fee/i)).toBe("0.001856521 DUSK");
  });

  // Lena's: Completed, in its block, said "Network fee Up to 0,0025 DUSK" 47 s after the
  // connection came back: the node hadn't answered with its fee as it completed.
  it("reads a completed payment's fee again once the connection is back, and says it", async () => {
    const HASH = "9c".repeat(32);
    let fee = null;
    const t = await popupOn(
      "sent",
      { addressBook: { loaded: true, items: [] }, sent: { phase: "sent", status: "executed", hash: HASH, title: "Send", amountLux: "10000000", feeCapLux: "2500000", blockHeight: "4833511", sentAt: Date.now(), startedAt: Date.now() } },
      async (message, t) => {
        if (message.type === "DUSK_UI_RECHECK_TX" && message.hash === HASH) {
          fee = "1856956";
          t.open = { ...t.open, txs: [{ hash: HASH, status: "executed", submittedAt: Date.now() - 30_000, feePaid: fee, blockHeight: "4833511" }] };
          return { ok: true };
        }
        return undefined;
      }
    );
    t.open = { ...t.open, txs: [{ hash: HASH, status: "executed", submittedAt: Date.now() - 30_000, blockHeight: "4833511" }] };
    await t.render({ forceRefresh: true });
    // The most its fee can be, till the real one's read: then that, exactly.
    expect(rowValue(t.app, /fee/i)).toBe("Up to 0.0025 DUSK");

    t.dom.window.dispatchEvent(fakeEvent("online"));
    await vi.waitFor(() => expect(rowValue(t.app, /fee/i)).toBe("0.001856956 DUSK"));
    expect(fee).toBe("1856956");
  });

  // Lena's, the third round: the node went silent at Confirm and answered again 26 s later, and Completed kept
  // "Network fee Up to 0,0025 DUSK" 42 s after that: a read under way when it went silent never ended, and the
  // look-ups waited on it.
  it("goes on looking a completed payment's fee up though a read under way never ends, and says the fee it hears", async () => {
    const HASH = "9a".repeat(32);
    let silent = false;
    let looks = 0;
    const t = await popupOn(
      "sent",
      { addressBook: { loaded: true, items: [] }, sent: { phase: "sent", status: "executed", hash: HASH, title: "Send", amountLux: "10000000", feeCapLux: "2500000", blockHeight: "4854743", sentAt: Date.now(), startedAt: Date.now() } },
      async (message, t) => {
        // A read the silent node holds, for good.
        if (silent && message.type === "DUSK_UI_OVERVIEW") return new Promise(() => {});
        if (message.type === "DUSK_UI_RECHECK_TX" && message.hash === HASH) {
          looks += 1;
          // The node answers again from the second look on (the read it held stays held): the wallet tells the page
          // the block and fee it writes.
          if (looks > 1) {
            silent = false;
            t.deliver({ type: "DUSK_UI_TX_STATUS", hash: HASH, status: "executed", ok: true, feePaid: "1857579", blockHeight: "4854743" });
          }
          return { ok: true, result: { status: "executed" } };
        }
        return undefined;
      }
    );
    t.open = { ...t.open, txs: [{ hash: HASH, status: "executed", submittedAt: Date.now(), blockHeight: "4854743" }] };
    await t.render({ forceRefresh: true });
    // The most its fee can be, till the real one's read.
    expect(rowValue(t.app, /fee/i)).toBe("Up to 0.0025 DUSK");
    silent = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Looked up as the connection comes back, then every 10 s, however the reads in between went.
      t.dom.window.dispatchEvent(fakeEvent("online"));
      await vi.advanceTimersByTimeAsync(0);
      expect(looks).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(looks).toBe(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(rowValue(t.app, /fee/i)).toBe("0.001857579 DUSK");
    } finally {
      vi.useRealTimers();
    }
  });

  // Astra's, as the web wallet does it: Don't send, on one whose hand-over had no clear answer, forgot it, saying
  // nothing left the wallet, though it might still arrive. It's followed by its ID while the wallet shows, whatever
  // its age, and listed nowhere meanwhile; once it went after all, it's listed as Sent, and said so.
  it("follows a send chosen not to be sent, listing it nowhere, and says so once it went after all", async () => {
    const HASH = "9e".repeat(32);
    let arrived = false;
    const record = { hash: HASH, kind: "transfer", privacy: "public", to: TO, amount: "10000000", status: "unsent", dontSendAt: Date.now() - 60_000, submittedAt: Date.now() - 2 * 60 * 60_000, account: A, nonce: "7", nodeUrl: "https://testnet.nodes.dusk.network", walletId: A, profileIndex: 0, source: "sent", origin: "Wallet" };
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] } }, async (message, t) => {
      if (message.type === "DUSK_UI_RECHECK_TX" && message.hash === HASH) {
        if (!arrived) return { ok: true, result: { status: "unsent" } };
        t.open = { ...t.open, txs: [{ ...record, status: "executed", dontSendAt: undefined, wentAfterAll: Date.now() }] };
        return { ok: true, result: { status: "executed", wentAfterAll: true } };
      }
      return undefined;
    });
    // The wallet's own words for that status and that news, checked besides the words themselves.
    const { txStatusWord } = await import("./views/txDisplay.js");
    const { WENT_AFTER_ALL_TEXT } = await import("./views/sent.js");
    const toast = () => t.dom.document.body.querySelector(".toast")?.textContent ?? "";
    const back = async () => {
      t.dom.document.visibilityState = "visible";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      await flush();
    };
    t.open = { ...t.open, txs: [record] };
    await t.render({ forceRefresh: true });
    await flush();
    // Listed nowhere: no row of it, nor a word that it's not sent yet.
    expect(t.app.querySelectorAll(".tx-row")).toEqual([]);
    expect(t.app.textContent).not.toContain("Not sent yet");
    expect(t.app.textContent).not.toContain(txStatusWord("unsent"));
    await back();
    expect(t.asked("DUSK_UI_RECHECK_TX").map((m) => m.hash)).toEqual([HASH]);
    expect(toast()).not.toMatch(/went out after all/i);
    arrived = true;
    await back();
    expect(t.asked("DUSK_UI_RECHECK_TX").map((m) => m.hash)).toEqual([HASH, HASH]);
    // Then said: it went out after all.
    await vi.waitFor(() => expect(toast()).toMatch(/went out after all/i));
    expect(toast()).toContain(WENT_AFTER_ALL_TEXT);
  });

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
    // Waiting for a block: not Completed yet, and the most its fee can be.
    expect(finalStep(t)).toEqual({ done: false, sub: "" });
    expect(rowValue(t.app, /fee/i)).toBe("Up to 0.0025 DUSK");
    expect(t.asked("DUSK_UI_RECHECK_TX")).toEqual([]);

    // Home pressed, then back after the block: the page shows again.
    t.dom.document.visibilityState = "visible";
    t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    await flush();
    expect(t.asked("DUSK_UI_RECHECK_TX").map((m) => m.hash)).toEqual([HASH]);
    // Completed, in its block, with its real fee.
    expect(finalStep(t)).toEqual({ done: true, sub: expect.stringMatching(exactly("4,802,949")) });
    expect(rowValue(t.app, /fee/i)).toBe("0.002135802 DUSK");
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

  // Astra's: Android ended the app with a Send a link filled in open. Back, it opened on that Send, and
  // left with Back, the link's payment came back in the next Send begun by hand, as one typed would.
  it("opens on a link's Send again after Android ended the app, and keeps none of it for the next Send", async () => {
    const kept = new Map();
    vi.stubGlobal("localStorage", { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k) });
    const field = (t, name) => t.app.querySelectorAll("input, textarea").find((f) => accessibleName(f) === name);
    const values = (t) => ["To", "Amount", "Memo"].map((name) => field(t, name)?.value);
    const filled = { to: B, amountDusk: "0.01", memo: "Deep link test", requestChainId: "dusk:2", filledFrom: "link", filledIn: true };
    const open = await popupOn("send", { addressBook: { loaded: true, items: [] }, draft: filled }, undefined, { tauri: tauriBridge() });
    open.dom.document.visibilityState = "hidden";
    open.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    // Kept on the phone for that: the payment, never a password.
    expect(JSON.stringify([...kept.values()])).toContain(B);
    expect(JSON.stringify([...kept.values()])).not.toMatch(/password/i);

    // Android ends the app; opened again, it's on that Send, as the link filled it in, for the network it pays on.
    const back = await popupOn("home", { addressBook: { loaded: true, items: [] }, draft: null }, undefined, { tauri: tauriBridge() });
    expect(back.state.route).toBe("send");
    expect(values(back)).toEqual([B, "0.01", "Deep link test"]);
    expect(visibleText(back.app.querySelector(".send-filled-note"))).toMatch(/Testnet/);

    // Left with Back, once Leave is pressed: the next Send, begun by hand on Home, is empty.
    back.app.querySelector(".subnav-back").click();
    await flush();
    leave(back);
    await flush();
    expect(back.state.route).toBe("home");
    back.app.querySelectorAll("button.action-btn").find((b) => b.textContent.trim() === "Send").click();
    await flush();
    expect(back.state.route).toBe("send");
    expect(values(back)).toEqual(["", "", ""]);
  });

  // Chen's: a tap on "Your payment arrived" showed "Not confirmed", then Completed: the notice knew it had
  // arrived, and its block.
  it("opens a notice's payment as the notice knew it, and only with the notice's token", async () => {
    const HASH = "9b".repeat(32);
    const TOKEN = "c4".repeat(16);
    const record = { hash: HASH, kind: "transfer", privacy: "public", to: B, amount: "10000000", status: "unknown", submittedAt: Date.now() - 60_000, profileIndex: 0, nodeUrl: "https://testnet.nodes.dusk.network" };
    let opened = { hash: "" };
    const bridge = tauriBridge({ notices: (args) => (args?.action === "opened" ? { allowed: true, ...opened } : { allowed: true }) });
    const answer = async (message, t) => {
      // The wallet takes a tap as its notice's only with the token it gave that send's notice.
      if (message.type === "DUSK_UI_TX_NOTICED") {
        if (message.hash !== HASH || message.token !== TOKEN) return { ok: true, result: null };
        t.open = { ...t.open, txs: [{ ...record, status: message.status, blockHeight: message.blockHeight }] };
        return { ok: true, result: { patched: true } };
      }
      // The node doesn't answer yet as the app comes back: Android cut its network while away.
      if (message.type === "DUSK_UI_CHECK_NODE" || message.type === "DUSK_UI_RECHECK_TX") return new Promise(() => {});
      return undefined;
    };
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] } }, answer, { tauri: bridge });
    // What was read while the app was away: the node offline, the send not heard of.
    t.open = { ...t.open, txs: [record], networkStatus: { nodeStatus: "offline", nodeUrl: t.open.nodeUrl } };
    const comeBack = async () => {
      t.dom.document.visibilityState = "hidden";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      t.dom.document.visibilityState = "visible";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      await flush();
    };

    // Astra's: any app can open the wallet as a tap would, with a send's ID it learned and an outcome of
    // its own. Without the notice's token, or with another, it opens nothing and says nothing of the send.
    for (const forged of [{ hash: HASH, outcome: "failed", block: 1 }, { hash: HASH, outcome: "failed", block: 1, token: "d5".repeat(16) }]) {
      opened = forged;
      await comeBack();
      await flush();
      expect(t.state.route).toBe("home");
    }
    expect(t.asked("DUSK_UI_TX_NOTICED")).toEqual([expect.objectContaining({ hash: HASH, token: "d5".repeat(16) })]);

    opened = { hash: HASH, outcome: "executed", block: 4831109, token: TOKEN };
    await comeBack();
    await vi.waitFor(() => expect(t.state.route).toBe("tx"));
    await flush();
    expect(t.asked("DUSK_UI_TX_NOTICED").at(-1)).toEqual(expect.objectContaining({ hash: HASH, token: TOKEN, status: "executed", blockHeight: "4831109" }));
    expect(t.state.txDetailHash).toBe(HASH);
    // Completed, as the notice knew it, never Not confirmed (nor Failed) while the node can't be asked.
    expect(paymentStatus(t)).toEqual({ ok: true, word: "Completed" });
    opened = { hash: "" };
  });

  // Sofía's and Chen's: tapped from the Sent screen left with Home, "Your payment arrived" showed "Taking longer than
  // usual" and a red "Can't reach the network" for 1 to 5 s before Completed, as the app's network came back.
  it("opens a notice's payment from the Sent screen at once, as the notice knew it, though reads wait on the network coming back", async () => {
    const HASH = "9d".repeat(32);
    const TOKEN = "c5".repeat(16);
    let opened = { hash: "" };
    // Back from away, the network isn't back yet: reads fail at once, or wait on it.
    let away = "";
    const bridge = tauriBridge({ notices: (args) => (args?.action === "opened" ? { allowed: true, ...opened } : { allowed: true }) });
    const record = { hash: HASH, kind: "transfer", privacy: "public", to: B, amount: "10000000", status: "submitted", submittedAt: Date.now() - 30_000, profileIndex: 0, nodeUrl: "https://testnet.nodes.dusk.network" };
    const answer = async (message, t) => {
      if (message.type === "DUSK_UI_TX_NOTICED") {
        if (message.hash !== HASH || message.token !== TOKEN) return { ok: true, result: null };
        // Written on its record, and the page told, as the app's wallet does it.
        t.deliver({ type: "DUSK_UI_TX_STATUS", hash: HASH, status: "executed", ok: true, blockHeight: "4846300" });
        return { ok: true, result: { patched: true } };
      }
      if (away === "waits" && message.type === "DUSK_UI_OVERVIEW") return new Promise(() => {});
      if (away === "fails" && message.type === "DUSK_UI_OVERVIEW") return { ...t.open, balance: null, balanceError: "Failed to fetch", networkStatus: { nodeStatus: "offline", nodeUrl: t.open.nodeUrl } };
      if (away && message.type === "DUSK_UI_CHECK_NODE") return { ok: true, networkStatus: { nodeStatus: "offline", nodeUrl: t.open.nodeUrl } };
      if (message.type === "DUSK_UI_RECHECK_TX") {
        // Not found by a node it couldn't ask: its record says unknown, and the page is told so,
        // at once, or once the lookup gives up, after the notice's payment is open.
        const giveUp = () => {
          t.deliver({ type: "DUSK_UI_TX_STATUS", hash: message.hash, status: "unknown" });
          return { ok: true, result: { status: "unknown", error: "reconciliation_unavailable" } };
        };
        return holdLookups ? new Promise((resolve) => heldLookups.push(() => resolve(giveUp()))) : giveUp();
      }
      return undefined;
    };
    let holdLookups = false;
    const heldLookups = [];
    const sent = () => ({ phase: "sent", status: "submitted", hash: HASH, title: "Send", amountLux: "10000000", feeCapLux: "2500000", sentAt: Date.now() - 30_000, startedAt: Date.now() - 31_000 });
    const t = await popupOn("sent", { addressBook: { loaded: true, items: [] }, sent: sent() }, answer, { tauri: bridge });
    t.open = { ...t.open, txs: [record] };
    await t.render({ forceRefresh: true });
    // The payment's page as it says Completed (never Failed, nor Not confirmed); and a toast that a payment is still
    // pending, in those words or the wallet's own for it.
    const completed = { ok: true, word: "Completed" };
    const { txStatusToast } = await import("./txToast.js");
    const stillPending = (text) => /still pending/i.test(text) || text.includes(txStatusToast(null, "unknown").parts.at(-1).trim());
    // What shows each moment: the Sent screen's phase and its current step, or the payment's own status; and the toasts.
    const shown = [];
    const now = () => ({
      sent: t.app.querySelector(".sent")?.getAttribute("data-phase") ?? null,
      step: t.app.querySelector(".step.is-current .step-sub")?.textContent ?? "",
      payment: paymentStatus(t),
      toasts: t.dom.document.body.querySelectorAll(".toast").map((el) => el.textContent),
    });
    // Never Not confirmed (its own phase) or taking long: the Sent screen looks the payment up; its own page says
    // Completed; and no toast says it's still pending.
    const wrong = (m) =>
      m.toasts.some(stillPending) ||
      (m.sent !== null && (m.sent !== "sent" || !/look/i.test(m.step))) ||
      (m.payment !== null && (m.payment.ok !== completed.ok || m.payment.word !== completed.word));
    const leaveAndComeBack = async (how) => {
      t.dom.document.visibilityState = "hidden";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      away = how;
      t.dom.document.visibilityState = "visible";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      shown.push(now());
      for (let i = 0; i < 6; i++) {
        await flush();
        shown.push(now());
      }
    };

    // Back without a notice, the node not answered yet: being looked up, never taking long.
    await leaveAndComeBack("fails");
    expect(t.state.route).toBe("sent");
    expect(shown.filter(wrong)).toEqual([]);

    // Back from the notice's tap: the payment as the notice knew it, at once, though the read waits.
    away = "";
    await t.render({ forceRefresh: true });
    shown.length = 0;
    opened = { hash: HASH, outcome: "executed", block: 4846300, token: TOKEN };
    holdLookups = true;
    await leaveAndComeBack("waits");
    // The payment's own page, drawn, not the Sent screen behind it: Completed.
    await vi.waitFor(() => expect(paymentStatus(t)).toEqual(completed));
    expect([t.state.route, t.state.txDetailHash, now().sent]).toEqual(["tx", HASH, null]);
    // The lookups that couldn't ask the node give up after it, saying unknown: it stays Completed, and no toast says
    // it's still pending (seen on the phone).
    expect(heldLookups.length).toBeGreaterThan(0);
    for (const giveUp of heldLookups.splice(0)) giveUp();
    for (let i = 0; i < 6; i++) {
      await flush();
      shown.push(now());
    }
    expect(shown.filter(wrong)).toEqual([]);
    expect(paymentStatus(t)).toEqual(completed);
    opened = { hash: "" };
  });

  // Sofía's: no notice when a client paid her. Android's job tells money that came in (android/ArrivalJob.kt); its
  // tap opens that payment, in the profile it came to, once the wallet is open, and only with the wallet's token.
  it("opens a notice of money that came in on its payment, in the profile it came to, after the unlock where it's locked", async () => {
    const HASH = "9e".repeat(32);
    const TOKEN = "c6".repeat(16);
    const TO = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
    let opened = { hash: "" };
    const bridge = tauriBridge({ notices: (args) => (args?.action === "opened" ? { allowed: true, ...opened } : { allowed: true }) });
    const answer = async (message, t) => {
      if (message.type === "DUSK_UI_TX_NOTICED") {
        // The wallet's token for those notices, to one of its profiles, while it's open.
        const ok = t.open.isUnlocked && message.hash === HASH && message.token === TOKEN && message.account === TO;
        return { ok: true, result: ok ? { incoming: true, profileIndex: 1 } : null };
      }
      if (message.type === "DUSK_UI_SET_ACCOUNT_INDEX") {
        t.open = { ...t.open, selectedAccountIndex: message.index };
        return { ok: true };
      }
      return undefined;
    };
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] } }, answer, { tauri: bridge });
    const comeBack = async () => {
      t.dom.document.visibilityState = "hidden";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      t.dom.document.visibilityState = "visible";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      await flush();
    };

    // Another app's forged tap, without the wallet's token: nothing opens.
    opened = { hash: HASH, outcome: "executed", block: 4851300, token: "d5".repeat(16), account: TO };
    await comeBack();
    await flush();
    expect([t.state.route, t.asked("DUSK_UI_SET_ACCOUNT_INDEX")]).toEqual(["home", []]);

    // Locked as the app was left: opened once it's unlocked, in Profile 2, where it came.
    t.open = { ...t.open, isUnlocked: false };
    await t.render({ forceRefresh: true });
    opened = { hash: HASH, outcome: "executed", block: 4851300, token: TOKEN, account: TO };
    await comeBack();
    await flush();
    expect(t.state.route).not.toBe("tx");
    t.open = { ...t.open, isUnlocked: true };
    await t.render({ forceRefresh: true });
    await vi.waitFor(() => expect(t.state.route).toBe("tx"));
    expect(t.asked("DUSK_UI_SET_ACCOUNT_INDEX")).toEqual([expect.objectContaining({ index: 1 })]);
    expect(t.state.txDetailHash).toBe(HASH);
    opened = { hash: "" };
  });

  // Chen's, again: the tap showed the Sent screen left, "Looking it up again…", for 2 to 6 s on the phone, while the
  // wallet wrote the notice's news on the send's record. Android knows its own notice's token: opened at once.
  it("opens the app's own notice at once, as the notice knew it, before the send's record is written", async () => {
    const HASH = "9f".repeat(32);
    const TOKEN = "c7".repeat(16);
    let opened = { hash: "" };
    const bridge = tauriBridge({ notices: (args) => (args?.action === "opened" ? { allowed: true, ...opened } : { allowed: true }) });
    const record = { hash: HASH, kind: "transfer", privacy: "public", to: B, amount: "10000000", status: "submitted", submittedAt: Date.now() - 30_000, profileIndex: 0, nodeUrl: "https://testnet.nodes.dusk.network" };
    // The wallet's word on the tap waits, as it did on the phone just back.
    const noticed = [];
    const answer = async (message) => {
      if (message.type === "DUSK_UI_TX_NOTICED") return new Promise((resolve) => noticed.push(resolve));
      if (message.type === "DUSK_UI_RECHECK_TX" || message.type === "DUSK_UI_CHECK_NODE") return new Promise(() => {});
      return undefined;
    };
    const sent = { phase: "sent", status: "submitted", hash: HASH, title: "Send", amountLux: "10000000", feeCapLux: "2500000", sentAt: Date.now() - 30_000, startedAt: Date.now() - 31_000 };
    const t = await popupOn("sent", { addressBook: { loaded: true, items: [] }, sent }, answer, { tauri: bridge });
    t.open = { ...t.open, txs: [record] };
    await t.render({ forceRefresh: true });
    const leaveAndComeBack = async () => {
      t.dom.document.visibilityState = "hidden";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      t.dom.document.visibilityState = "visible";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      await flush();
    };

    // A tap Android doesn't know as its notice's: nothing opens before the wallet says so.
    opened = { hash: HASH, outcome: "executed", block: 4851400, token: TOKEN, ours: false };
    await leaveAndComeBack();
    await flush();
    expect(t.state.route).toBe("sent");
    noticed.splice(0).forEach((resolve) => resolve({ ok: true, result: null }));
    await flush();
    expect(t.state.route).toBe("sent");

    // Its own: the payment's page, Completed (never Failed), while the wallet's word still waits; the Sent screen,
    // looking it up again, gone.
    const completed = { ok: true, word: "Completed" };
    opened = { hash: HASH, outcome: "executed", block: 4851400, token: TOKEN, ours: true };
    await leaveAndComeBack();
    await vi.waitFor(() => expect(paymentStatus(t)).toEqual(completed));
    expect(noticed).toHaveLength(1);
    expect([t.state.txDetailHash, t.app.querySelector(".sent")]).toEqual([HASH, null]);
    noticed.splice(0).forEach((resolve) => resolve({ ok: true, result: { patched: true } }));
    await flush();
    expect(t.state.route).toBe("tx");
    expect(paymentStatus(t)).toEqual(completed);
    opened = { hash: "" };
  });

  it("opens on Home after it was ended with Send open but sent, or for another profile", async () => {
    const kept = new Map();
    vi.stubGlobal("localStorage", { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k) });
    const typed = await popupOn("send", { addressBook: { loaded: true, items: [] }, draft: { to: B, amountDusk: "0.02", memo: "satay" } }, undefined, { tauri: tauriBridge() });
    typed.dom.document.visibilityState = "hidden";
    typed.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    // Opened on another profile: not its Send.
    const profileTwo = async (message, t) => (message.type === "DUSK_UI_OVERVIEW" ? { ...t.open, selectedAccountIndex: 1 } : undefined);
    const other = await popupOn("home", { addressBook: { loaded: true, items: [] }, draft: null }, profileTwo, { tauri: tauriBridge() });
    expect(other.state.route).toBe("home");

    // Sent from the Send it opened on: nothing is kept for the next start.
    const t = await popupOn("send", { addressBook: { loaded: true, items: [] }, draft: { to: B, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" } }, undefined, { tauri: tauriBridge() });
    t.state.route = "confirm";
    await t.render();
    await flush();
    t.dom.document.visibilityState = "hidden";
    t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    t.dom.document.visibilityState = "visible";
    t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    await flush();
    pastClickGuard();
    confirmOf(t.app).click();
    await flush();
    expect(t.asked("DUSK_UI_SEND_TX")).toHaveLength(1);
    const after = await popupOn("home", { addressBook: { loaded: true, items: [] }, draft: null }, undefined, { tauri: tauriBridge() });
    expect(after.state.route).toBe("home");
  });

  // Chen's wish: lock when I leave the app, as phone wallets' Auto-lock: Immediately.
  it("locks as the person leaves it with Auto-lock: Immediately, not for the share sheet, and not otherwise", async () => {
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

    // Immediately, in Settings: one of Auto-lock's choices in the app.
    t.state.route = "options";
    await t.render({ forceRefresh: true });
    const autoLock = () => t.app.querySelector("#auto-lock");
    expect(autoLock().querySelectorAll("option").map((o) => o.value)).toContain("leave");
    autoLock().value = "leave";
    autoLock().dispatchEvent(fakeEvent("change"));
    await flush();
    expect(t.asked("DUSK_UI_SET_LOCK_ON_LEAVE").at(-1)).toMatchObject({ lockOnLeave: true });
    t.open = { ...t.open, lockOnLeave: true };
    await t.render({ forceRefresh: true });
    expect(autoLock().value).toBe("leave");

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
    expect(t.app.querySelector("input[type=password]")).toBeTruthy();
    expect(autoLock()).toBeNull();
  });

  // Astra's: with Immediately on, a Send a link filled in came back empty from the lock: its password
  // was asked on Home, and what the link filled in went as if its Send had been left.
  it("returns after Immediately's lock to a Send a link filled in, with what the link filled in", async () => {
    const locks = async (message, t) => {
      if (message.type === "DUSK_UI_LOCK") {
        t.open = { ...t.open, isUnlocked: false };
        t.deliver({ type: "DUSK_UI_LOCK_STATE", isUnlocked: false });
        return { ok: true };
      }
      if (message.type === "DUSK_UI_UNLOCK") {
        t.open = { ...t.open, isUnlocked: true };
        return { ok: true };
      }
      return undefined;
    };
    const filled = { to: B, amountDusk: "0.01", memo: "Deep link test", requestChainId: "dusk:2", filledFrom: "link", filledIn: true };
    const t = await popupOn("send", { addressBook: { loaded: true, items: [] }, draft: filled }, locks, { tauri: tauriBridge() });
    t.open = { ...t.open, lockOnLeave: true };
    await t.render({ forceRefresh: true });
    const field = (name) => t.app.querySelectorAll("input, textarea").find((f) => accessibleName(f) === name);
    expect(["To", "Amount", "Memo"].map((name) => field(name).value)).toEqual([B, "0.01", "Deep link test"]);

    t.dom.document.visibilityState = "hidden";
    t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    await flush();
    t.dom.document.visibilityState = "visible";
    t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    await flush();
    expect(t.asked("DUSK_UI_LOCK")).toHaveLength(1);
    t.app.querySelector("#unlock-password").value = "the password";
    t.app.querySelectorAll("button").find((b) => b.textContent === "Unlock").click();
    await flush();
    expect(t.state.route).toBe("send");
    expect(["To", "Amount", "Memo"].map((name) => field(name).value)).toEqual([B, "0.01", "Deep link test"]);
    // Still said to be the link's, for the network it pays on.
    expect(visibleText(t.app.querySelector(".send-filled-note"))).toMatch(/Testnet/);
  });

  it("opens Send filled in from a dusk: link it was opened with, and from one opened while it runs", async () => {
    const bridge = tauriBridge({ "plugin:deep-link|get_current": [LINK] });
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] } }, undefined, { tauri: bridge });
    await flush();
    // Send's fields, each by its name: undefined while Send isn't drawn.
    const values = () => ["To", "Amount", "Memo"].map((name) => t.app.querySelectorAll("input, textarea").find((f) => accessibleName(f) === name)?.value);
    expect(t.state.route).toBe("send");
    expect(values()).toEqual([B, "0.01", "Deep link test"]);

    // Another, from a chat, as the app runs: Send again, with that one's.
    t.state.route = "home";
    await t.render();
    bridge.emit([LINK.replace("0.01", "0.02").replace("Deep+link+test", "Second")]);
    await flush();
    expect([t.state.route, ...values()]).toEqual(["send", B, "0.02", "Second"]);

    // Lena's: one as the app comes back on Activity, while the wallet still
    // reads the node, which a phone just woken can take a minute to answer.
    t.state.route = "activity";
    await t.render();
    const answer = t.send.getMockImplementation();
    const node = Promise.withResolvers();
    t.send.mockImplementation(async (message) => (message.type === "DUSK_UI_OVERVIEW" ? (await node.promise, t.open) : answer(message)));
    bridge.emit([LINK.replace("0.01", "0.03").replace("Deep+link+test", "Third")]);
    await flush();
    // Send drawn, with the link's.
    expect(values()).toEqual([B, "0.03", "Third"]);
    node.resolve();
    await flush();
    expect(values()).toEqual([B, "0.03", "Third"]);

    // Lena's plain shape, dusk:<account>?amount=&memo=, read as the web wallet reads it.
    t.send.mockImplementation(answer);
    bridge.emit([`dusk:${B}?amount=0.04&memo=Plain`]);
    await flush();
    expect(values()).toEqual([B, "0.04", "Plain"]);
  });
});

// Amélie's: a request link opened the app, which had no wallet, on "Set up your Dusk Wallet", on Mainnet: for a second
// she thought her wallet and money were gone.
describe("a payment link that opens the app before there's a wallet in it", () => {
  const WEB = `https://apps.testnet.dusk.network/wallet/dashboard/send?to=${B}&amount=0.001&memo=Les+tulipes&network=testnet`;
  const fresh = { hasVault: false, isUnlocked: false, accounts: [], wallets: [], walletKey: null, networkName: "Mainnet", nodeUrl: "https://nodes.dusk.network" };
  const opened = async (link, answers = {}) => {
    const bridge = tauriBridge({ "plugin:deep-link|get_current": [link], ...answers });
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] }, draft: null }, async (message) => (message.type === "DUSK_UI_OVERVIEW" ? fresh : undefined), { tauri: bridge });
    await t.render({ forceRefresh: true });
    await flush();
    return { t, bridge };
  };
  const waiting = (t) => {
    const note = t.app.querySelector(".onboard-link");
    return note ? visibleText(note) : "";
  };

  afterEach(() => vi.useRealTimers());

  it("says on the setup screen that a payment link waits, for which network and since when, or hands it to the browser", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 17, 7, 2));
    const { t } = await opened(WEB, { open_in_browser: true });
    expect(t.state.route).toBe("onboard_welcome");
    // Chen's: it didn't say Testnet; Sofía's: nor when it was opened.
    expect(waiting(t)).toMatch(/Testnet/);
    expect(waiting(t)).toMatch(exactly("07:02"));
    expect(t.state.draft).toMatchObject({ to: B, memo: "Les tulipes", linkSetup: true });
    // Open in browser instead: handed to the phone's browser, never to the app, which Android gives these links to,
    // and nothing of it left here to pay too.
    t.app.querySelector(".onboard-link button").click();
    await flush();
    expect(t.dom.window.__TAURI_INTERNALS__.invoke).toHaveBeenCalledWith("open_in_browser", { url: WEB }, undefined);
    expect([waiting(t), t.state.draft]).toEqual(["", null]);
  });

  // Sofía's: another's link, opened on the shared phone, filled Send in right after her Import eleven minutes on, with
  // no time; and again with her own after Reset.
  it("says on Send when it was opened once the wallet's made within ten minutes, and goes past them", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const [minutes, filled] of [
      [8, true],
      [11, false],
    ]) {
      vi.setSystemTime(new Date(2026, 10, 17, 7, 2));
      const { t } = await opened(WEB);
      expect(t.state.draft).toMatchObject({ linkSetup: true });
      // The wallet made: Send, the link's, as the setup leaves it.
      vi.setSystemTime(new Date(2026, 10, 17, 7, 2 + minutes));
      t.send.mockImplementation(async (message) => (message.type === "DUSK_UI_OVERVIEW" ? { ...t.open, nodeUrl: "https://testnet.nodes.dusk.network" } : message.type === "DUSK_UI_GET_CACHED_GAS_PRICE" ? { ok: true, result: { min: "1", median: "1", max: "1" } } : { ok: true, result: null }));
      t.state.route = "send";
      await t.render({ forceRefresh: true });
      await flush();
      if (filled) {
        expect(t.state.route).toBe("send");
        // For which network, and when the link was opened.
        const note = visibleText(t.app.querySelector(".send-filled-note"));
        expect(note).toMatch(/Testnet/);
        expect(note).toMatch(exactly("07:02"));
      } else {
        expect([t.state.route, t.state.draft]).toEqual(["home", null]);
      }
    }
  });

  it("offers a dusk: link to the browser as its web wallet's link", async () => {
    const { t } = await opened(`dusk:public-${B}@dusk:2?amount=0.001&memo=Les+tulipes`, { open_in_browser: true });
    t.app.querySelector(".onboard-link button").click();
    await flush();
    expect(t.dom.window.__TAURI_INTERNALS__.invoke).toHaveBeenCalledWith("open_in_browser", { url: WEB }, undefined);
  });
});

describe("a payment link opened in the app while the wallet's locked", () => {
  const LINK = `dusk:public-${B}@dusk:2?amount=0.001&memo=Factura+2026-153`;
  // Locked: the wallet answers so till the password's given.
  const locked = async (message, t) => {
    if (message.type === "DUSK_UI_UNLOCK") {
      t.open = { ...t.open, isUnlocked: true };
      return { ok: true };
    }
    return undefined;
  };
  const opened = async () => {
    const bridge = tauriBridge();
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] }, draft: null }, locked, { tauri: bridge });
    t.open = { ...t.open, isUnlocked: false };
    await t.render({ forceRefresh: true });
    bridge.emit([LINK]);
    await flush();
    return t;
  };
  const unlock = async (t) => {
    t.app.querySelector("#unlock-password").value = "the password";
    t.app.querySelectorAll("button").find((b) => b.textContent === "Unlock").click();
    await flush();
  };
  // What Send says of what the link filled in.
  const filledNote = (t) => visibleText(t.app.querySelector(".send-filled-note"));

  afterEach(() => vi.useRealTimers());

  // Sofía's: a link opened while the wallet was locked filled Send in after a later unlock from the app's icon, even
  // one opened long before by someone else on a shared phone, saying nothing of where or when it came from.
  it("says on Send when it was opened, once unlocked within ten minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 15, 23, 51));
    const t = await opened();
    vi.setSystemTime(new Date(2026, 10, 15, 23, 59));
    await unlock(t);
    expect(t.state.route).toBe("send");
    expect(t.app.querySelector(".to-input-wrap textarea").value).toBe(B);
    // For which network, and when the link was opened.
    expect(filledNote(t)).toMatch(/Testnet/);
    expect(filledNote(t)).toMatch(exactly("23:51"));
  });

  // Astra's: unlocked at minute 8 and the form edited, a redraw at minute 10 threw the payment away.
  it("keeps it once it opened after an unlock in time, edited, through redraws past ten minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 15, 23, 51));
    const t = await opened();
    vi.setSystemTime(new Date(2026, 10, 15, 23, 59));
    await unlock(t);
    const memo = () => t.app.querySelectorAll("input").find((i) => accessibleName(i) === "Memo");
    memo().value = "Factura 2026-153, paid";
    memo().dispatchEvent(fakeEvent("input"));
    vi.setSystemTime(new Date(2026, 10, 16, 0, 5));
    await t.render({ forceRefresh: true });
    await flush();
    expect([t.state.route, t.app.querySelector(".to-input-wrap textarea").value, memo().value]).toEqual(["send", B, "Factura 2026-153, paid"]);
    expect(filledNote(t)).toMatch(/Testnet/);
    expect(filledNote(t)).toMatch(exactly("23:51"));
  });

  it("goes Home as usual on an unlock past ten minutes, the link's payment gone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 15, 23, 51));
    const t = await opened();
    vi.setSystemTime(new Date(2026, 10, 16, 0, 2));
    await unlock(t);
    expect([t.state.route, t.state.draft]).toEqual(["home", null]);
  });
});

// Amélie's, Chen's and Marek's, in Firefox for Android: a link opened from the
// web wallet's page sent the wallet's tab, open already, to Send's address, and
// the phone's Back went to the page it showed before, Home, without a word.
describe("a request link handed to the wallet's tab open already", () => {
  it("fills Send in on the page as it is, with a link for its own tab only", async () => {
    const { makePaymentLink } = await import("@dusk-network/app-core/payment-links");
    const link = makePaymentLink({ amount: "0.02", memo: "popiah", network: "testnet", to: B }).https;
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] }, draft: null }, undefined, {
      // A page pressed in before, as a browser keeps it: no press now.
      history: (win) => {
        win.navigator = { userActivation: { isActive: false, hasBeenActive: true } };
        return pageHistory(win);
      },
      tab: { id: 7 },
    });
    const values = () => ["To", "Amount", "Memo"].map((name) => t.app.querySelectorAll("input, textarea").find((f) => accessibleName(f) === name)?.value);
    const answered = vi.fn();

    // Another tab's link: this page's left as it is.
    t.deliver({ type: "DUSK_UI_OPEN_LINK", tabId: 8, link }, {}, answered);
    await flush();
    expect([t.state.route, answered.mock.calls.length]).toEqual(["home", 0]);

    t.deliver({ type: "DUSK_UI_OPEN_LINK", tabId: 7, link }, {}, answered);
    await flush();
    expect(answered.mock.calls).toEqual([[{ ok: true }]]);
    expect([t.state.route, ...values()]).toEqual(["send", B, "0.02", "popiah"]);
    // Said to be the link's, for the network it pays on.
    expect(visibleText(t.app.querySelector(".send-filled-note"))).toMatch(/Testnet/);
  });
});

// Astra's: a link handed to the tab in place left the request the tab was opened with in its address, and a reload,
// or Firefox bringing the tab back, filled Send with that one.
describe("a request link handed to a wallet tab opened with another", () => {
  it("takes the one the tab was opened with off its address, from every entry it comes back to", async () => {
    const { makePaymentLink } = await import("@dusk-network/app-core/payment-links");
    const before = makePaymentLink({ amount: "0.02", memo: "Cadeau", network: "testnet", to: B }).https;
    const handed = makePaymentLink({ amount: "0.05", memo: "Laksa", network: "testnet", to: B }).https;
    let history;
    const t = await popupOn("send", { addressBook: { loaded: true, items: [] } }, undefined, {
      history: (win) => (history = addressedHistory(win, `/full.html?route=send&link=${encodeURIComponent(before)}`)),
      tab: { id: 7 },
    });
    const values = () => ["To", "Amount", "Memo"].map((name) => t.app.querySelectorAll("input, textarea").find((f) => accessibleName(f) === name)?.value);
    expect(values()).toEqual([B, "0.02", "Cadeau"]);
    t.deliver({ type: "DUSK_UI_OPEN_LINK", tabId: 7, link: handed }, {}, vi.fn());
    await flush();
    expect(values()).toEqual([B, "0.05", "Laksa"]);
    expect(history.url).toBe("/full.html");
    // Pulled down: the wallet, not the request it was opened with.
    vi.resetModules();
    const { state } = await import("./state.js");
    expect([state.route, state.draft]).toEqual(["home", null]);
    // Nor on any entry of the page's it comes back to.
    while (history.at > 0) {
      history.back();
      await flush();
      expect(history.url).toBe("/full.html");
    }
  });
});

// Chen's, in Firefox for Android: Activity's search typed quickly kept "sa" of
// "satay": each letter drew the screen again, and a field swapped under a
// phone's keyboard loses what it's composing. Once, an amount came out "002.".
describe("a field typed in while the wallet draws its screen again", () => {
  it("is drawn again at once on another wallet or a lock, typed in or not", async () => {
    const t = await popupOn("activity", { addressBook: { loaded: true, items: [] } });
    const field = t.app.querySelector(".activity-search");
    field.focus();
    field.value = "sa";
    field.dispatchEvent(fakeEvent("input"));
    t.open = { ...t.open, isUnlocked: false };
    await t.render({ forceRefresh: true });
    await flush();
    expect(t.app.contains(field)).toBe(false);
  });
});

// Lena's: held as her account sent something else meanwhile, Activity didn't list what it sent for 1 to 3 minutes.
describe("a payment held as its account sent something else while it waited", () => {
  it("has the account's history read again as the hold comes, so Activity can list what it sent", async () => {
    // The archive, asked where the account's history stands, as each read of it begins.
    const asked = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(init?.body ?? "").includes("lastBlockPair")) asked.push(String(url));
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    // The history kept on this device.
    const { IDBFactory, IDBKeyRange } = await import("fake-indexeddb");
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] } });
    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(t.state.activity.syncing).toBeFalsy());
    await flush();
    asked.length = 0;
    t.deliver({ type: "DUSK_UI_SEND_WAITING", sendId: "s1", waits: true });
    await flush();
    expect(asked).toEqual([]);
    t.deliver({ type: "DUSK_UI_SEND_WAITING", sendId: "s1", waits: false, held: true });
    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0));
  });

  // Round 40's review: as the hold came, Sent was drawn from the overview it had, where the payment wasn't held yet:
  // Send it too and Don't send were on, saying "something else", while what the account sent was still being read.
  it("says it checks, its answers off, till an overview that holds it comes", async () => {
    const record = { sendId: "s1", to: B, lux: "10000000", feeLux: "0", memo: "", profileIndex: 0, privacy: "public", at: Date.now() - 5_000 };
    let later = null;
    const answer = async (message) => (message.type === "DUSK_UI_OVERVIEW" && later ? later.promise : undefined);
    const sending = { phase: "sending", sendId: "s1", waits: true, title: "Send", amountLux: "10000000", startedAt: Date.now() - 5_000 };
    const t = await popupOn("sent", { addressBook: { loaded: true, items: [] }, sent: sending }, answer);
    t.open = { ...t.open, waitingSends: [record] };
    await t.render({ forceRefresh: true });
    await flush();
    // What its step says: that it checks what the account sent ("Checking what your account sent…"), in the
    // wallet's own words too.
    const { CHECKING_MEANWHILE_TEXT } = await import("../lib/waiting.js");
    const checks = () => t.app.querySelectorAll(".step .step-sub").map((sub) => sub.textContent).filter((text) => /checking/i.test(text));
    const shown = () => [
      checks().length === 1,
      ...["Send it too", "Don't send"].map((text) => t.app.querySelectorAll("button").find((b) => b.textContent === text)?.disabled),
    ];
    later = Promise.withResolvers();
    t.deliver({ type: "DUSK_UI_SEND_WAITING", sendId: "s1", waits: false, held: true });
    await flush();
    expect([t.state.route, ...shown()]).toEqual(["sent", true, true, true]);
    expect(checks()).toEqual([CHECKING_MEANWHILE_TEXT]);
    // The overview that holds it, read: its answers.
    later.resolve({ ...t.open, waitingSends: [{ ...record, held: true }] });
    later = null;
    await flush();
    expect([t.state.route, ...shown()]).toEqual(["sent", false, false, false]);
  });
});
