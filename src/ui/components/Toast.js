import { h } from "../lib/dom.js";
import { iconSvg } from "./ActionIcon.js";

// How long a toast stays at least: long enough to read it, and with an action
// long enough to reach that action with the keyboard. The timer also waits
// while the pointer is on the toast or the focus is in it.
export const TOAST_MIN_MS = 4000;
export const TOAST_ACTION_MIN_MS = 8000;

/**
 * A toast: a line of text, or `{ text, parts, tone, action }`, where `parts`
 * are h() children (an amount behind Hide balances, say) shown instead of
 * `text`, `tone` is "info" (default), "ok" or "bad", and `action` is
 * `{ label, onClick }` for a button such as View.
 * @typedef {string|{ text?: string, parts?: Array<string|Node>, tone?: string, action?: { label: string, onClick: Function } }} ToastSpec
 */

function normalize(spec) {
  if (spec == null || spec === "") return null;
  if (typeof spec === "string") return { text: spec, tone: "info" };
  if (typeof spec !== "object") return { text: String(spec), tone: "info" };
  const text = spec.text == null ? "" : String(spec.text);
  const parts = Array.isArray(spec.parts) ? spec.parts.filter((p) => p != null) : null;
  if (!text && !parts?.length) return null;
  const action =
    spec.action && typeof spec.action.onClick === "function" && spec.action.label
      ? { label: String(spec.action.label), onClick: spec.action.onClick }
      : null;
  return { text, parts, tone: spec.tone === "ok" || spec.tone === "bad" ? spec.tone : "info", action };
}

/**
 * The toast element for `spec`, or null for an empty one.
 * @param {ToastSpec} spec
 * @param {{ onAction?: Function }} [opts]
 * @returns {HTMLElement|null}
 */
export function toastView(spec, { onAction } = {}) {
  const t = normalize(spec);
  if (!t) return null;
  const icon = t.tone === "ok" ? "check" : t.tone === "bad" ? "alert" : null;
  return h("div", { class: `toast toast--${t.tone}` }, [
    icon ? h("span", { class: "toast__icon", html: iconSvg(icon) }) : null,
    h("span", { class: "toast__text" }, t.parts?.length ? t.parts : [t.text]),
    t.action
      ? h("button", {
          class: "toast__action",
          type: "button",
          text: t.action.label,
          onclick: () => {
            onAction?.();
            t.action.onClick();
          },
        })
      : null,
  ].filter(Boolean));
}

/**
 * Shows toasts in one live region, kept outside the view that scrolls and
 * redraws (#app), so a toast stays at the bottom of the popup and a redraw
 * doesn't take the focus off its action. Screen readers announce what comes
 * into the region.
 *
 * @param {object} opts
 * @param {Document} [opts.doc]
 * @param {Element} [opts.parent] - where the region goes; the panel by default
 * @param {Element|null} [opts.before] - the element the region goes before
 * `announce` says a line to screen readers only, through a second live
 * region, for screens that show their progress themselves.
 *
 * @returns {{ region: HTMLElement, show: (spec: ToastSpec, ms?: number) => void, clear: () => void, announce: (text: string) => void, readonly current: HTMLElement|null }}
 */
export function createToaster({ doc = globalThis.document, parent, before } = {}) {
  const host = parent ?? doc.querySelector(".panel") ?? doc.body;
  // In the page's order the region comes before the content, so the keyboard
  // reaches a toast's action right after the header.
  const ref =
    before === undefined
      ? [...(host.children ?? [])].find((el) => el.classList?.contains("panel-content")) ?? null
      : before;
  const region = h("div", {
    class: "toast-region",
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true",
  });
  const announcer = h("div", { class: "sr-only", role: "status", "aria-live": "polite" });
  if (ref && ref.parentNode === host) {
    host.insertBefore(region, ref);
    host.insertBefore(announcer, ref);
  } else {
    host.appendChild(region);
    host.appendChild(announcer);
  }

  let current = null;
  let timer = null;
  let remaining = 0;
  let startedAt = 0;
  let hovered = false;
  let focused = false;

  const stopTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const clear = () => {
    stopTimer();
    // The focus was in the toast: keep it in the page rather than losing it.
    const hadFocus = current?.contains?.(doc.activeElement);
    current?.remove();
    current = null;
    hovered = false;
    focused = false;
    if (hadFocus) doc.body?.focus?.();
  };

  const startTimer = () => {
    stopTimer();
    if (!current || hovered || focused) return;
    startedAt = Date.now();
    timer = setTimeout(clear, Math.max(0, remaining));
  };

  const pauseTimer = () => {
    if (!timer) return;
    stopTimer();
    remaining -= Date.now() - startedAt;
  };

  const show = (spec, ms = 0) => {
    const el = toastView(spec, { onAction: () => clear() });
    clear();
    if (!el) return;
    const hasAction = Boolean(el.querySelector(".toast__action"));
    remaining = Math.max(Number(ms) || 0, hasAction ? TOAST_ACTION_MIN_MS : TOAST_MIN_MS);
    el.addEventListener("mouseenter", () => {
      hovered = true;
      pauseTimer();
    });
    el.addEventListener("mouseleave", () => {
      hovered = false;
      startTimer();
    });
    el.addEventListener("focusin", () => {
      focused = true;
      pauseTimer();
    });
    el.addEventListener("focusout", () => {
      focused = false;
      startTimer();
    });
    el.addEventListener("keydown", (e) => {
      if (e?.key === "Escape") clear();
    });
    region.appendChild(el);
    current = el;
    startTimer();
  };

  const announce = (text) => {
    announcer.textContent = String(text ?? "");
  };

  return {
    region,
    show,
    clear,
    announce,
    get current() {
      return current;
    },
  };
}
