import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TX_KIND } from "../shared/constants.js";
// The fake DOM goes before the views: it defines HTMLElement for the gas editor.
import { installFakeDom, isShown, pastClickGuard, screenReaderText, settle, visibleText } from "./testing/fakeDom.js";
import { screenShown } from "./lib/clickGuard.js";
import { isExtensionRuntime } from "../platform/runtime.js";
import { convertConfirmView } from "./popup/views/convert.js";
import { sendConfirmView } from "./popup/views/send.js";
import { noteTxStatus, reviewOf, sentAnnouncement, sentSteps, sentView } from "./popup/views/sent.js";
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
      body.querySelectorAll("button").find((b) => b.textContent === "Confirm").click();
      await settle();
      return sendReply;
    },
  };
}

const steps = () =>
  body.querySelectorAll(".step").map((li) => [
    li.className.replace("step is-", ""),
    visibleText(li.querySelector(".step-title")),
    visibleText(li.querySelector(".step-sub") ?? li).replace(visibleText(li.querySelector(".step-title")), ""),
  ]);
const rows = () => body.querySelectorAll(".kv").map((row) => visibleText(row));
const button = (text) => body.querySelectorAll("button").find((b) => isShown(b) && visibleText(b) === text);
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
    completed("stake", fact("stake", 49_875_000_000n));
    expect(rows().slice(0, 2)).toEqual(["You got49.875 stDUSK", "Rate1 stDUSK = 2 DUSK"]);
    completed("unstake", fact("unstake", 63_297_959n));
    expect(rows().slice(0, 2)).toEqual(["You gave back0.063297959 stDUSK", "Rate1 stDUSK = 2 DUSK"]);
    // Hidden with the balances.
    completed("stake", fact("stake", 49_875_000_000n), overview({ hideBalances: true }));
    expect(rows().slice(0, 2)).toEqual(["You got•••• stDUSK", "Rate1 stDUSK = 2 DUSK"]);
  });

  it("says what its block said is so far, till the final history says it", () => {
    completed("stake", { ...fact("stake", 49_875_000_000n), final: false });
    expect(rows().slice(0, 2)).toEqual(["You got49.875 stDUSK so far", "Rate1 stDUSK = 2 DUSK"]);
  });

  it("says the stDUSK and rate are coming while its pool's event isn't read yet, never nothing", () => {
    completed("stake", undefined);
    expect(rows()[0]).toBe("You gotstDUSK and rate coming in a moment");
    completed("unstake", undefined);
    expect(rows()[0]).toBe("You gave backstDUSK and rate coming in a moment");
  });
});

