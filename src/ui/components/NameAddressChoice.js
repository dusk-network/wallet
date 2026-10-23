import { h } from "../lib/dom.js";
import { shortAddressEl } from "./ShortAddress.js";

let choices = 0;

/**
 * "Not enough shielded DUSK · Shield first", where "Shield first" calls
 * `onShield` (the send form opens Shield with it).
 *
 * @param {{ onShield?: () => void }} [opts]
 * @returns {HTMLElement}
 */
export function shieldedShortfallEl({ onShield } = {}) {
  return h("div", { class: "name-shortfall" }, [
    "Not enough shielded DUSK · ",
    h("button", {
      class: "name-shortfall__link",
      type: "button",
      text: "Shield first",
      onclick: () => onShield?.(),
    }),
  ]);
}

/**
 * Where a .dusk name is paid, under "<name> points to": an option card for its
 * public account and one for its shielded address, each with its title and
 * short address, then what the chain shows. The shielded card can't be picked
 * when `shieldedDisabled`, and then says how to fix that in place of what the
 * chain shows.
 *
 * The two cards of a name with both addresses are a radio group; they only
 * report a pick through `onChoose`, and `set` shows one. A name with one
 * address has nothing to choose, so its card shows picked and is no radio.
 *
 * @param {object} opts
 * @param {string} opts.name - the name, as resolved
 * @param {string} [opts.account] - its public account
 * @param {string} [opts.address] - its shielded address
 * @param {boolean} [opts.shielded] - whether the shielded address is picked
 * @param {boolean} [opts.shieldedDisabled] - the shielded balance can't pay for a transfer
 * @param {(shielded: boolean) => void} [opts.onChoose]
 * @param {() => void} [opts.onShield]
 * @returns {{ el: HTMLElement, set: (shielded: boolean) => void }}
 */
export function nameAddressChoice({
  name,
  account,
  address,
  shielded = false,
  shieldedDisabled = false,
  onChoose,
  onShield,
}) {
  const headId = `name-choice-${++choices}`;
  const choosing = Boolean(account && address);

  const option = ({ isShielded, title, value, line, disabled }) => {
    const radio = h(
      "div",
      {
        class: "name-option__main",
        ...(choosing && {
          role: "radio",
          "aria-checked": "false",
          "aria-disabled": disabled ? "true" : undefined,
          tabindex: "-1",
          onclick: () => {
            if (!disabled) onChoose?.(isShielded);
          },
        }),
      },
      [
        h("span", { class: "name-option__dot", "aria-hidden": "true" }),
        h("span", { class: "name-option__title" }, [
          h("span", { class: "name-option__label", text: title }),
          shortAddressEl(value, { className: "name-option__addr" }),
        ]),
        disabled ? null : h("span", { class: "name-option__line", text: line }),
      ]
    );
    // The shortfall's link sits beside the radio rather than in it: a radio can't hold a button.
    const card = h("div", { class: disabled ? "name-option is-disabled" : "name-option" }, [
      radio,
      disabled ? shieldedShortfallEl({ onShield }) : null,
    ]);
    return { shielded: isShielded, disabled, radio, card };
  };

  const options = [
    account && option({ isShielded: false, title: "Public account", value: account, line: "Visible on chain" }),
    address &&
      option({ isShielded: true, title: "Shielded address", value: address, line: "Private", disabled: shieldedDisabled }),
  ].filter(Boolean);

  const group = h(
    "div",
    { class: "name-choice", ...(choosing && { role: "radiogroup", "aria-labelledby": headId }) },
    options.map((o) => o.card)
  );

  const set = (next) => {
    for (const o of options) {
      const on = !choosing || o.shielded === (next === true);
      o.card.classList.toggle("is-checked", on);
      if (!choosing) continue;
      o.radio.setAttribute("aria-checked", String(on));
      // Tab reaches the group at its checked option.
      o.radio.setAttribute("tabindex", on ? "0" : "-1");
    }
  };

  // Arrow keys move to the next option that can be picked and pick it; Space
  // or Enter picks the focused one.
  const steps = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
  group.addEventListener("keydown", (e) => {
    const at = options.findIndex((o) => o.radio === e.target);
    if (at < 0) return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (!options[at].disabled) onChoose?.(options[at].shielded);
      return;
    }
    const step = steps[e.key];
    if (!step) return;
    e.preventDefault();
    for (let i = 1; i < options.length; i++) {
      const next = options[(((at + step * i) % options.length) + options.length) % options.length];
      if (next.disabled) continue;
      next.radio.focus();
      onChoose?.(next.shielded);
      return;
    }
  });

  set(shielded);

  return {
    el: h("div", { class: "name-choice-wrap" }, [
      h("div", { class: "muted name-points-to", id: headId }, [
        h("span", { class: "name-points-to__name", text: name }),
        " points to",
      ]),
      group,
    ]),
    set,
  };
}
