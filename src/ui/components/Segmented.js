import { h } from "../lib/dom.js";

/**
 * Two or more choices on one track, the picked one lit: a tab list whose
 * picked tab says so to screen readers, with the arrow keys moving to the
 * next choice. Picking one calls `onSelect`, which redraws the view.
 *
 * @param {{
 *   label: string,
 *   items: { id: string, text: string, disabled?: boolean }[],
 *   selected: string,
 *   onSelect: (id: string) => void,
 *   className?: string,
 * }} opts
 * @returns {HTMLElement}
 */
export function segmented({ label, items, selected, onSelect, className = "" }) {
  const index = Math.max(0, items.findIndex((item) => item.id === selected));
  const pick = (i) => {
    const item = items[(i + items.length) % items.length];
    if (item && !item.disabled && item.id !== items[index]?.id) onSelect?.(item.id);
  };
  const tabs = items.map((item, i) =>
    h(
      "button",
      {
        class: i === index ? "tab is-active" : "tab",
        type: "button",
        role: "tab",
        "aria-selected": i === index,
        tabindex: i === index ? "0" : "-1",
        disabled: Boolean(item.disabled),
        onclick: () => pick(i),
        onkeydown: (e) => {
          if (e?.key === "ArrowRight" || e?.key === "ArrowDown") {
            e.preventDefault?.();
            pick(index + 1);
          } else if (e?.key === "ArrowLeft" || e?.key === "ArrowUp") {
            e.preventDefault?.();
            pick(index - 1);
          }
        },
      },
      [h("span", { text: item.text })]
    )
  );
  return h(
    "div",
    {
      class: ["tabs", className].filter(Boolean).join(" "),
      role: "tablist",
      "aria-label": label,
      style: `--seg-index: ${index};`,
    },
    tabs
  );
}
