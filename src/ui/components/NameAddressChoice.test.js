import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installFakeDom, press } from "../testing/fakeDom.js";
import { nameAddressChoice } from "./NameAddressChoice.js";

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
  it("starts on the public account", () => {
    const { publicRadio, shieldedRadio } = choice();
    expect([checked(publicRadio), checked(shieldedRadio)]).toEqual(["true", "false"]);
  });

  it("disables the shielded address when the shielded balance can't pay, and links to Shield", () => {
    const { el, onChoose, onShield, publicRadio, shieldedRadio } = choice({ shieldedDisabled: true });
    expect(shieldedRadio.getAttribute("aria-disabled")).toBe("true");
    expect(publicRadio.hasAttribute("aria-disabled")).toBe(false);

    // Neither a click nor a key picks it.
    shieldedRadio.click();
    press(shieldedRadio, " ");
    publicRadio.focus();
    press(publicRadio, "ArrowDown");
    expect(onChoose).not.toHaveBeenCalled();

    el.querySelector(".name-shortfall button").click();
    expect(onShield).toHaveBeenCalledTimes(1);
  });

  it("can show a picked shielded address that the balance no longer pays", () => {
    const { publicRadio, shieldedRadio } = choice({ shielded: true, shieldedDisabled: true });
    expect([checked(publicRadio), checked(shieldedRadio)]).toEqual(["false", "true"]);
  });
});
