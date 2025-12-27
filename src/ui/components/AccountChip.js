import { h } from "../lib/dom.js";
import { copyToClipboard } from "../lib/clipboard.js";
import { truncateMiddle } from "../lib/strings.js";
import { identiconEl } from "./Identicon.js";

export function accountChipEl(account, { onCopy, connected, host } = {}) {
  const short = account ? truncateMiddle(account, 6, 4) : "—";

  const icon = identiconEl(account || "dusk");
  if (host) {
    icon.classList.add("identicon--badged");
    icon.appendChild(
      h("div", {
        class: [
          "identicon-badge",
          connected ? "identicon-badge--on" : "identicon-badge--off",
        ].join(" "),
      })
    );
  }

  const title = host
    ? `${account || ""}\n${connected ? "Connected" : "Site"}: ${host}`
    : account || "";

  return h(
    "button",
    {
      class: "account-chip",
      title,
      onclick: async () => {
        if (!account) return;
        const ok = await copyToClipboard(account);
        onCopy?.(ok ? "Copied account" : "Copy failed");
      },
    },
    [icon, h("div", { class: "chip-text", text: short })]
  );
}
