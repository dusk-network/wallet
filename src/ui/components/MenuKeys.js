const ITEMS = "[role=menuitem], [role=menuitemradio]";

/**
 * Keys for a header menu, as menus take them elsewhere: Up and Down move
 * between its items and wrap, Home and End go to the first and the last,
 * Escape closes it and goes back to the button that opened it, and Tab closes
 * it and moves on from that button. Focus starts on the checked item, or else
 * on the first. Only the focused item is in the tab order.
 *
 * @param {HTMLElement} menu - the element with role="menu"
 * @param {{ anchor?: HTMLElement|null, close: () => void }} opts
 */
export function menuKeys(menu, { anchor, close }) {
  const items = () => Array.from(menu.querySelectorAll(ITEMS)).filter((el) => !el.disabled);
  for (const el of items()) el.setAttribute("tabindex", "-1");
  const start = items().find((el) => el.getAttribute("aria-checked") === "true") ?? items()[0];
  start?.focus();

  menu.addEventListener("keydown", (e) => {
    const list = items();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement);
    const go = (i) => {
      e.preventDefault();
      list[(i + list.length) % list.length].focus();
    };
    switch (e.key) {
      case "ArrowDown":
        return go(at + 1);
      case "ArrowUp":
        return go(at < 0 ? -1 : at - 1);
      case "Home":
        return go(0);
      case "End":
        return go(-1);
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close();
        anchor?.focus();
        return;
      case "Tab":
        // From the button, the browser's Tab then goes on to what follows it.
        close();
        anchor?.focus();
        return;
      default:
    }
  });
}
