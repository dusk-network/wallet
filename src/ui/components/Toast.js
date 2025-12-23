import { h } from "../lib/dom.js";

export function toastView(toastText) {
  if (!toastText) return null;
  return h("div", { class: "toast", text: toastText });
}
