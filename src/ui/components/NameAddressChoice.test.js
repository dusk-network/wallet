import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installFakeDom, press } from "../testing/fakeDom.js";
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
    publicBalance: "177.9865",
    shieldedBalance: "25",
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
    const group = el.querySelector("[role=radiogroup]");
    expect(group.getAttribute("aria-labelledby")).toBe(head.id);
    expect(head.id).not.toBe("");

    expect(publicRadio.querySelector(".name-option__label").textContent).toBe("Public account");
    expect(publicRadio.querySelector(".name-option__addr").textContent).toBe("21n5nc…fMMLNz");
    expect(publicRadio.querySelector(".name-option__addr").title).toBe(ACCOUNT);
    expect(publicRadio.querySelector(".name-option__line").textContent).toBe(
      "From your public balance (177.9865 DUSK). Amount and both accounts are visible on chain."
    );
    expect(publicRadio.querySelector(".name-option__line strong").textContent).toBe("public balance");

    expect(shieldedRadio.querySelector(".name-option__label").textContent).toBe("Shielded address");
    expect(shieldedRadio.querySelector(".name-option__addr").textContent).toBe("4QpZhL…i743QE");
    expect(shieldedRadio.querySelector(".name-option__line").textContent).toBe(
      "From your shielded balance (25 DUSK). Amount and both parties stay private."
    );
    expect(el.querySelector(".name-shortfall")).toBeNull();
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
    const { el, onChoose, onShield, publicRadio, shieldedRadio } = choice({
      shieldedBalance: "0",
      shieldedDisabled: true,
    });
    expect(shieldedRadio.getAttribute("aria-disabled")).toBe("true");
    expect(publicRadio.hasAttribute("aria-disabled")).toBe(false);
    expect(shieldedRadio.parentNode.classList.contains("is-disabled")).toBe(true);
    expect(shieldedRadio.querySelector(".name-option__line").textContent).toContain("(0 DUSK)");

    shieldedRadio.click();
    press(shieldedRadio, " ");
    publicRadio.focus();
    press(publicRadio, "ArrowDown");
    expect(onChoose).not.toHaveBeenCalled();
    expect(dom.document.activeElement).toBe(publicRadio);

    // The hint sits in the shielded card, beside its radio rather than in it.
    const hint = el.querySelector(".name-shortfall");
    expect(hint.parentNode).toBe(shieldedRadio.parentNode);
    expect(hint.textContent).toBe("Not enough shielded DUSK. Shield DUSK first");
    hint.querySelector("button").click();
    expect(onShield).toHaveBeenCalledTimes(1);
  });

  it("can show a picked shielded address that the balance no longer pays", () => {
    const { publicRadio, shieldedRadio } = choice({ shielded: true, shieldedDisabled: true });
    expect([checked(publicRadio), checked(shieldedRadio)]).toEqual(["false", "true"]);
  });
});

describe("shielded shortfall", () => {
  it("says the shielded balance is short and opens Shield", () => {
    const onShield = vi.fn();
    const el = shieldedShortfallEl({ onShield });
    expect(el.textContent).toBe("Not enough shielded DUSK. Shield DUSK first");
    el.querySelector("button").click();
    expect(onShield).toHaveBeenCalledTimes(1);
  });
});
