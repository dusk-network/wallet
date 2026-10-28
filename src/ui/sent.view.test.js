import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TX_KIND } from "../shared/constants.js";
// The fake DOM goes before the views: it defines HTMLElement for the gas editor.
import { installFakeDom, isShown, screenReaderText, settle, visibleText } from "./testing/fakeDom.js";
import { isExtensionRuntime } from "../platform/runtime.js";
import { convertConfirmView } from "./popup/views/convert.js";
import { sendConfirmView } from "./popup/views/send.js";
import { noteTxStatus, sentSteps, sentView } from "./popup/views/sent.js";

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
  balance: { value: dusk(1500) },
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
  // Other routes (home) draw nothing here.
  const draw = () => {
    const nodes =
      state.route === "sent"
        ? sentView(ov, { state, actions })
        : state.route === reviewRoute
          ? reviewView(ov, { state, actions })
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
const button = (text) => body.querySelectorAll("button").find((b) => isShown(b) && b.textContent === text);
const note = () => body.querySelector(".sent-note")?.textContent ?? null;

const reviewState = () => ({
  route: "confirm",
  addressBook: { loaded: true, items: [] },
  draft: { to: OTHER, privacy: "public", amountDusk: "1500", amountLux: dusk(1500), memo: "Lunch" },
});

describe("after Confirm", () => {
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
    expect(rows()).toEqual(["Transaction ID3e6a0ec6…7eae84baCopy", "MemoLunch", "Network feeUp to 0.0025 DUSK"]);
    expect(app.actions.announce).toHaveBeenLastCalledWith("Sent to the network. Waiting for a block, usually about 10 seconds");
    // The review's draft is done with.
    expect(state.draft).toBeNull();

    button("Copy").click();
    await settle();
    expect(dom.clipboard.writeText).toHaveBeenCalledWith(HASH);
    expect(button("Copy").getAttribute("aria-label")).toBe("Copy transaction ID");

    // Dusk's explorer, never DuskScan.
    body.querySelectorAll("button").find((b) => b.textContent === "View in Dusk explorer").click();
    await settle();
    expect(dom.window.open).toHaveBeenCalledWith(
      `https://apps.testnet.dusk.network/explorer/transactions/transaction/?id=${HASH}`,
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
    expect(steps()[0][2]).toMatch(/^\d\d:\d\d · from your public balance$/);
    // Finished: no note about closing the wallet.
    expect(note()).toBeNull();
    expect(rows().at(-1)).toBe("Network fee0.0003 DUSK");

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
      ["failed", "Failed", "Out of gas. Fee charged: 0.0025 DUSK."],
    ]);
    expect(rows().at(-1)).toBe("Fee charged0.0025 DUSK");

    // Dropped before it ran: nothing was charged, and the watcher's code isn't a reason.
    noteTxStatus(state.sent, { hash: HASH, status: "removed", error: "reconciliation_unavailable" });
    app.draw();
    expect(steps()[2]).toEqual(["failed", "Failed", "The network dropped it before it ran. No fee was charged."]);
    expect(rows().at(-1)).toBe("Network feeNone charged");
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

  it("hides the amount with Hide balances, and leaves the fee", async () => {
    const state = reviewState();
    const app = popup(state, overview({ hideBalances: true }));
    await settle();
    (await app.confirm()).resolve({ ok: true, result: { hash: HASH } });
    await settle();
    const amount = body.querySelector(".sent-amount");
    expect([visibleText(amount), screenReaderText(amount)]).toEqual(["•••• DUSK", "hidden DUSK"]);
    expect(rows().at(-1)).toBe("Network feeUp to 0.0025 DUSK");
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
    expect(body.querySelector(".field-error").textContent).toBe(
      "Provide both gas limit and gas price (or clear both to use wallet defaults)."
    );
    expect(app.actions.send.mock.calls.filter(([m]) => m.type === "DUSK_UI_SEND_TX")).toEqual([]);

    editor.setGas({ limit: "30000000", price: "1" });
    (await app.confirm()).resolve({ ok: true, result: { hash: HASH } });
    await settle();
    expect(state.route).toBe("sent");
    expect(visibleText(body.querySelector(".sent-head"))).toBe("Shield2 DUSKPublic → Shielded");
    expect(rows().at(-1)).toBe("Network feeUp to 0.0300 DUSK");
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
