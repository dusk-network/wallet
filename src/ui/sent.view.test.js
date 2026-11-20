import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TX_KIND } from "../shared/constants.js";
import { SEND_CANCELLED_TEXT } from "../shared/sendOutcome.js";
// The fake DOM goes before the views: it defines HTMLElement for the gas editor.
import { installFakeDom, isShown, pastClickGuard, settle, visibleText } from "./testing/fakeDom.js";
import { screenShown } from "./lib/clickGuard.js";
import { CHECKING_MEANWHILE_TEXT } from "./lib/waiting.js";
import { convertConfirmView } from "./popup/views/convert.js";
import { sendConfirmView } from "./popup/views/send.js";
import { FIREFOX_NOTICE_COMES_TEXT, KEEP_OPEN_TEXT, UNCLEAR_TEXT, noteTxStatus, reasonText, reviewOf, sentAnnouncement, sentSteps, sentView } from "./popup/views/sent.js";
import { txErrorText } from "./popup/views/txDisplay.js";
import { switchContext } from "./popup/context.js";

vi.mock("../shared/addressBook.js", () => ({ listAddressBook: vi.fn(async () => []) }));
vi.mock("../platform/runtime.js", async (importOriginal) => ({
  ...(await importOriginal()),
  isExtensionRuntime: vi.fn(() => true),
}));

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const OTHER =
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const HASH = "3e6a0ec6" + "0".repeat(48) + "7eae84ba";
const NODE = "https://testnet.nodes.dusk.network";
const dusk = (n) => (BigInt(n) * 1_000_000_000n).toString();

const overview = (over = {}) => ({
  hasVault: true,
  isUnlocked: true,
  nodeUrl: NODE,
  accounts: [ACCOUNT],
  selectedAccountIndex: 0,
  balance: { value: dusk(2000) },
  shieldedBalance: { value: "0", spendable: "0" },
  txs: [],
  ...over,
});

let dom;
let body;

