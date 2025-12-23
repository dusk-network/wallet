import { h } from "../lib/dom.js";

export function bannerView(banner) {
  if (!banner) return null;
  const cls = banner.kind === "error" ? "err" : "ok";
  return h("div", { class: cls, text: banner.text });
}
