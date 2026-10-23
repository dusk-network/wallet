import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installFakeDom, press, screenReaderText, visibleText } from "../testing/fakeDom.js";
import { nameAddressChoice, shieldedShortfallEl } from "./NameAddressChoice.js";

const ACCOUNT =
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const ADDRESS =
  "4QpZhL54DtNrCpXRK54BhfF8WYsgvPbfVTfeNf2ePSRPTCnuZYMk988Es2NMbwCXMPTKGTLfYunZ4mbFc7i743QE";

let dom;

beforeEach(() => {
  dom = installFakeDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function choice(opts = {}) {
  const onChoose = vi.fn();
  const onShield = vi.fn();
  const view = nameAddressChoice({
    name: "alice.dusk",
    account: ACCOUNT,
    address: ADDRESS,
    onChoose,
    onShield,
    ...opts,
  });
  dom.document.body.appendChild(view.el);
  const [publicRadio, shieldedRadio] = view.el.querySelectorAll("[role=radio]");
  return { ...view, onChoose, onShield, publicRadio, shieldedRadio };
}

const checked = (radio) => radio.getAttribute("aria-checked");

describe("name address choice", () => {
  it("offers the public account and the shielded address as a radio group under the name", () => {
    const { el, publicRadio, shieldedRadio } = choice();
    const head = el.querySelector(".name-points-to");
    expect(head.textContent).toBe("alice.dusk points to");
    // The name leads; the cards' addresses follow short and muted.
    expect(head.querySelector(".name-points-to__name").textContent).toBe("alice.dusk");
    const group = el.querySelector("[role=radiogroup]");
    expect(group.getAttribute("aria-labelledby")).toBe(head.id);
    expect(head.id).not.toBe("");

    expect(publicRadio.querySelector(".name-option__label").textContent).toBe("Public account");
    const addr = publicRadio.querySelector(".name-option__addr");
    expect([visibleText(addr), addr.title, screenReaderText(addr)]).toEqual(["21n5nc…fMMLNz", ACCOUNT, ACCOUNT]);
    expect(publicRadio.querySelector(".name-option__line").textContent).toBe("Visible on chain");
    expect(shieldedRadio.querySelector(".name-option__label").textContent).toBe("Shielded address");
    expect(shieldedRadio.querySelector(".name-option__line").textContent).toBe("Private");

    // Each card shows its title, short address and one line, and no balance;
    // screen readers get the full address in place of the short one.
    expect([visibleText(publicRadio), visibleText(shieldedRadio)]).toEqual([
      "Public account21n5nc…fMMLNzVisible on chain",
      "Shielded address4QpZhL…i743QEPrivate",
    ]);
    expect(screenReaderText(publicRadio)).toBe(`Public account${ACCOUNT}Visible on chain`);
    expect(screenReaderText(shieldedRadio)).toBe(`Shielded address${ADDRESS}Private`);
    expect(el.querySelector(".name-shortfall")).toBeNull();
    // Each radio shows its mark.
    expect([publicRadio, shieldedRadio].map((radio) => radio.querySelectorAll(".name-option__dot").length)).toEqual([1, 1]);
    expect(el.querySelector(".name-option--single")).toBeNull();
  });

  it("starts on the public account and reaches the group at the checked option", () => {
    const { publicRadio, shieldedRadio } = choice();
    expect([checked(publicRadio), checked(shieldedRadio)]).toEqual(["true", "false"]);
    expect([publicRadio.getAttribute("tabindex"), shieldedRadio.getAttribute("tabindex")]).toEqual(["0", "-1"]);
    expect(publicRadio.parentNode.classList.contains("is-checked")).toBe(true);
  });

  it("reports a click and shows a pick only when told", () => {
    const { set, onChoose, publicRadio, shieldedRadio } = choice();
    shieldedRadio.click();
    expect(onChoose).toHaveBeenCalledWith(true);
    expect(checked(shieldedRadio)).toBe("false");

    set(true);
    expect([checked(publicRadio), checked(shieldedRadio)]).toEqual(["false", "true"]);
    expect(shieldedRadio.getAttribute("tabindex")).toBe("0");
    expect(shieldedRadio.parentNode.classList.contains("is-checked")).toBe(true);
    expect(publicRadio.parentNode.classList.contains("is-checked")).toBe(false);
  });

  it("moves and picks with the arrow keys, and picks the focused option with Space", () => {
    const { onChoose, publicRadio, shieldedRadio } = choice();
    for (const [key, from, to, picked] of [
      ["ArrowDown", publicRadio, shieldedRadio, true],
      ["ArrowRight", publicRadio, shieldedRadio, true],
      ["ArrowUp", shieldedRadio, publicRadio, false],
      ["ArrowLeft", shieldedRadio, publicRadio, false],
      // Past the last option, back to the first.
      ["ArrowDown", shieldedRadio, publicRadio, false],
    ]) {
      onChoose.mockClear();
      from.focus();
      expect(press(from, key)).toBe(false);
      expect(dom.document.activeElement).toBe(to);
      expect(onChoose).toHaveBeenCalledWith(picked);
    }

    onChoose.mockClear();
    press(shieldedRadio, " ");
    expect(onChoose).toHaveBeenCalledWith(true);
    press(publicRadio, "Tab");
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  it("disables the shielded address when the shielded balance can't pay, and links to Shield", () => {
    const { el, onChoose, onShield, publicRadio, shieldedRadio } = choice({ shieldedDisabled: true });
    expect(shieldedRadio.getAttribute("aria-disabled")).toBe("true");
    expect(publicRadio.hasAttribute("aria-disabled")).toBe(false);
    expect(shieldedRadio.parentNode.classList.contains("is-disabled")).toBe(true);
    // The shortfall takes the place of "Private".
    expect(shieldedRadio.querySelector(".name-option__line")).toBeNull();
    expect(visibleText(shieldedRadio.parentNode)).toBe(
      "Shielded address4QpZhL…i743QENot enough shielded DUSK · Shield first"
    );

    shieldedRadio.click();
    press(shieldedRadio, " ");
    publicRadio.focus();
    press(publicRadio, "ArrowDown");
    expect(onChoose).not.toHaveBeenCalled();
    expect(dom.document.activeElement).toBe(publicRadio);

    // The hint sits in the shielded card, beside its radio rather than in it.
    const hint = el.querySelector(".name-shortfall");
    expect(hint.parentNode).toBe(shieldedRadio.parentNode);
    expect(hint.textContent).toBe("Not enough shielded DUSK · Shield first");
    hint.querySelector("button").click();
    expect(onShield).toHaveBeenCalledTimes(1);
  });

  it("can show a picked shielded address that the balance no longer pays", () => {
    const { publicRadio, shieldedRadio } = choice({ shielded: true, shieldedDisabled: true });
    expect([checked(publicRadio), checked(shieldedRadio)]).toEqual(["false", "true"]);
  });

  it.each([
    ["only a public account", { address: undefined }, "Public account21n5nc…fMMLNzVisible on chain", ACCOUNT],
    ["only a shielded address", { account: undefined }, "Shielded address4QpZhL…i743QEPrivate", ADDRESS],
    [
      "only a shielded address the balance can't pay",
      { account: undefined, shieldedDisabled: true },
      "Shielded address4QpZhL…i743QENot enough shielded DUSK · Shield first",
      ADDRESS,
    ],
  ])("shows a name with %s as that one card, picked, and as no radio", async (_label, opts, text, full) => {
    const { el, onChoose, onShield } = choice(opts);
    expect(el.querySelector(".name-points-to").textContent).toBe("alice.dusk points to");
    const cards = el.querySelectorAll(".name-option");
    expect(cards).toHaveLength(1);
    expect(cards[0].classList.contains("is-checked")).toBe(true);
    expect(visibleText(cards[0])).toBe(text);
    expect(screenReaderText(cards[0])).toContain(full);

    // Nothing to choose: no radio mark, and the card's text takes the mark's column.
    expect(cards[0].querySelector(".name-option__dot")).toBeNull();
    expect(cards[0].classList.contains("name-option--single")).toBe(true);
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");
    expect(css).toMatch(/\.name-option--single \.name-option__main \{\s*grid-template-columns: minmax\(0, 1fr\);\s*\}/);
    expect(css).toMatch(/\.name-option--single \.name-option__line \{\s*grid-column: 1;\s*\}/);
    expect(css).toMatch(/\.name-option--single \.name-shortfall \{\s*padding-left: 12px;\s*\}/);

    // Nor a radio group, or anything to focus or pick.
    expect(el.querySelector("[role]")).toBeNull();
    expect(el.querySelector("[aria-checked], [tabindex]")).toBeNull();
    cards[0].querySelector(".name-option__main").click();
    expect(onChoose).not.toHaveBeenCalled();
    el.querySelector(".name-shortfall button")?.click();
    expect(onShield).toHaveBeenCalledTimes(opts.shieldedDisabled ? 1 : 0);
  });
});

describe("shielded shortfall", () => {
  it("says the shielded balance is short and opens Shield", () => {
    const onShield = vi.fn();
    const el = shieldedShortfallEl({ onShield });
    expect(el.textContent).toBe("Not enough shielded DUSK · Shield first");
    expect(el.querySelector("button").textContent).toBe("Shield first");
    el.querySelector("button").click();
    expect(onShield).toHaveBeenCalledTimes(1);
  });
});