beforeEach(() => {
  dom = installFakeDom();
  body = dom.document.body;
  dom.window.open = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Draws the route as app.js does, for the views here: Review, then Sent.
function popup(state, ov = overview(), reviewView = sendConfirmView) {
  const reviewRoute = state.route;
  let sendReply = null;
  const actions = {
    send: vi.fn(async (message) => {
      if (message.type === "DUSK_UI_GET_CACHED_GAS_PRICE") return { min: "1", median: "1", max: "1" };
      if (message.type === "DUSK_UI_SEND_TX") return sendReply.promise;
      return {};
    }),
    render: vi.fn(async () => draw()),
    showToast: vi.fn(),
    announce: vi.fn(),
  };
  // Other routes (home) draw nothing here. Each screen gets what it's drawn
  // for, as render() gives it (reviewOf).
  const draw = () => {
    const screen = { state, actions: { ...actions, review: reviewOf(ov, state) } };
    const nodes =
      state.route === "sent"
        ? sentView(ov, screen)
        : state.route === reviewRoute
          ? reviewView(ov, screen)
          : [];
    body.replaceChildren(...nodes);
  };
  draw();
  return {
    actions,
    draw,
    confirm: async () => {
      sendReply = Promise.withResolvers();
      confirmButton().click();
      await settle();
      return sendReply;
    },
  };
}

// Where the send stands, whatever the screen calls it: its phase (sending, sent, not_sent, unconfirmed), each step's
// state (done, current, upcoming, failed, unknown), and what a step says under its name.
const phase = () => body.querySelector(".sent")?.getAttribute("data-phase") ?? null;
const stepStates = () => body.querySelectorAll(".step").map((li) => li.className.replace("step is-", ""));
const stepSub = (i) => {
  const sub = body.querySelectorAll(".step")[i]?.querySelector(".step-sub");
  return sub ? visibleText(sub) : "";
};
// What a step says it is, as shown: its status ("Not sent", "Completed"), whatever its state's class.
const stepTitle = (i) => {
  const title = body.querySelectorAll(".step")[i]?.querySelector(".step-title");
  return title ? visibleText(title) : "";
};
const screen = () => visibleText(body);
// A figure exactly as written: not inside a longer number, not signed or bounded unless written so, and not followed by
// more digits, letters or a decimal part (1.0025 ≠ 11.0025, 0.005 ≠ −0.005, 2,000,000 ≠ 2,000,000.5, BNB ≠ BNBX).
const exactly = (text) => new RegExp(`(?<![\\d.,+\\-−<>≤≥~])(?<![+\\-−<>≤≥~]\\s)${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\dA-Za-z]|[.,]\\d)`);
// When it was sent, and from which balance: the line that gives its time.
const sentLine = () => body.querySelectorAll(".step-sub, .kv-value").map(visibleText).find((text) => /\d\d:\d\d/.test(text)) ?? "";
// A row's value, by its label: the fee's, whatever its row is called, and the memo's.
const valueOf = (label) => {
  const row = body.querySelectorAll(".kv").find((kv) => label.test(visibleText(kv.querySelector(".kv-label"))));
  return row ? visibleText(row.querySelector(".kv-value")) : null;
};
const fee = () => valueOf(/fee/i);
const memo = () => valueOf(/memo/i);
// The transaction ID, whole in its title.
const txId = () => body.querySelector(`[title="${HASH}"]`);
const button = (text) => body.querySelectorAll("button").find((b) => isShown(b) && visibleText(b) === text);
// A Review's own button, whatever it says; what calls off a payment that waits; and what opens the explorer.
const confirmButton = () => body.querySelector(".review-actions .btnrow > button");
const cancelButton = () => body.querySelector(".sent-cancel");
const explorerButton = () => body.querySelectorAll("button").find((b) => isShown(b) && /explorer/i.test(visibleText(b)));
const note = () => body.querySelector(".sent-note")?.textContent ?? null;

const reviewState = () => ({
  route: "confirm",
  addressBook: { loaded: true, items: [] },
  draft: { to: OTHER, privacy: "public", amountDusk: "1500", amountLux: dusk(1500), memo: "Lunch" },
});

describe("a stake or an unstake with Sozu, completed", () => {
  // Lena's: Completed said its block, its ID and its fee, and nothing of the stDUSK.
  const fact = (kind, stDusk) => ({ kind, amount: dusk(100), fee: 0n, stDusk, pool: { stake: 2_000_000_000_000n, supply: 1_000_000_000_000n } });
  const completed = (kind, sozuFact, ov = overview()) => {
    const sent = { id: 1, title: kind === "stake" ? "Stake with Sozu" : "Unstake from Sozu", amountLux: dusk(100), sozu: kind, phase: "sent", status: "executed", hash: HASH, blockHeight: "4796264", feePaid: "2136028", startedAt: Date.now(), sentAt: Date.now(), nodeUrl: NODE };
    body.replaceChildren(...sentView(ov, { state: { route: "sent", sent }, actions: { render: vi.fn(async () => {}) }, sozu: sozuFact }));
  };

  it("says what it got or gave back in stDUSK, to the lux, and what one stDUSK was worth", () => {
    // Each in its own row: what a stake got, or an unstake gave back, never the other; and the rate.
    completed("stake", fact("stake", 49_875_000_000n));
    expect([valueOf(/got/i), valueOf(/gave/i), valueOf(/rate/i)]).toEqual(["49.875 stDUSK", null, "1 stDUSK = 2 DUSK"]);
    completed("unstake", fact("unstake", 63_297_959n));
    expect([valueOf(/gave/i), valueOf(/got/i), valueOf(/rate/i)]).toEqual(["0.063297959 stDUSK", null, "1 stDUSK = 2 DUSK"]);
    // Hidden with the balances; the rate isn't one.
    completed("stake", fact("stake", 49_875_000_000n), overview({ hideBalances: true }));
    expect(valueOf(/got/i)).toMatch(/^•••• stDUSK$/);
    expect(screen()).not.toContain("49.875");
    expect(valueOf(/rate/i)).toBe("1 stDUSK = 2 DUSK");
  });
});

describe("after Confirm", () => {
  it("shows Sending at once, then Confirming with the transaction ID, Copy and the Dusk explorer", async () => {
    const state = reviewState();
    const app = popup(state);
    await settle();
    const reply = await app.confirm();

    // Straight to the Sent screen, with what goes and to whom, each as written.
    expect(state.route).toBe("sent");
    const to = body.querySelector(".sent-line .mono");
    expect([visibleText(body.querySelector(".sent-amount")), visibleText(to), to.title]).toEqual(["1,500 DUSK", "21n5nc…fMMLNz", OTHER]);
    expect([phase(), stepStates(), stepTitle(0)]).toEqual(["sending", ["current", "upcoming", "upcoming"], "Sending"]);

    reply.resolve({ ok: true, result: { hash: HASH } });
    await settle();
    expect([phase(), stepStates(), stepTitle(1)]).toEqual(["sent", ["done", "current", "upcoming"], "Confirming"]);
    // Its ID, its memo and the most its fee costs.
    expect(visibleText(txId())).toBe("3e6a0e…ae84ba");
    expect(memo()).toBe("Lunch");
    expect(fee()).toMatch(exactly("0.0025 DUSK"));
    // The review's draft is done with.
    expect(state.draft).toBeNull();

    // Copy gives the whole ID.
    txId().closest(".kv").querySelector("button").click();
    await settle();
    expect(dom.clipboard.writeText).toHaveBeenCalledWith(HASH);

    // Dusk's explorer, never DuskScan.
    explorerButton().click();
    await settle();
    expect(dom.window.open).toHaveBeenCalledWith(
      `https://explorer.testnet.dusk.network/transactions/transaction/?id=${HASH}`,
      "_blank",
      "noopener,noreferrer"
    );
  });

  it("follows the watcher to Completed, with the fee paid, and Done goes home", async () => {
    const state = reviewState();
    const app = popup(state);
    await settle();
    (await app.confirm()).resolve({ ok: true, result: { hash: HASH } });
    await settle();

    // Another transaction's news isn't this screen's.
    expect(noteTxStatus(state.sent, { hash: "ff".repeat(32), status: "failed" })).toBe(false);
    expect(noteTxStatus(state.sent, { hash: HASH, status: "executed", feePaid: "312345", blockHeight: "1234567" })).toBe(true);
    app.draw();
    expect([stepStates(), stepTitle(2)]).toEqual([["done", "done", "done"], "Completed"]);
    // The balance it went from, and its fee to the last lux, as its transaction's details say it.
    expect(sentLine()).toMatch(/public/i);
    expect(sentLine()).not.toMatch(/shielded/i);
    expect(fee()).toMatch(exactly("0.000312345 DUSK"));
    // Finished: no note about closing the wallet.
    expect(note()).toBeNull();

    button("Done").click();
    await settle();
    expect([state.route, state.sent]).toEqual(["home", null]);
  });

  it("says why it failed and what fee was charged", async () => {
    const state = reviewState();
    const app = popup(state);
    await settle();
    (await app.confirm()).resolve({ ok: true, result: { hash: HASH } });
    await settle();

    noteTxStatus(state.sent, { hash: HASH, status: "failed", error: "Out of gas", feePaid: "2500000" });
    app.draw();
    expect([stepStates(), stepTitle(2)]).toEqual([["done", "done", "failed"], "Failed"]);
    // Why: it ran out of gas.
    expect(stepSub(2)).toMatch(/out of gas/i);
    expect(stepSub(2)).toContain(txErrorText("Out of gas"));
    expect(fee()).toMatch(exactly("0.0025 DUSK"));

    // Dropped before it ran: nothing was charged, and the watcher's code isn't a reason.
    noteTxStatus(state.sent, { hash: HASH, status: "removed", error: "reconciliation_unavailable" });
    app.draw();
    expect([stepStates()[2], stepTitle(2)]).toEqual(["failed", "Failed"]);
    expect(screen()).not.toMatch(/0\.0025|reconciliation_unavailable/);
  });

  it.each([
    ["Failed to deserialize the buffer", /couldn't read the address/i],
    ["Unknown error code: 251", /couldn't build/i],
  ])("says plainly that nothing went out when the wallet can't build it: %s", async (message, why) => {
    const state = reviewState();
    const app = popup(state);
    await settle();
    (await app.confirm()).resolve({ error: { message } });
    await settle();
    expect([phase(), stepStates()[0], stepTitle(0)]).toEqual(["not_sent", "failed", "Not sent"]);
    // In words, not the engine's.
    expect(stepSub(0)).toMatch(why);
    expect(stepSub(0)).toContain(reasonText(message));
    expect(screen()).not.toContain(message);
  });

  it("doesn't claim nothing went out when the reply was lost, and keeps the review to go back to", async () => {
    const state = reviewState();
    const app = popup(state);
    await settle();
    (await app.confirm()).resolve({ error: { message: "The message port closed before a response was received." } });
    await settle();
    // Not confirmed: it may have gone out, so Activity is to be checked before it's sent again.
    expect([phase(), stepStates()[0], stepTitle(0)]).toEqual(["unconfirmed", "unknown", "Not confirmed"]);
    expect(stepSub(0)).toMatch(/check Activity/i);
    expect(fee()).toMatch(exactly("0.0025 DUSK"));
    // The draft stays for Back, and nothing says no fee was charged.
    expect(screen()).not.toMatch(/no fee/i);
    expect(state.draft).toMatchObject({ to: OTHER });
    // Done leads, not Back to review: nothing nudges a second payment of one that may have gone.
    expect(body.querySelector(".sent-actions .btn-primary")).toBe(button("Done"));
  });

  it("says a send that couldn't reach the network wasn't sent, in words, not the socket's, as Chen's offline Confirm showed it", async () => {
    const state = reviewState();
    const app = popup(state);
    await settle();
    const socket = "WebSocket connection failed to wss://testnet.nodes.dusk.network/on (readyState=3)";
    (await app.confirm()).resolve({ error: { message: socket } });
    await settle();
    expect([phase(), stepStates()[0], stepTitle(0)]).toEqual(["not_sent", "failed", "Not sent"]);
    expect(stepSub(0)).toMatch(/couldn't reach the network/i);
    expect(stepSub(0)).toContain(reasonText(socket));
    // No fee charged, and none of the socket's words.
    expect(screen()).not.toMatch(/0\.0025|WebSocket|readyState|wss:/);
    // The engine's word that nothing went out, whatever its error says.
    const again = reviewState();
    const second = popup(again);
    await settle();
    (await second.confirm()).resolve({ error: { message: "Engine call timed out", data: { sent: false } } });
    await settle();
    expect([phase(), stepStates()[0], stepTitle(0)]).toEqual(["not_sent", "failed", "Not sent"]);
  });

  it("keeps a send handed over without a clear answer by its ID, and says Completed with its fee once the node has it", async () => {
    const state = reviewState();
    const ov = overview();
    const app = popup(state, ov);
    await settle();
    (await app.confirm()).resolve({ error: { message: "Failed to fetch", data: { sent: "unknown", hash: HASH } } });
    await settle();
    expect([phase(), stepStates()[0], stepTitle(0)]).toEqual(["unconfirmed", "unknown", "Not confirmed"]);
    expect(stepSub(0)).toMatch(/check Activity/i);
    expect(visibleText(txId())).toBe("3e6a0e…ae84ba");
    // Looked up once the signal is back: in a block, with its fee.
    expect(noteTxStatus(state.sent, { hash: HASH, status: "executed" })).toBe(true);
    ov.txs = [{ hash: HASH, status: "executed", feePaid: "2136028", blockHeight: "4817567" }];
    app.draw();
    expect([phase(), stepStates(), stepTitle(2)]).toEqual(["sent", ["done", "done", "done"], "Completed"]);
    expect(sentLine()).toMatch(/public/i);
    expect(sentLine()).not.toMatch(/shielded/i);
    expect(fee()).toMatch(exactly("0.002136028 DUSK"));
  });

  // Amélie's: offline while Sending, nothing said a word of the connection; and later, the Wi-Fi off at Confirm said
  // "until you're back online", then "Not sent" a second on, and never waited as the web wallet does.
  it("says a payment from Send waits for the network while it's offline, nothing gone out yet, with Don't send", async () => {
    const state = reviewState();
    const app = popup(state);
    await settle();
    const sending = await app.confirm();
    expect([phase(), stepStates()[0], cancelButton()]).toEqual(["sending", "current", null]);
    vi.stubGlobal("navigator", { ...globalThis.navigator, onLine: false });
    app.draw();
    // Waiting, as it's offline: nothing sent yet, never that it may have gone out, and Don't send calls it off.
    expect([phase(), stepStates()[0]]).toEqual(["sending", "current"]);
    expect(stepSub(0)).toMatch(/offline/i);
    expect(stepSub(0)).toMatch(/nothing sent yet/i);
    expect(stepSub(0)).not.toMatch(/may have gone out/i);
    expect(stepSub(0)).not.toContain(UNCLEAR_TEXT);
    expect(cancelButton()).toBeTruthy();
    // Where the wallet couldn't wait for it, it says it wasn't sent.
    sending.resolve({ error: { message: "NetworkError when attempting to fetch resource." } });
    await settle();
    expect([phase(), stepStates()[0], stepTitle(0)]).toEqual(["not_sent", "failed", "Not sent"]);
  });

  // Chen's: the Wi-Fi went just as a payment was handed over; the screen said "Nothing has left your wallet yet" of a
  // payment that had reached the node, and offered Cancel.
  it("says a payment handed over may have gone out already, offline or waiting, never that nothing left, without Don't send", async () => {
    const state = reviewState();
    const app = popup(state);
    await settle();
    await app.confirm();
    // The wallet says it's being handed over (DUSK_UI_SEND_WAITING, handedOver).
    state.sent.handedOver = true;
    vi.stubGlobal("navigator", { ...globalThis.navigator, onLine: false });
    // It may have gone out already: never that nothing has left the wallet.
    const mayHaveGone = () => {
      expect([stepStates()[0], cancelButton()]).toEqual(["current", null]);
      expect(stepSub(0)).toMatch(/may have gone out/i);
      expect(stepSub(0)).not.toMatch(/nothing sent yet|nothing (has )?left/i);
      expect(stepSub(0)).toContain(UNCLEAR_TEXT);
    };
    app.draw();
    mayHaveGone();
    // Online, its answer lost: looked up, and sent once if it didn't go.
    vi.stubGlobal("navigator", { ...globalThis.navigator, onLine: true });
    state.sent.waits = true;
    app.draw();
    mayHaveGone();
  });

  it("says a payment that waits for the network does, and Don't send calls it off: not sent, no fee", async () => {
    const state = reviewState();
    const app = popup(state);
    await settle();
    const sending = await app.confirm();
    // Sent with its own ID, by which it's called off, and the most its fee costs.
    const [asked] = app.actions.send.mock.calls.find(([m]) => m.type === "DUSK_UI_SEND_TX");
    expect(asked).toMatchObject({ sendId: state.sent.sendId, feeCapLux: "2500000" });
    expect(state.sent.sendId).toMatch(/^[\w-]{8,64}$/);

    // The wallet says it waits: online, the node silent. Nothing gone out, so Don't send.
    state.sent.waits = true;
    app.draw();
    expect([phase(), stepStates()[0]]).toEqual(["sending", "current"]);
    expect(stepSub(0)).toMatch(/nothing sent yet/i);
    expect(stepSub(0)).not.toMatch(/may have gone out/i);
    expect(stepSub(0)).not.toContain(UNCLEAR_TEXT);
    expect(cancelButton()).toBeTruthy();

    app.actions.send.mockImplementation(async (message) => (message.type === "DUSK_UI_CANCEL_SEND" ? { ok: true, result: { cancelled: true } } : {}));
    cancelButton().click();
    await settle();
    expect(app.actions.send).toHaveBeenCalledWith({ type: "DUSK_UI_CANCEL_SEND", sendId: state.sent.sendId });
    sending.resolve({ error: { message: SEND_CANCELLED_TEXT, data: { sent: false, cancelled: true } } });
    await settle();
    // Chosen, so in no colour (Chen's: a red Send failed): not sent, nothing left the wallet, and no fee.
    expect([phase(), stepStates()[0], stepTitle(0)]).toEqual(["not_sent", "upcoming", "Not sent"]);
    expect(stepSub(0)).toMatch(/nothing left your wallet/i);
    expect(screen()).not.toMatch(/0\.0025/);
  });

  it("says a payment that went out already can't be cancelled, and follows it as it goes", async () => {
    const state = reviewState();
    const app = popup(state);
    await settle();
    const sending = await app.confirm();
    state.sent.waits = true;
    app.draw();
    app.actions.send.mockImplementation(async (message) => (message.type === "DUSK_UI_CANCEL_SEND" ? { ok: true, result: { cancelled: false } } : {}));
    cancelButton().click();
    await settle();
    // Said: it went out already; and nothing called off.
    expect(app.actions.showToast).toHaveBeenCalledTimes(1);
    expect(app.actions.showToast).toHaveBeenCalledWith(expect.stringMatching(/went out already/i));
    expect(phase()).toBe("sending");
    sending.resolve({ ok: true, result: { hash: HASH } });
    await settle();
    expect([phase(), stepStates(), stepTitle(1), cancelButton()]).toEqual(["sent", ["done", "current", "upcoming"], "Confirming", null]);
  });

  // Chen's: the Wi-Fi dropped as she paid on her first phone, she paid the same from her second, and the first sent
  // its copy too once it had the network back, without asking. Then Chen's again, in the app: Send it too paid at
  // once, Done was the biggest button, and Don't send said a red Send failed; and Marek's, Lena's: it never said what.
  it("sends its account's nonce as Review read it, and holds a payment whose account sent something else meanwhile, with Send it too and Don't send", async () => {
    const state = reviewState();
    const ov = overview({ balance: { value: dusk(2000), nonce: "41" } });
    const app = popup(state, ov);
    await settle();
    const sending = await app.confirm();
    const [asked] = app.actions.send.mock.calls.find(([m]) => m.type === "DUSK_UI_SEND_TX");
    expect(asked).toMatchObject({ seenNonce: "41" });

    // The wallet says it's held (DUSK_UI_SEND_WAITING, held): not sent, said so, and nothing of closing the wallet.
    Object.assign(state.sent, { waits: false, held: true });
    app.draw();
    expect([phase(), stepStates()[0], stepTitle(0)]).toEqual(["sending", "unknown", "Held"]);
    expect(stepSub(0)).toMatch(/your account sent something else/i);
    expect(note()).toBeNull();

    // While what its account sent is read: it says so, Send it too and Don't send off till it's known.
    const held = { sendId: state.sent.sendId, to: OTHER, lux: dusk(1500), memo: "Lunch", profileIndex: 0, privacy: "public", waiting: true, held: true };
    ov.waitingSends = [{ ...held, checking: Date.now() }];
    app.draw();
    expect(stepSub(0)).toMatch(/checking what your account sent/i);
    expect(stepSub(0)).toBe(CHECKING_MEANWHILE_TEXT);
    expect([button("Send it too").disabled, button("Don't send").disabled, button("Done").disabled]).toEqual([true, true, false]);

    // What its account sent meanwhile, as the node named it: what, to whom, when and with which memo, and that it
    // looks like this same payment.
    ov.waitingSends = [{ ...held, meanwhile: [{ hash: "ef".repeat(32), to: OTHER, lux: dusk(1500), memo: "Lunch", at: Date.now() }] }];
    app.draw();
    for (const value of [/(?<![\d.,+\-−<>≤≥~])1,?500 DUSK(?![\dA-Za-z]|[.,]\d)/, /21n5nc…fMMLNz/, /\d\d:\d\d/, /“Lunch”/, /same payment/]) expect(stepSub(0)).toMatch(value);
    expect([button("Send it too").disabled, button("Don't send").disabled]).toEqual([false, false]);
    // That being the same payment, Don't send leads, not Send it too.
    expect(body.querySelector(".sent-actions .btn-primary")).toBe(button("Don't send"));

    // Send it too: its Review, in its place; nothing goes before Confirm there.
    const sent = state.sent;
    button("Send it too").click();
    await settle();
    expect([state.route, state.sent]).toEqual(["confirm", null]);
    expect(state.draft).toMatchObject({ to: OTHER, amountLux: dusk(1500), memo: "Lunch", replaces: sent.sendId });
    expect(app.actions.send.mock.calls.map(([m]) => m.type)).not.toContain("DUSK_UI_SEND_HELD");

    // Held again, and Don't send: called off, not sent, in no colour.
    Object.assign(state, { route: "sent", sent });
    app.draw();
    app.actions.send.mockImplementation(async (message) => (message.type === "DUSK_UI_CANCEL_SEND" ? { ok: true, result: { cancelled: true } } : {}));
    button("Don't send").click();
    await settle();
    expect(app.actions.send).toHaveBeenCalledWith({ type: "DUSK_UI_CANCEL_SEND", sendId: state.sent.sendId });
    sending.resolve({ error: { message: SEND_CANCELLED_TEXT, data: { sent: false, cancelled: true } } });
    await settle();
    expect([phase(), stepStates()[0], stepTitle(0)]).toEqual(["not_sent", "upcoming", "Not sent"]);
  });

  it("says a send other than a payment from Send can't reach the network offline, never that it waits", async () => {
    const state = { route: "convert_confirm", draft: { kind: TX_KIND.SHIELD, amountDusk: "2", amountLux: dusk(2) } };
    const app = popup(state, overview(), convertConfirmView);
    await settle();
    await app.confirm();
    vi.stubGlobal("navigator", { ...globalThis.navigator, onLine: false });
    app.draw();
    // Tried once: no ID to wait by, nothing to call off, and no word of going out later.
    expect([state.sent.sendId, stepStates()[0], cancelButton()]).toEqual(["", "current", null]);
    expect(stepSub(0)).toMatch(/offline[\s\S]*can't reach the network/i);
    expect(stepSub(0)).not.toMatch(/goes out/i);
  });

  // Amélie's: after paying a link, pulling the page down brought the same payment back, ready to send.
  it("takes the link the page was opened with off its address once it's paid, and leaves it on one not sent", async () => {
    const replaceState = vi.fn();
    vi.stubGlobal("history", { state: null, replaceState });
    vi.stubGlobal("location", { pathname: "/full.html", search: "?route=send&link=https%3A%2F%2Fapps.testnet.dusk.network%2Fwallet%2Fdashboard%2Fsend%3Fto%3Dabc&origin=x" });
    const refused = popup(reviewState());
    await settle();
    (await refused.confirm()).resolve({ error: { message: "Insufficient balance" } });
    await settle();
    expect(replaceState).not.toHaveBeenCalled();

    const app = popup(reviewState());
    await settle();
    (await app.confirm()).resolve({ ok: true, result: { hash: HASH } });
    await settle();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/full.html?origin=x");
  });

  it("keeps a send the network didn't take on the Sent screen, with Back to the review as it was", async () => {
    const state = reviewState();
    const app = popup(state);
    await settle();
    (await app.confirm()).resolve({ error: { message: "Insufficient balance" } });
    await settle();

    expect([phase(), stepStates(), stepTitle(0)]).toEqual(["not_sent", ["failed", "upcoming", "upcoming"], "Not sent"]);
    expect(stepSub(0)).toContain("Insufficient balance");
    // Its memo; no fee, no note that it goes on, nothing to look up.
    expect(memo()).toBe("Lunch");
    expect(screen()).not.toMatch(/0\.0025/);
    expect([note(), explorerButton()]).toEqual([null, undefined]);

    button("Back to review").click();
    await settle();
    expect(state.route).toBe("confirm");
    expect(state.draft).toMatchObject({ to: OTHER, amountLux: dusk(1500), memo: "Lunch" });
    expect(confirmButton()).toBeTruthy();
  });

  it("never shows a node's reply as raw JSON, cut off or whole", async () => {
    const state = reviewState();
    const app = popup(state);
    await settle();
    const reply = JSON.stringify({ error: "Invalid input: Tx 7abc0686 not accepted: this transaction is invalid Value spent larger than account holds" });
    (await app.confirm()).resolve({ error: { message: reply } });
    await settle();
    expect([phase(), stepStates()[0], stepTitle(0)]).toEqual(["not_sent", "failed", "Not sent"]);
    // The node's refusal in words: the balance doesn't cover it.
    expect(stepSub(0)).toMatch(/doesn't cover/i);
    expect(stepSub(0)).toContain(reasonText(reply));
    expect(screen()).not.toContain("{");
    expect(screen()).not.toContain("Invalid input");
  });

  it("says whole why a node it won't sign for got nothing", async () => {
    const state = reviewState();
    const app = popup(state);
    await settle();
    const refusal = "hostile-node.example now says it's on Mainnet (chain 1), not Testnet (chain 2). Nothing was signed, because a signature here could count on the other network.";
    (await app.confirm()).resolve({ error: { message: refusal } });
    await settle();
    expect([phase(), stepStates()[0], stepTitle(0)]).toEqual(["not_sent", "failed", "Not sent"]);
    expect(stepSub(0)).toContain(refusal);
  });

  it.each(["Wallet changed while awaiting approval", "Wallet or network changed while transaction was queued"])(
    "says nothing went out when the wallet refused it for another network, profile or wallet than its review's: %s",
    async (error) => {
      const app = popup(reviewState());
      await settle();
      (await app.confirm()).resolve({ error: { message: error } });
      await settle();
      expect([phase(), stepStates()[0], stepTitle(0)]).toEqual(["not_sent", "failed", "Not sent"]);
      expect(stepSub(0)).toContain(error);
    }
  );

  it("sends from the wallet the review was on, and says nothing went out when another is unlocked now", async () => {
    const ov = overview();
    const state = { ...reviewState(), overview: ov };
    const app = popup(state, ov);
    await settle();
    const reply = await app.confirm();
    expect(app.actions.send).toHaveBeenCalledWith(expect.objectContaining({ type: "DUSK_UI_SEND_TX", walletId: ACCOUNT }));
    reply.resolve({ error: { message: "The wallet changed while you reviewed it." } });
    await settle();
    expect([phase(), stepStates()[0], stepTitle(0)]).toEqual(["not_sent", "failed", "Not sent"]);
    expect(stepSub(0)).toContain("The wallet changed while you reviewed it.");
  });

  describe("when another window switches wallet as the Sent screen is drawn", () => {
    // The popup draws the Sent screen; meanwhile the overview comes to name
    // the other wallet, with the switch's new context (`switching`) or ahead of it.
    async function confirmWhile(switching) {
      const ov = overview();
      const state = { ...reviewState(), overview: ov };
      const app = popup(state, ov);
      await settle();
      const draw = app.actions.render.getMockImplementation();
      app.actions.render.mockImplementation(async () => {
        if (state.route === "sent" && state.overview === ov) {
          if (switching) switchContext(state);
          state.overview = overview({ accounts: [OTHER] });
        }
        return draw();
      });
      await app.confirm();
      return app.actions.send.mock.calls.map(([m]) => m).filter((m) => m.type === "DUSK_UI_SEND_TX");
    }

    it("sends nothing once the switch has begun, and says so", async () => {
      await expect(confirmWhile(true)).resolves.toEqual([]);
      expect([phase(), stepStates()[0], stepTitle(0)]).toEqual(["not_sent", "failed", "Not sent"]);
    });

    it("sends only from the wallet reviewed, which the wallet refuses once another is open", async () => {
      // The engine signs it only for the wallet, profile, account and network of the Review.
      await expect(confirmWhile(false)).resolves.toEqual([
        expect.objectContaining({
          walletId: ACCOUNT,
          params: expect.objectContaining({ _approvalContext: { walletId: ACCOUNT, profileIndex: 0, account: ACCOUNT, nodeUrl: NODE } }),
        }),
      ]);
    });
  });

  it("leaves a newer review's draft alone when an earlier send finishes", async () => {
    const state = reviewState();
    const app = popup(state);
    await settle();
    const reply = await app.confirm();
    // Done while Sending, then a new send drafted.
    button("Done").click();
    await settle();
    const newer = { to: OTHER, privacy: "public", amountDusk: "2", amountLux: dusk(2), memo: "" };
    state.draft = newer;
    reply.resolve({ ok: true, result: { hash: HASH } });
    await settle();
    expect(state.draft).toBe(newer);
    // Activity marks the transaction that went out.
    expect(state.highlightTx).toBe(HASH);
  });

  it("still says a refusal that comes after Done", async () => {
    const state = reviewState();
    const app = popup(state);
    await settle();
    const reply = await app.confirm();
    button("Done").click();
    await settle();
    expect(state.route).toBe("home");
    reply.resolve({ error: { message: "Insufficient balance" } });
    await settle();
    expect(app.actions.showToast).toHaveBeenCalledWith({ text: expect.stringMatching(/failed[\s\S]*Insufficient balance/i), tone: "bad" });
    // The review is still there to go back to.
    expect(state.draft).toMatchObject({ to: OTHER, amountLux: dusk(1500) });
  });

  it("leaves the fee out of a failed step's words with Hide balances, shown and announced", () => {
    const sent = { phase: "sent", hash: HASH, status: "failed", feeCapLux: "2500000" };
    const txs = [{ hash: HASH, status: "failed", feePaid: "2000000" }];
    // What's said of the failed send: its step's words and what's announced of it, and its fee row, drawn.
    const said = (ov) => {
      body.replaceChildren(...sentView(ov, { state: { sent }, actions: {} }));
      return [sentSteps(sent, ov).at(-1).sub, sentAnnouncement(sent, ov), fee()];
    };
    // Shown: the fee it was charged in its row, or at most the cap while that isn't known.
    expect(said(overview({ txs }))[2]).toMatch(exactly("0.002 DUSK"));
    expect(said(overview())[2]).toMatch(exactly("0.0025 DUSK"));
    // Hidden: no figure in its words or what's announced, and its row's figure masked, charged or capped.
    for (const ov of [overview({ txs, hideBalances: true }), overview({ hideBalances: true })]) {
      const [words, announced, row] = said(ov);
      expect([words, announced]).toEqual([expect.not.stringMatching(/\d/), expect.not.stringMatching(/\d/)]);
      expect(row).toMatch(/^[^\d]*••••[^\d]*$/);
    }
  });

  it("is where Shield's Confirm goes too, and gas that won't do stays on Review", async () => {
    const state = { route: "convert_confirm", draft: { kind: TX_KIND.SHIELD, amountDusk: "2", amountLux: dusk(2) } };
    const app = popup(state, overview(), convertConfirmView);
    await settle();
    // Half the gas set: said above Confirm, nothing sent.
    const editor = body.querySelector("dusk-gas-editor");
    editor.setGas({ limit: "30000000", price: "" });
    confirmButton().click();
    await settle();
    expect(state.route).toBe("convert_confirm");
    expect(body.querySelector(".review-actions > .field-error").textContent).toMatch(/gas limit[\s\S]*gas price/i);
    expect(app.actions.send.mock.calls.filter(([m]) => m.type === "DUSK_UI_SEND_TX")).toEqual([]);

    editor.setGas({ limit: "30000000", price: "1" });
    (await app.confirm()).resolve({ ok: true, result: { hash: HASH } });
    await settle();
    expect(state.route).toBe("sent");
    // 2 DUSK, from the public balance to the shielded one, never the other way; and the most its fee costs.
    const way = visibleText(body.querySelector(".sent-line"));
    expect(visibleText(body.querySelector(".sent-amount"))).toBe("2 DUSK");
    expect(way).toMatch(/public[\s\S]*shielded/i);
    expect(way).not.toMatch(/shielded[\s\S]*public/i);
    expect(fee()).toMatch(exactly("0.03 DUSK"));
  });
});

describe("a Review's Confirm, the moment the Review is up", () => {
  it.each([
    ["Send", "confirm", sendConfirmView, reviewState().draft],
    ["Shield", "convert_confirm", convertConfirmView, { kind: TX_KIND.SHIELD, amountDusk: "2", amountLux: dusk(2) }],
    ["Unshield", "convert_confirm", convertConfirmView, { kind: TX_KIND.UNSHIELD, amountDusk: "2", amountLux: dusk(2) }],
  ])("ignores a click, as a double-click on Review lands there, and sends one a moment later (%s)", async (_, route, view, draft) => {
    const state = { route, addressBook: { loaded: true, items: [] }, draft };
    const ov = overview({ shieldedBalance: { value: dusk(10), spendable: dusk(10) } });
    const app = popup(state, ov, view);
    // Up, as app.js marks a new screen.
    screenShown();
    await settle();
    const sends = () => app.actions.send.mock.calls.filter(([m]) => m.type === "DUSK_UI_SEND_TX");

    await app.confirm();
    expect([sends(), state.route]).toEqual([[], route]);
    // It looked as it always does meanwhile: not turned off.
    expect(confirmButton().disabled).toBe(false);

    pastClickGuard();
    await app.confirm();
    expect(sends()).toHaveLength(1);
    expect(state.route).toBe("sent");
  });
});

describe("the steps", () => {
  it("come with the watcher's news through app.js, which keeps toasts for other screens", async () => {
    const app = await readFile(path.resolve(process.cwd(), "src", "ui", "popup", "app.js"), "utf8");
    expect(app).toContain("const forSent = noteTxStatus(state.sent, { ...msg, hash, status });");
    expect(app).toMatch(/if \(forSent && state\.route === "sent"\) \{\s*toaster\.announce\(/);
    expect(app).toContain('if (state.route === "sent") {');
  });
});

// Hein's: arrival notices on a phone, asked for by the person, never by the wallet.
describe("Tell me when it arrives, on a phone", () => {
  const ANDROID = "Mozilla/5.0 (Android 15; Mobile; rv:159.0) Gecko/159.0 Firefox/159.0";
  // Sent in Firefox on a phone, its send on its way, the wallet answering where notices stand as `states` say, in
  // turn: what was asked of the wallet, and with what; what Sent says; whether it says notices are off; and the
  // button that asks for them, whatever it says.
  const draw = async (states) => {
    vi.stubGlobal("navigator", { ...globalThis.navigator, userAgent: ANDROID });
    const state = { sent: { phase: "sent", hash: HASH, status: "submitted", feeCapLux: "2500000", title: "Send", amountLux: "1000000", sentAt: Date.now() } };
    const asked = [];
    const messages = [];
    const actions = {
      send: vi.fn(async (m) => {
        asked.push(m.type);
        messages.push(m);
        if (m.type === "DUSK_UI_NOTICES") return { ok: true, state: states.shift() ?? null };
        if (m.type === "DUSK_UI_NOTICES_ASK") return { ok: true, state: states.shift() ?? "asked" };
        return { ok: true };
      }),
      render: vi.fn(async () => {}),
      showToast: vi.fn(),
    };
    const show = async () => {
      body.replaceChildren(...sentView(overview(), { state, actions }));
      await settle();
    };
    await show();
    const said = () => body.querySelectorAll(".sent-note").map(visibleText);
    const off = () => body.querySelector(".sent-notices__off") !== null;
    const ask = () => body.querySelector(".sent-notices__ask");
    return { asked, messages, show, said, off, ask };
  };

  // Chen's, Sofía's and Marek's: promised, and nothing came once they left Firefox or the app.
  it("offers it, asks the phone nothing until it's tapped, and says the notice comes while the wallet stays open", async () => {
    const shown = await draw([null]);
    // Offered: nothing asked of the phone, and no notice promised yet, only that it goes on while its Keep open tab
    // stays open.
    expect([shown.asked, shown.said(), Boolean(shown.ask())]).toEqual([["DUSK_UI_NOTICES"], [expect.stringMatching(/keep open tab/i)], true]);
    expect(shown.said().join(" ")).not.toMatch(/notice comes/i);
    expect(shown.said()).toEqual([KEEP_OPEN_TEXT]);
    shown.ask().click();
    await settle();
    expect(shown.asked).toEqual(["DUSK_UI_NOTICES", "DUSK_UI_NOTICES_ASK"]);
    // For the send on screen, which the app's Android looks for once the wallet's left.
    expect(shown.messages.at(-1)).toMatchObject({ type: "DUSK_UI_NOTICES_ASK", hash: HASH });
    // Its notice comes while the wallet stays open; nothing more to tap.
    expect([shown.said(), shown.ask()]).toEqual([[expect.stringMatching(/notice comes only while the wallet stays open/i)], null]);
    expect(shown.said()).toEqual([FIREFOX_NOTICE_COMES_TEXT]);
  });

  // After a no in Firefox, the phone's settings didn't bring them back: Firefox's own question does, when tapped.
  it("says once in Firefox that notices are off after a no, with Ask again, and asks only when it's tapped", async () => {
    const shown = await draw([null, "off", "asked"]);
    // Off, as it says in words, never on; with the button that asks again, and no notice promised.
    const saysOff = () => {
      expect([shown.off(), Boolean(shown.ask())]).toEqual([true, true]);
      expect(shown.said()).toContainEqual(expect.stringMatching(/notices are off/i));
      expect(shown.said().join(" ")).not.toMatch(/notices are on|notice comes/i);
    };
    shown.ask().click();
    await settle();
    // Off, said so; and the wallet told it was said.
    saysOff();
    expect(shown.asked).toContain("DUSK_UI_NOTICES_SAID");
    // Drawn again, the same send's Sent still says it, and has asked nothing more.
    await shown.show();
    saysOff();
    expect(shown.asked.filter((type) => type === "DUSK_UI_NOTICES_ASK")).toHaveLength(1);
    // Asked again on its tap alone, for this send: then the notice comes, and nothing says they're off.
    shown.ask().click();
    await settle();
    expect(shown.messages.at(-1)).toMatchObject({ type: "DUSK_UI_NOTICES_ASK", again: true, hash: HASH });
    expect([shown.off(), shown.said()]).toEqual([false, [expect.stringMatching(/notice comes/i)]]);
    expect(shown.said().join(" ")).not.toMatch(/notices are off/i);
    expect(shown.said()).toEqual([FIREFOX_NOTICE_COMES_TEXT]);
    // A new window's, where the wallet says it was said: the tap, and nothing asked by itself.
    const later = await draw(["off-said"]);
    expect([later.off(), Boolean(later.ask()), later.asked]).toEqual([false, true, ["DUSK_UI_NOTICES"]]);
    later.ask().click();
    await settle();
    expect(later.messages.at(-1)).toMatchObject({ type: "DUSK_UI_NOTICES_ASK", again: true, hash: HASH });
  });
});
