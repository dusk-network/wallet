import { h } from "../lib/dom.js";
import { copyToClipboard } from "../lib/clipboard.js";
import { truncateMiddle } from "../lib/strings.js";
import { identiconEl } from "./Identicon.js";
import { duskNameEl } from "./DuskName.js";

// `name`, a lookup of the account's .dusk name, shows it above the short account once there is one.
export function accountChipEl(account, { onCopy, connected, host, name } = {}) {
  const short = account ? truncateMiddle(account, 6, 4) : "—";
  const text = h("div", { class: "chip-text", text: short });

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
    [icon, name ? h("div", { class: "chip-lines" }, [duskNameEl(name), text]) : text]
  );
}
