import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TX_KIND } from "../shared/constants.js";
import { fakeEvent, installFakeDom, screenReaderText, settle, visibleText } from "./testing/fakeDom.js";
import { TOAST_ACTION_MIN_MS, TOAST_MIN_MS, createToaster } from "./components/Toast.js";
import { txStatusToast } from "./popup/txToast.js";
import { lockedView } from "./popup/views/locked.js";

const OTHER_ACCOUNT =
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const dusk = (n) => (BigInt(n) * 1_000_000_000n).toString();

let dom;

// The popup's page: the header, then the panel's content with #app in it.
function popupPage() {
  const { document } = dom;
  const panel = document.createElement("div");
  panel.className = "panel";
  const header = document.createElement("div");
  header.className = "panel-header";
  const content = document.createElement("div");
  content.className = "panel-content";
  const app = document.createElement("div");
  app.id = "app";
  content.appendChild(app);
  panel.append(header, content);
  document.body.appendChild(panel);
  return { panel, header, content, app };
}

beforeEach(() => {
  dom = installFakeDom({ pathname: "/popup.html" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("toasts", () => {
  it("show in a live region outside the view that scrolls, which a redraw leaves alone", () => {
    const { panel, content, app } = popupPage();
    const toaster = createToaster({ doc: dom.document });

    toaster.show("Switched to Testnet");
    const region = toaster.region;
    expect([region.getAttribute("role"), region.getAttribute("aria-live"), region.getAttribute("aria-atomic")]).toEqual([
      "status",
      "polite",
      "true",
    ]);
    // Not in #app or the scrolling content, and before the content in the
    // page's order: the keyboard reaches a toast's action right after the header.
    expect(content.contains(region)).toBe(false);
    expect(panel.children.map((el) => el.className)).toEqual(["panel-header", "toast-region", "panel-content"]);
    expect(region.querySelector(".toast").textContent).toBe("Switched to Testnet");

    // A view redraw replaces #app's children; the toast stays.
    app.replaceChildren(dom.document.createElement("div"));
    expect(region.querySelector(".toast").textContent).toBe("Switched to Testnet");
  });

  it("stay long enough to read, longer with an action, and wait while the focus is on them", () => {
    vi.useFakeTimers();
    popupPage();
    const toaster = createToaster({ doc: dom.document });

    // A short duration asked for is lengthened.
    toaster.show("Copied", 1200);
    vi.advanceTimersByTime(TOAST_MIN_MS - 1);
    expect(toaster.current?.textContent).toBe("Copied");
    vi.advanceTimersByTime(1);
    expect(toaster.current).toBeNull();

    const onView = vi.fn();
    toaster.show({ text: "5 DUSK sent", action: { label: "View", onClick: onView } }, 2500);
    const view = toaster.current.querySelector("button.toast__action");
    expect(view.textContent).toBe("View");
    vi.advanceTimersByTime(TOAST_ACTION_MIN_MS - 1000);
    // Tabbing to View holds the toast.
    view.dispatchEvent(fakeEvent("focusin"));
    vi.advanceTimersByTime(60_000);
    expect(toaster.current).not.toBeNull();
    view.dispatchEvent(fakeEvent("focusout"));
    vi.advanceTimersByTime(999);
    expect(toaster.current).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(toaster.current).toBeNull();

    // View does what it says and closes the toast; Escape closes it too.
    toaster.show({ text: "5 DUSK sent", action: { label: "View", onClick: onView } });
    toaster.current.querySelector("button.toast__action").click();
    expect(onView).toHaveBeenCalledTimes(1);
    expect(toaster.current).toBeNull();
    toaster.show("Saved");
    toaster.current.dispatchEvent(fakeEvent("keydown", { key: "Escape" }));
    expect(toaster.current).toBeNull();
  });

  it("are mounted by the popup once, outside #app", async () => {
    const app = await readFile(path.resolve(process.cwd(), "src", "ui", "popup", "app.js"), "utf8");
    expect(app).toContain("const toaster = createToaster();");
    expect(app).not.toContain("app.prepend(toast)");
    expect(app).not.toContain("state.toast =");
  });

  it("say what a transaction did, its amount hidden with Hide balances and its fee left out", () => {
    const tx = { hash: "ab".repeat(32), kind: TX_KIND.TRANSFER, to: OTHER_ACCOUNT, amount: dusk(1500), status: "executed" };
    const show = (spec) => {
      const toaster = createToaster({ doc: dom.document, parent: dom.document.body });
      toaster.show(spec);
      return toaster.current;
    };

    let el = show(txStatusToast(tx, "executed"));
    expect(visibleText(el)).toBe("1,500 DUSK to 21n5nc…fMMLNz completed");
    expect(el.className).toBe("toast toast--ok");

    el = show(txStatusToast(tx, "executed", { hidden: true, onView: () => {} }));
    expect(visibleText(el)).toBe("•••• DUSK to 21n5nc…fMMLNz completedView");
    expect(screenReaderText(el.querySelector(".toast__text"))).toBe("hidden DUSK to 21n5nc…fMMLNz completed");

    el = show(txStatusToast({ kind: TX_KIND.STAKE, amount: dusk(1000) }, "failed", { hidden: true }));
    expect(visibleText(el)).toBe("Stake of •••• DUSK failed");
    expect(el.className).toBe("toast toast--bad");

    // A saved contact's name in place of the address; no record, no amount.
    el = show(txStatusToast(tx, "mempool", { contactName: () => "Bob" }));
    expect(visibleText(el)).toBe("1,500 DUSK to Bob is still pending");
    el = show(txStatusToast(null, "executed"));
    expect(visibleText(el)).toBe("Transaction completed");
  });
});

describe("unlock", () => {
  it("says a wrong password under the field, not in a toast", async () => {
    popupPage();
    const showToast = vi.fn();
    const send = vi.fn(async () => ({ error: { message: "Incorrect password" } }));
    const nodes = lockedView({ state: {}, actions: { send, showToast, render: vi.fn(async () => {}) } });
    dom.document.querySelector("#app").replaceChildren(...nodes);
    const pwd = dom.document.getElementById("unlock-password");
    const error = dom.document.getElementById("unlock-error");
    expect(error.hidden).toBe(true);

    pwd.value = "wrong";
    dom.document.querySelectorAll("button").find((b) => b.textContent === "Unlock").click();
    await settle();
    expect([error.hidden, error.textContent, error.getAttribute("role")]).toEqual([false, "Incorrect password", "alert"]);
    expect([pwd.getAttribute("aria-invalid"), pwd.getAttribute("aria-describedby")]).toEqual(["true", "unlock-error"]);
    expect(showToast).not.toHaveBeenCalled();

    // Typing again clears it.
    pwd.dispatchEvent(fakeEvent("input"));
    expect([error.hidden, pwd.getAttribute("aria-invalid")]).toEqual([true, null]);
  });
});

describe("fonts", () => {
  it("draw addresses in each system's code font, not Söhne Mono, whose m reads as a gap", async () => {
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");
    const mono = css.match(/--font-mono:([^;]+);/)?.[1] ?? "";
    expect(mono).not.toMatch(/Sohne/i);
    for (const family of ['"SF Mono"', "Consolas", '"Ubuntu Sans Mono"', '"DejaVu Sans Mono"', "monospace"]) {
      expect(mono).toContain(family);
    }
    expect(css).toMatch(/code,\s*\.mono\s*\{\s*font-family: var\(--font-mono\);/);
    // Text in each system's interface font, buttons and fields included.
    const sans = css.match(/--font-sans:([^;]+);/)?.[1] ?? "";
    for (const family of ["-apple-system", '"Segoe UI"', '"Ubuntu Sans"', "Cantarell", '"Noto Sans"', "sans-serif"]) {
      expect(sans).toContain(family);
    }
    expect(css).toMatch(/button, input, select, textarea \{\s*font-family: inherit;/);
    expect(css).not.toContain("@font-face");
  });
});
