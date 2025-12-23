import { h } from "../lib/dom.js";
import { copyToClipboard } from "../lib/clipboard.js";
import { truncateMiddle } from "../lib/strings.js";
import { identiconEl } from "./Identicon.js";

export function accountChipEl(account, { onCopy } = {}) {
  const short = account ? truncateMiddle(account, 6, 4) : "—";
  return h(
    "button",
    {
      class: "account-chip",
      title: account || "",
      onclick: async () => {
        if (!account) return;
        const ok = await copyToClipboard(account);
        onCopy?.(ok ? "Copied account" : "Copy failed");
      },
    },
    [identiconEl(account || "dusk"), h("div", { class: "chip-text", text: short })]
  );
}
