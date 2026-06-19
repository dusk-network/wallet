import { h, setChildren } from "../lib/dom.js";
import { identiconEl } from "./Identicon.js";

function badgeClass(kind = "neutral", className = "") {
  return [
    "recipient-badge",
    kind ? `recipient-badge--${kind}` : "",
    className,
  ].filter(Boolean).join(" ");
}

function glyphEl(icon = "") {
  const paths = {
    public: [
      '<path d="M3.7 12s3-5 8.3-5 8.3 5 8.3 5-3 5-8.3 5-8.3-5-8.3-5Z"/>',
      '<circle cx="12" cy="12" r="2.4"/>',
    ],
    shielded: [
      '<path d="M3.7 12s3-5 8.3-5 8.3 5 8.3 5-3 5-8.3 5-8.3-5-8.3-5Z"/>',
      '<circle cx="12" cy="12" r="2.4"/>',
      '<path d="M19.5 4.5 4.5 19.5"/>',
    ],
    request: [
      '<path d="M9.5 7.5 12 5l2.5 2.5"/>',
      '<path d="M12 5v10"/>',
      '<path d="M5 13.5v3A2.5 2.5 0 0 0 7.5 19h9a2.5 2.5 0 0 0 2.5-2.5v-3"/>',
    ],
  };

  if (paths[icon]) {
    return h("span", {
      class: "recipient-badge__glyph recipient-badge__glyph--svg",
      html:
        `<svg viewBox="0 0 24 24" aria-hidden="true">` +
        paths[icon].join("") +
        "</svg>",
    });
  }

  return h("span", { class: "recipient-badge__glyph", text: icon || "" });
}

function badgeChildren({ icon = "", label = "", seed = "" } = {}) {
  const iconContent = seed
    ? identiconEl(seed)
    : glyphEl(icon);

  return [
    h("span", { class: "recipient-badge__icon" }, [iconContent]),
    h("span", { class: "recipient-badge__text", text: label }),
  ];
}

export function recipientTypeBadgeOptions(type) {
  if (type === "address") {
    return {
      kind: "rail",
      icon: "shielded",
      label: "Shielded",
      title: "Shielded address",
    };
  }

  if (type === "account") {
    return {
      kind: "rail",
      icon: "public",
      label: "Public",
      title: "Public account",
    };
  }

  return null;
}

export function privacyFlowBadgeOptions({ from = "", to = "" } = {}) {
  const fromLabel = String(from || "").trim();
  const toLabel = String(to || "").trim();
  const toPublic = toLabel.toLowerCase() === "public";

  return {
    kind: "rail",
    icon: toPublic ? "public" : "shielded",
    label: `${fromLabel} -> ${toLabel}`,
    title: `${fromLabel} to ${toLabel}`,
  };
}

export function recipientBadge({
  kind = "neutral",
  icon = "",
  label = "",
  seed = "",
  title = "",
  className = "",
  hidden = false,
} = {}) {
  const el = h(
    "span",
    {
      class: badgeClass(kind, className),
      title: title || label || "",
      style: hidden ? "display:none" : undefined,
    },
    badgeChildren({ icon, label, seed })
  );

  return el;
}

export function setRecipientBadge(
  el,
  {
    kind = "neutral",
    icon = "",
    label = "",
    seed = "",
    title = "",
    className = "",
  } = {}
) {
  if (!el) return;
  el.className = badgeClass(kind, className);
  el.title = title || label || "";
  setChildren(el, badgeChildren({ icon, label, seed }));
  el.style.display = "inline-flex";
}

export function hideRecipientBadge(el) {
  if (!el) return;
  el.style.display = "none";
  el.removeAttribute("title");
  setChildren(el, []);
}
