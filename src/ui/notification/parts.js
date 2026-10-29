// The pieces every approval window is made of, in the calm look: the site
// that asks, what it asks for, grouped key-value rows, short notes, and a
// Details disclosure for the technical lines. Styles: public/notification.css
// on top of the component layer in ui.css.

import { h } from "../lib/dom.js";
import { shortAddress, siteName } from "../lib/strings.js";
import { iconSvg } from "../components/ActionIcon.js";

// A globe: a site.
const GLOBE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/>' +
  '<path d="M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5s1.2-6.1 3.5-8.5Z"/></svg>';

/** Icon markup: the shared set (ActionIcon.js), and a globe for sites. */
export function icon(name) {
  return name === "globe" ? GLOBE : iconSvg(name);
}

/** The site that asks, as a chip above what it asks for. */
export function siteChip(origin) {
  return h("div", { class: "ap-site", title: String(origin ?? "") }, [
    h("span", { class: "ap-site__icon", "aria-hidden": "true", html: icon("globe") }),
    h("span", { class: "sr-only", text: "Request from " }),
    h("span", { class: "ap-site__host", text: siteName(origin) }),
  ]);
}

/**
 * An amount's parts for h(): the number large, the unit and any words before
 * it ("Costs up to") small.
 * @param {{ lead?: string, value: string, unit?: string }} amount
 */
export function amountParts({ lead = "", value, unit = "" }) {
  return [
    lead ? h("span", { class: "ap-amount__lead", text: `${lead} ` }) : null,
    value,
    unit ? h("span", { class: "ap-amount__unit", text: ` ${unit}` }) : null,
  ].filter((part) => part != null);
}

/**
 * What the site asks for: a title, then an amount, a line saying to whom, and
 * small print, each optional.
 * @param {{ title: string, amount?: {lead?: string, value: string, unit: string}|null, to?: Node|string|null, sub?: Node|string|null, tag?: Node|null }} parts
 */
export function requestHead({ title, amount = null, to = null, sub = null, tag = null }) {
  return h("div", { class: "ap-head" }, [
    h("h1", { class: "ap-title", text: title }),
    amount ? h("div", { class: "ap-amount" }, amountParts(amount)) : null,
    to ? h("div", { class: "ap-to" }, [to]) : null,
    sub ? h("div", { class: "ap-sub" }, [sub]) : null,
    tag,
  ]);
}

/** A neutral tag under the head, e.g. "Known DuskEVM bridge call". */
export function headTag(text, iconName = "check") {
  return h("div", { class: "ap-tag" }, [
    h("span", { class: "btn-ico", "aria-hidden": "true", html: icon(iconName) }),
    h("span", { text }),
  ]);
}

/** A key-value row. `stack` puts a long value under its label instead of beside it. */
export function kv(label, value, { stack = false, className = "" } = {}) {
  const cls = ["kv", stack ? "ap-kv--stack" : "", className].filter(Boolean).join(" ");
  return h("div", { class: cls }, [h("span", { class: "kv-label", text: label }), h("span", { class: "kv-value" }, [].concat(value).filter((v) => v != null))]);
}

/** Rows on one surface. */
export function group(rows, { className = "" } = {}) {
  const kept = rows.filter(Boolean);
  return kept.length ? h("div", { class: ["group", className].filter(Boolean).join(" ") }, kept) : null;
}

/** A small heading over a group. */
export function sectionTitle(text, id) {
  return h("h2", { class: "ap-section", id, text });
}

/** Monospace text, for addresses, hashes and function names. */
export function mono(text, { title } = {}) {
  return h("span", { class: "mono", title, text: String(text ?? "") });
}

/**
 * An address or ID shown short, the whole of it in its tooltip and for screen
 * readers: `short` as given, else cut as every Dusk app cuts a Dusk ID (6…6).
 */
export function shortMono(value, short) {
  const full = String(value ?? "");
  short ??= shortAddress(full);
  return short === full
    ? mono(full)
    : h("span", { class: "mono", title: full }, [h("span", { "aria-hidden": "true", text: short }), h("span", { class: "sr-only", text: full })]);
}

/**
 * Facts as rows, each with an icon, a line and a muted line under it.
 * @param {Array<{ icon: string, title: string, sub?: string|Node }|null>} facts
 */
export function facts(items, { label } = {}) {
  return h(
    "ul",
    { class: "group info ap-facts", "aria-label": label },
    items.filter(Boolean).map((f) =>
      h("li", { class: "list-row" }, [
        h("span", { class: "row-icon", "aria-hidden": "true", html: icon(f.icon) }),
        h("span", { class: "row-main" }, [
          h("span", { class: "row-title", text: f.title }),
          f.sub ? h("span", { class: "row-sub" }, [f.sub]) : null,
        ]),
      ])
    )
  );
}

/** A short note with an icon: what becomes visible, what signing does. */
export function note(text, iconName = "info", { className = "" } = {}) {
  return h("p", { class: ["ap-note", className].filter(Boolean).join(" ") }, [
    h("span", { class: "btn-ico", "aria-hidden": "true", html: icon(iconName) }),
    h("span", { text }),
  ]);
}

/** A warning: red only for what can cost the user. */
export function warning(title, text, children = []) {
  return h("div", { class: "callout warn", role: "note" }, [
    h("div", { class: "callout-title", text: title }),
    text ? h("div", { class: "muted", text }) : null,
    ...children,
  ]);
}

/** A disclosure for the lines most people skip: chain, node, raw bytes. */
export function details(summary, children, { open = false, className = "" } = {}) {
  return h("details", { class: ["advanced", "ap-details", className].filter(Boolean).join(" "), open }, [
    h("summary", { text: summary }),
    h("div", { class: "ap-details__body" }, children.filter(Boolean)),
  ]);
}

/**
 * What a site wrote about its request, which the wallet can't check. It
 * shows as the site's JSON, never as the wallet's own rows, so a site can't
 * pass its words off as the wallet's.
 * @param {unknown} display
 */
export function siteDetails(display) {
  if (display === undefined || display === null) return null;
  let json;
  try {
    json = JSON.stringify(display, null, 2);
  } catch {
    json = String(display);
  }
  return h("section", { class: "ap-site-details", "aria-labelledby": "ap-site-details" }, [
    sectionTitle("From the site, not checked by the wallet", "ap-site-details"),
    h("pre", { class: "ap-code", text: json }),
  ]);
}