describe("after Confirm", () => {
  it("shows a memo in the order it was written, what it hides flagged", async () => {
    const rlo = String.fromCodePoint(0x202e);
    const state = reviewState();
    state.draft.memo = `${rlo}gnp.exe`;
    const app = popup(state);
    await settle();
    await app.confirm();
    const row = body.querySelectorAll(".kv").find((kv) => kv.querySelector(".kv-label")?.textContent === "Memo");
    expect(row.querySelector(".safe-text > span").textContent).toBe("\\u202egnp.exe");
    expect(row.querySelector(".safe-text__flag")).not.toBeNull();
    expect(visibleText(body)).not.toContain(rlo);
  });

  it("shows Sending at once, then Sent to the network with the transaction ID, Copy and the Dusk explorer", async () => {
    const state = reviewState();
    const app = popup(state);
    await settle();
    const reply = await app.confirm();

    // Straight to the Sent screen, not home with a toast.
    expect(state.route).toBe("sent");
    expect(visibleText(body.querySelector(".sent-head"))).toBe("Send1,500 DUSKto 21n5nc…fMMLNz");
    expect(note()).toBe("You can close the wallet; this continues in the background.");
    expect(steps()).toEqual([
      ["current", "Sending", "Signing it and handing it to the network"],
      ["upcoming", "Sent to the network", ""],
      ["upcoming", "Completed", ""],
    ]);
    // The note sits above the steps.
    const sent = body.querySelector(".sent");
    expect(sent.children.map((el) => el.className)).toEqual(["sent-head", "sent-note", "stepper", "group", "sent-actions"]);
    expect(body.querySelector(".step.is-current").getAttribute("aria-current")).toBe("step");
    expect(app.actions.showToast).not.toHaveBeenCalled();

    reply.resolve({ ok: true, result: { hash: HASH } });
    await settle();
    expect(steps().map(([s, label]) => [s, label])).toEqual([
      ["done", "Sending"],
      ["current", "Sent to the network"],
      ["upcoming", "Completed"],
    ]);
    expect(steps()[1][2]).toBe("Waiting for a block, usually about 10 seconds");
    expect(rows()).toEqual(["Transaction ID3e6a0e…ae84baCopy", "MemoLunch", "Network feeUp to 0.0025 DUSK"]);
    expect(app.actions.announce).toHaveBeenLastCalledWith("Sent to the network. Waiting for a block, usually about 10 seconds");
    // The review's draft is done with.
    expect(state.draft).toBeNull();

    const copy = button("Copy");
    expect(copy.getAttribute("aria-label")).toBe("Copy transaction ID");
    copy.click();
    await settle();
    expect(dom.clipboard.writeText).toHaveBeenCalledWith(HASH);
    // It says so on itself, not in a toast.
    expect([visibleText(copy), copy.getAttribute("aria-label")]).toEqual(["Copied", "Copied"]);
    expect(app.actions.showToast).not.toHaveBeenCalled();

    // Dusk's explorer, never DuskScan.
    body.querySelectorAll("button").find((b) => b.textContent === "View in Dusk explorer").click();
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
    expect(steps()).toEqual([
      ["done", "Sending", steps()[0][2]],
      ["done", "Sent to the network", ""],
      ["done", "Completed", "In block 1,234,567"],
    ]);
    expect(steps()[0][2]).toMatch(/^\d\d:\d\d [A-Z][A-Za-z0-9+:−-]* · from your public balance$/);
    // Finished: no note about closing the wallet.
    expect(note()).toBeNull();
    // To the last lux, as its transaction's details say it.
    expect(rows().at(-1)).toBe("Network fee0.000312345 DUSK");

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
    expect(steps().slice(1)).toEqual([
      ["done", "Sent to the network", ""],
      ["failed", "Failed", "It ran out of gas. A higher gas limit lets it finish. Fee charged: 0.0025 DUSK."],
    ]);
    expect(rows().at(-1)).toBe("Fee charged0.0025 DUSK");

    // Dropped before it ran: nothing was charged, and the watcher's code isn't a reason.
    noteTxStatus(state.sent, { hash: HASH, status: "removed", error: "reconciliation_unavailable" });
    app.draw();
    expect(steps()[2]).toEqual(["failed", "Failed", "The network dropped it before it ran. No fee was charged."]);
    expect(rows().at(-1)).toBe("Network feeNone charged");
  });

  it.each([
    ["Failed to deserialize the buffer", "The wallet couldn't read the address. Check it and try again."],
    ["Unknown error code: 251", "The wallet couldn't build this transaction."],
  ])("says plainly that nothing went out when the wallet can't build it: %s", async (message, words) => {
    const state = reviewState();
    const app = popup(state);
    await settle();
    (await app.confirm()).resolve({ error: { message } });
    await settle();
    expect(steps()[0]).toEqual(["failed", "Not sent", `${words} No fee was charged.`]);
  });

  it("doesn't claim nothing went out when the reply was lost, and leads with Done", async () => {
    const state = reviewState();
    const app = popup(state);
    await settle();
    (await app.confirm()).resolve({ error: { message: "The message port closed before a response was received." } });
    await settle();
    expect(steps()[0]).toEqual([
      "unknown",
      "Not confirmed",
      "The message port closed before a response was received. It may still have reached the network: check Activity before you send it again.",
    ]);
    expect(rows().at(-1)).toBe("Network feeUp to 0.0025 DUSK, if it went out");
    expect(body.querySelectorAll(".sent-actions button").map((b) => [b.textContent, b.className])).toEqual([
      ["Done", "btn-primary"],
      ["Back to review", "btn-outline sent-secondary"],
    ]);
    // The draft stays for Back, and nothing says no fee was charged.
    expect(visibleText(body)).not.toContain("No fee was charged");
    expect(state.draft).toMatchObject({ to: OTHER });
  });

  it("says a lost connection in words, not the socket's, as Sofia's offline Confirm showed it", async () => {
    const state = reviewState();
    const app = popup(state);
    await settle();
    (await app.confirm()).resolve({ error: { message: "WebSocket connection failed to wss://testnet.nodes.dusk.network/on (readyState=3)" } });
    await settle();
    expect(steps()[0]).toEqual([
      "unknown",
      "Not confirmed",
      "The connection to the network was lost. It may still have reached the network: check Activity before you send it again.",
    ]);
    expect(visibleText(body)).not.toMatch(/WebSocket|readyState|wss:/);
  });

  it("keeps a send the network didn't take on the Sent screen, with Back to the review as it was", async () => {
    const state = reviewState();
    const app = popup(state);
    await settle();
    (await app.confirm()).resolve({ error: { message: "Insufficient balance" } });
    await settle();

    expect(steps()).toEqual([
      ["failed", "Not sent", "Insufficient balance. No fee was charged."],
      ["upcoming", "Sent to the network", ""],
      ["upcoming", "Completed", ""],
    ]);
    expect(rows()).toEqual(["MemoLunch", "Network feeNone charged"]);
    expect(note()).toBeNull();
    expect(button("View in Dusk explorer")).toBeUndefined();

    button("Back to review").click();
    await settle();
    expect(state.route).toBe("confirm");
    expect(state.draft).toMatchObject({ to: OTHER, amountLux: dusk(1500), memo: "Lunch" });
    expect(button("Confirm")).toBeTruthy();
  });

  it("never shows a node's reply as raw JSON, cut off or whole", async () => {
    const state = reviewState();
    const app = popup(state);
    await settle();
    const reply = JSON.stringify({ error: "Invalid input: Tx 7abc0686 not accepted: this transaction is invalid Value spent larger than account holds" });
    (await app.confirm()).resolve({ error: { message: reply } });
    await settle();
    expect(steps()[0]).toEqual(["failed", "Not sent", "The node refused it: the balance doesn't cover the amount and the network fee. No fee was charged."]);
    expect(visibleText(body)).not.toContain("{");
    expect(visibleText(body)).not.toContain("Invalid input");
  });

  it("says whole why a node it won't sign for got nothing", async () => {
    const state = reviewState();
    const app = popup(state);
    await settle();
    const refusal = "hostile-node.example now says it's on Mainnet (chain 1), not Testnet (chain 2). Nothing was signed, because a signature here could count on the other network.";
    (await app.confirm()).resolve({ error: { message: refusal } });
    await settle();
    expect(steps()[0]).toEqual(["failed", "Not sent", `${refusal} No fee was charged.`]);
  });

  it.each(["Wallet changed while awaiting approval", "Wallet or network changed while transaction was queued"])(
    "says nothing went out when the wallet refused it for another network, profile or wallet than its review's: %s",
    async (error) => {
      const app = popup(reviewState());
      await settle();
      (await app.confirm()).resolve({ error: { message: error } });
      await settle();
      expect(steps()[0]).toEqual(["failed", "Not sent", `${error}. No fee was charged.`]);
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
    expect(steps()[0]).toEqual(["failed", "Not sent", "The wallet changed while you reviewed it. No fee was charged."]);
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
      expect(steps()[0]).toEqual(["failed", "Not sent", "The network, profile or wallet changed meanwhile. No fee was charged."]);
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
    expect(app.actions.showToast).toHaveBeenCalledWith({ text: "Send failed. Insufficient balance. No fee was charged.", tone: "bad" });
    // The review is still there to go back to.
    expect(state.draft).toMatchObject({ to: OTHER, amountLux: dusk(1500) });
  });

  it("hides the amount and the fee with Hide balances", async () => {
    const state = reviewState();
    const app = popup(state, overview({ hideBalances: true }));
    await settle();
    (await app.confirm()).resolve({ ok: true, result: { hash: HASH } });
    await settle();
    const amount = body.querySelector(".sent-amount");
    expect([visibleText(amount), screenReaderText(amount)]).toEqual(["•••• DUSK", "hidden DUSK"]);
    expect(rows().at(-1)).toBe("Network feeUp to •••• DUSK");
  });

  it("leaves the fee out of a failed step's words with Hide balances, shown and announced", () => {
    const sent = { phase: "sent", hash: HASH, status: "failed", feeCapLux: "2500000" };
    const txs = [{ hash: HASH, status: "failed", feePaid: "2000000" }];
    expect(sentSteps(sent, overview({ txs })).at(-1).sub).toContain("Fee charged: 0.002 DUSK.");
    expect(sentSteps(sent, overview({ txs, hideBalances: true })).at(-1).sub).toContain("A fee was charged.");
    expect(sentAnnouncement(sent, overview({ txs, hideBalances: true }))).not.toMatch(/\d DUSK/);
    // The cap, where the fee isn't known yet.
    expect(sentSteps(sent, overview()).at(-1).sub).toContain("Fee charged: up to 0.0025 DUSK.");
    expect(sentSteps(sent, overview({ hideBalances: true })).at(-1).sub).not.toMatch(/\d DUSK/);
  });

  it("says to leave the screen where there is no popup to close", async () => {
    isExtensionRuntime.mockReturnValue(false);
    try {
      const state = reviewState();
      const app = popup(state);
      await settle();
      await app.confirm();
      expect(note()).toBe("You can leave this screen; this continues in the background.");
    } finally {
      isExtensionRuntime.mockReturnValue(true);
    }
  });

  it("is where Shield's Confirm goes too, and gas that won't do stays on Review", async () => {
    const state = { route: "convert_confirm", draft: { kind: TX_KIND.SHIELD, amountDusk: "2", amountLux: dusk(2) } };
    const app = popup(state, overview(), convertConfirmView);
    await settle();
    // Half the gas set: said above Confirm, nothing sent.
    const editor = body.querySelector("dusk-gas-editor");
    editor.setGas({ limit: "30000000", price: "" });
    button("Confirm").click();
    await settle();
    expect(state.route).toBe("convert_confirm");
    expect(body.querySelector(".review-actions > .field-error").textContent).toBe(
      "Enter both the gas limit and the gas price, or clear both."
    );
    expect(app.actions.send.mock.calls.filter(([m]) => m.type === "DUSK_UI_SEND_TX")).toEqual([]);

    editor.setGas({ limit: "30000000", price: "1" });
    (await app.confirm()).resolve({ ok: true, result: { hash: HASH } });
    await settle();
    expect(state.route).toBe("sent");
    expect(visibleText(body.querySelector(".sent-head"))).toBe("Shield2 DUSKPublic → Shielded");
    expect(rows().at(-1)).toBe("Network feeUp to 0.03 DUSK");
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
    expect(button("Confirm").disabled).toBe(false);

    pastClickGuard();
    await app.confirm();
    expect(sends()).toHaveLength(1);
    expect(state.route).toBe("sent");
  });
});

describe("the steps", () => {
  it("wait on the network while the watcher hasn't heard, and say so when it takes long", () => {
    const sent = { phase: "sent", status: "submitted", hash: HASH, sentAt: Date.now(), from: "from your public balance" };
    expect(sentSteps(sent).map((s) => s.state)).toEqual(["done", "current", "upcoming"]);
    // The overview's record fills in a final word the screen missed.
    const ov = { txs: [{ hash: HASH, status: "executed" }] };
    expect(sentSteps(sent, ov).map((s) => s.state)).toEqual(["done", "done", "done"]);
    sent.status = "unknown";
    expect(sentSteps(sent)[1].sub).toBe("Taking longer than usual. It can still go through; the explorer shows where it is.");
  });

  it("come with the watcher's news through app.js, which keeps toasts for other screens", async () => {
    const app = await readFile(path.resolve(process.cwd(), "src", "ui", "popup", "app.js"), "utf8");
    expect(app).toContain("const forSent = noteTxStatus(state.sent, { ...msg, hash, status });");
    expect(app).toMatch(/if \(forSent && state\.route === "sent"\) \{\s*toaster\.announce\(/);
    expect(app).toContain('if (state.route === "sent") {');
  });
});
