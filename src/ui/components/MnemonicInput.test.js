import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeEvent, installFakeDom, isShown, typeInto } from "../testing/fakeDom.js";
import { createMnemonicInput } from "./MnemonicInput.js";

// Public BIP39 test phrases only.
const TWELVE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const OTHER = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const TWENTY_FOUR = `${"abandon ".repeat(23)}art`;
// Twelve words from the list whose checksum fails.
const NO_CHECKSUM = "abandon ".repeat(12).trim();

let dom;

beforeEach(() => {
  dom = installFakeDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mount(opts = {}) {
  const onCheck = vi.fn();
  const input = createMnemonicInput({ onCheck, ...opts });
  dom.document.body.replaceChildren(input.el);
  const box = (n) => input.el.querySelectorAll("input").find((i) => i.getAttribute("aria-label") === `Word ${n}`);
  const cell = (n) => box(n).parentNode.parentNode;
  const words = () => input.el.querySelectorAll("input").filter(isShown).map((i) => i.value);
  return { input, onCheck, box, cell, words };
}

const paste = (field, text) => field.dispatchEvent(fakeEvent("paste", { clipboardData: { getData: () => text } }));
// The focus leaving `field` for `to` (null: for nothing on the page).
const leave = (field, to = null) => field.dispatchEvent(fakeEvent("focusout", { relatedTarget: to }));

describe("the recovery phrase's word boxes", () => {
  it("fills every box in order from a whole phrase pasted into any box, and takes its length from it", () => {
    const { box, words } = mount();
    paste(box(5), OTHER);
    expect(words()).toEqual(OTHER.split(" "));

    // 24 words switch to 24 boxes, and 12 back to 12.
    paste(box(3), TWENTY_FOUR);
    expect(words()).toEqual(TWENTY_FOUR.split(" "));
    paste(box(20), TWELVE);
    expect(words()).toEqual(TWELVE.split(" "));
  });

  it("puts a few words where they're pasted, as before", () => {
    const { box, words } = mount();
    paste(box(4), "legal winner thank");
    expect(words()).toEqual(["", "", "", "legal", "winner", "thank", "", "", "", "", "", ""]);
  });

  it("marks a word that isn't a recovery word after a paste, and says which", () => {
    const { box, cell, onCheck } = mount();
    paste(box(1), OTHER.replace("worth", "wurth"));
    expect([cell(7).classList.contains("is-invalid"), box(7).getAttribute("aria-invalid")]).toEqual([true, "true"]);
    expect(cell(6).classList.contains("is-invalid")).toBe(false);
    expect(onCheck).toHaveBeenLastCalledWith("Word 7 isn't a recovery word. Check its spelling.");

    paste(box(1), OTHER.replace("legal", "legl").replace("worth", "wurth"));
    expect(onCheck).toHaveBeenLastCalledWith("Words 1 and 7 aren't recovery words. Check their spelling.");
  });

  it("says plainly when a pasted phrase has the wrong count or its checksum fails, and nothing for a good one", () => {
    const { box, onCheck } = mount();
    paste(box(1), `${OTHER} wave`);
    expect(onCheck).toHaveBeenLastCalledWith("That's 13 words. A recovery phrase has 12 or 24.");
    paste(box(1), `${TWENTY_FOUR} art`);
    expect(onCheck).toHaveBeenLastCalledWith("That's 25 words. A recovery phrase has 12 or 24.");
    paste(box(1), NO_CHECKSUM);
    expect(onCheck).toHaveBeenLastCalledWith("That isn't a valid recovery phrase. Check each word.");
    paste(box(1), OTHER);
    expect(onCheck).toHaveBeenLastCalledWith("");
  });

  it("marks a typed word as its box is left, not while it's typed, and clears the mark once it's a word", () => {
    const { box, cell, onCheck } = mount();
    typeInto(box(1), "aban");
    expect(cell(1).classList.contains("is-invalid")).toBe(false);
    leave(box(1), box(2));
    expect([cell(1).classList.contains("is-invalid"), box(1).getAttribute("aria-invalid")]).toEqual([true, "true"]);
    // Still among the words: nothing said yet.
    expect(onCheck).not.toHaveBeenCalledWith(expect.stringMatching(/\S/));

    typeInto(box(1), "abandon");
    expect([cell(1).classList.contains("is-invalid"), box(1).getAttribute("aria-invalid")]).toEqual([false, null]);
  });

  it("says what's wrong once the focus leaves the words: a missing word, too few, or a checksum", () => {
    const { box, onCheck } = mount();
    const password = dom.document.createElement("input");
    dom.document.body.appendChild(password);

    // Nothing typed: nothing to say.
    leave(box(1), password);
    expect(onCheck).not.toHaveBeenCalledWith(expect.stringMatching(/\S/));

    const words = OTHER.split(" ");
    words.forEach((w, i) => typeInto(box(i + 1), w));
    typeInto(box(5), "");
    leave(box(12), password);
    expect(onCheck).toHaveBeenLastCalledWith("Word 5 is missing.");

    typeInto(box(5), "wave");
    typeInto(box(12), "");
    leave(box(11), password);
    expect(onCheck).toHaveBeenLastCalledWith("That's 11 words. A recovery phrase has 12 or 24.");

    typeInto(box(12), "abandon");
    leave(box(12), null);
    expect(onCheck).toHaveBeenLastCalledWith("That isn't a valid recovery phrase. Check each word.");
    // Typing again takes back what was said.
    typeInto(box(12), "yellow");
    expect(onCheck).toHaveBeenLastCalledWith("");
  });

  it("checks a phrase typed into one box with spaces as it checks a paste", () => {
    const { box, words, onCheck } = mount();
    typeInto(box(9), OTHER.replace("worth", "wurth"));
    expect(words()).toEqual(OTHER.replace("worth", "wurth").split(" "));
    expect(onCheck).toHaveBeenLastCalledWith("Word 7 isn't a recovery word. Check its spelling.");
  });

  it("says the same on asking (problem), for the form's submit", () => {
    const { input, box } = mount();
    expect(input.problem()).toBe("");
    paste(box(1), NO_CHECKSUM);
    expect(input.problem()).toBe("That isn't a valid recovery phrase. Check each word.");
    paste(box(1), OTHER);
    expect([input.problem(), input.getMnemonic()]).toEqual(["", OTHER]);
  });

  it("can show a line above the words that describes them", () => {
    const { input } = mount({ hint: "Paste the whole phrase into any box." });
    const hint = input.el.querySelector(".srp-hint");
    expect(hint.textContent).toBe("Paste the whole phrase into any box.");
    // Above the boxes, under the 12 or 24 choice.
    expect(input.el.children.map((el) => el.className)).toEqual(["tabs tabs--mini srp-toggle", "srp-hint", "box srp-box"]);
    expect(input.el.getAttribute("aria-describedby")).toBe(hint.id);
    expect(mount().input.el.querySelector(".srp-hint")).toBeNull();
  });

  it("gives each box an edge of 3:1 or more against the page and the fields where words are typed (WCAG 1.4.11)", async () => {
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");
    const rule = (selector) => css.split("\n}").find((block) => `\n${block}`.includes(`\n${selector} {`)) ?? "";
    const token = (name) => rule(":root").match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
    const edge = rule(".srp-grid--input .srp-word").match(/border-color:\s*var\((--[\w-]+)\)/)?.[1];
    expect(edge).toBeTruthy();

    const luminance = (hex) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const surface of ["--surface-0", "--surface-1"]) {
      expect(contrast(token(edge), token(surface))).toBeGreaterThanOrEqual(3);
    }
    // The words shown to write down keep no edge.
    expect(rule(".srp-word")).toContain("border: 1px solid transparent;");
  });
});
