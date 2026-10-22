import { h } from "../lib/dom.js";
import { truncateMiddle } from "../lib/strings.js";

let choices = 0;

/**
 * "Not enough shielded DUSK. Shield DUSK first", where the link calls
 * `onShield` (the send form opens Shield with it).
 *
 * @param {{ onShield?: () => void }} [opts]
 * @returns {HTMLElement}
 */
export function shieldedShortfallEl({ onShield } = {}) {
  return h("div", { class: "name-shortfall" }, [
    "Not enough shielded DUSK. ",
    h("button", {
      class: "name-shortfall__link",
      type: "button",
      text: "Shield DUSK first",
      onclick: () => onShield?.(),
    }),
  ]);
}

/**
 * Where a .dusk name with both addresses is paid: its public account or its
 * shielded address, as two option cards in a radio group under "<name> points
 * to". Each card says which balance pays and what the chain shows. The
 * shielded card can't be picked when `shieldedDisabled`, and then says how to
 * fix that.
 *
 * The cards only report a pick through `onChoose`; `set` shows one.
 *
 * @param {object} opts
 * @param {string} opts.name - the name, as resolved
 * @param {string} opts.account - its public account
 * @param {string} opts.address - its shielded address
 * @param {boolean} [opts.shielded] - whether the shielded address is picked
 * @param {string} opts.publicBalance - the public balance, in DUSK
 * @param {string} opts.shieldedBalance - the spendable shielded balance, in DUSK
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
  publicBalance,
  shieldedBalance,
  shieldedDisabled = false,
  onChoose,
  onShield,
}) {
  const option = ({ isShielded, title, value, balanceName, balance, shown, disabled }) => {
    const radio = h(
      "div",
      {
        class: "name-option__main",
        role: "radio",
        "aria-checked": "false",
        "aria-disabled": disabled ? "true" : undefined,
        tabindex: "-1",
        onclick: () => {
          if (!disabled) onChoose?.(isShielded);
        },
      },
      [
        h("span", { class: "name-option__dot", "aria-hidden": "true" }),
        h("span", { class: "name-option__title" }, [
          h("span", { class: "name-option__label", text: title }),
          h("code", { class: "name-option__addr", text: truncateMiddle(value, 6, 6), title: value }),
        ]),
        h("span", { class: "name-option__line" }, [
          "From your ",
          h("strong", { text: balanceName }),
          ` (${balance} DUSK). ${shown}`,
        ]),
      ]
    );
    const card = h("div", { class: disabled ? "name-option is-disabled" : "name-option" }, [
      radio,
      disabled ? shieldedShortfallEl({ onShield }) : null,
    ]);
    return { shielded: isShielded, disabled, radio, card };
  };

  const options = [
    option({
      isShielded: false,
      title: "Public account",
      value: account,
      balanceName: "public balance",
      balance: publicBalance,
      shown: "Amount and both accounts are visible on chain.",
      disabled: false,
    }),
    option({
      isShielded: true,
      title: "Shielded address",
      value: address,
      balanceName: "shielded balance",
      balance: shieldedBalance,
      shown: "Amount and both parties stay private.",
      disabled: shieldedDisabled,
    }),
  ];

  const headId = `name-choice-${++choices}`;
  const group = h(
    "div",
    { class: "name-choice", role: "radiogroup", "aria-labelledby": headId },
    options.map((o) => o.card)
  );

  const set = (next) => {
    for (const o of options) {
      const on = o.shielded === (next === true);
      o.card.classList.toggle("is-checked", on);
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
      h("div", { class: "muted name-points-to", id: headId, text: `${name} points to` }),
      group,
    ]),
    set,
  };
}
