import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TX_KIND } from "../shared/constants.js";
import { iconSvg } from "./components/ActionIcon.js";
import { accessibleName, installFakeDom, visibleText } from "./testing/fakeDom.js";
import { txDetailsView } from "./popup/views/txDetails.js";

const HASH = "ab".repeat(32);
const NODE = "https://testnet.nodes.dusk.network";
const TO =
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";

let dom;
let actions;

beforeEach(() => {
  vi.useFakeTimers();
  dom = installFakeDom();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// A sent transfer's details, as the popup draws them: Copy beside its ID, in
// words, and beside the address it went to, as an icon.
function details() {
  actions = { render: vi.fn(async () => {}), showToast: vi.fn() };
  const state = { route: "tx", txDetailHash: HASH, txDetailFrom: "home", addressBook: { loaded: true, items: [] } };
  const tx = { hash: HASH, nodeUrl: NODE, kind: TX_KIND.TRANSFER, direction: "out", to: TO, amount: "1000000000", status: "executed" };
  dom.document.body.replaceChildren(...txDetailsView({ nodeUrl: NODE, txs: [tx] }, { state, actions }));
  return (name) => dom.document.body.querySelectorAll("button").find((b) => accessibleName(b) === name);
}

// What the page's polite live regions say to screen readers.
const said = () => dom.document.body.querySelectorAll('[aria-live="polite"]').map((el) => el.textContent).filter(Boolean);

async function press(button) {
  button.click();
  await vi.advanceTimersByTimeAsync(0);
}

describe("Copy", () => {
  it("says Copied on its own button for 1.5 s, heard once, with no toast; a copy that fails says so in a toast", async () => {
    const button = details();
    const copy = button("Copy transaction ID");
    expect(visibleText(copy)).toBe("Copy");

    await press(copy);
    expect(dom.clipboard.writeText).toHaveBeenCalledWith(HASH);
    expect([visibleText(copy), accessibleName(copy), said()]).toEqual(["Copied", "Copied", ["Copied"]]);
    expect(actions.showToast).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1499);
    expect(visibleText(copy)).toBe("Copied");
    await vi.advanceTimersByTimeAsync(1);
    expect([visibleText(copy), accessibleName(copy), said()]).toEqual(["Copy", "Copy transaction ID", []]);

    // Couldn't copy: a toast says so, and the button stays Copy.
    dom.clipboard.writeText.mockRejectedValueOnce(new Error("denied"));
    await press(copy);
    expect(actions.showToast).toHaveBeenCalledWith("Couldn't copy the transaction ID");
    expect([visibleText(copy), accessibleName(copy), said()]).toEqual(["Copy", "Copy transaction ID", []]);
  });

  it("turns only the icon of an icon button into a check, named Copied meanwhile", async () => {
    const copy = details()("Copy address");
    expect(copy.querySelectorAll(".copy-swap > span").map((face) => face.innerHTML)).toEqual([iconSvg("copy"), iconSvg("check")]);

    await press(copy);
    expect(dom.clipboard.writeText).toHaveBeenCalledWith(TO);
    expect([visibleText(copy), accessibleName(copy), copy.hasAttribute("data-copied"), said()]).toEqual(["", "Copied", true, ["Copied"]]);
    expect(actions.showToast).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    expect([accessibleName(copy), copy.hasAttribute("data-copied")]).toEqual(["Copy address", false]);
  });
});
