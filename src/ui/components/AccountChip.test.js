import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installFakeDom, screenReaderText, settle, visibleText } from "../testing/fakeDom.js";
import { accountChipEl } from "./AccountChip.js";

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";

let dom;

beforeEach(() => {
  dom = installFakeDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const parts = (chip) => chip.children.map((child) => child.className);
const line = (chip) => chip.querySelector(".chip-text");

describe("account chip", () => {
  it("shows the short account on one line, then a ▾", () => {
    const chip = accountChipEl(ACCOUNT);
    expect(parts(chip)).toEqual(["identicon", "chip-text", "chip-chev"]);
    expect(visibleText(line(chip))).toBe("26FCH7…Tck927");
    // The account gives way before its "…" and keeps its last six characters;
    // screen readers get all of it.
    expect(line(chip).children.map((part) => [part.className, part.textContent])).toEqual([
      ["chip-text__head", "26FCH7…"],
      ["chip-text__tail", "Tck927"],
      ["sr-only", ACCOUNT],
    ]);
    expect(screenReaderText(line(chip))).toBe(ACCOUNT);
    expect(chip.querySelector(".chip-chev").textContent).toBe("▾");
    expect(chip.querySelector(".chip-chev").getAttribute("aria-hidden")).toBe("true");
    expect(chip.title).toBe(ACCOUNT);
  });

  it("shows the verified name in place of the short account, with both in the tooltip", async () => {
    const chip = accountChipEl(ACCOUNT, { name: Promise.resolve("a-rather-long-name.dusk") });
    await settle();
    expect(parts(chip)).toEqual(["identicon", "chip-text", "chip-chev"]);
    expect(line(chip).textContent).toBe("a-rather-long-name.dusk");
    // One part, which ends in "…" when it has to shrink.
    expect(line(chip).children.map((part) => part.className)).toEqual(["chip-text__head"]);
    expect(chip.title).toBe(`a-rather-long-name.dusk\n${ACCOUNT}`);
  });

  it("keeps the short account when there is no name", async () => {
    const chip = accountChipEl(ACCOUNT, { name: Promise.resolve(null) });
    await settle();
    expect(visibleText(line(chip))).toBe("26FCH7…Tck927");
    expect(chip.title).toBe(ACCOUNT);
  });

  it("opens through onClick and no longer copies the account", () => {
    const onClick = vi.fn();
    const chip = accountChipEl(ACCOUNT, { onClick });
    expect(chip.getAttribute("aria-haspopup")).toBe("menu");
    expect(chip.getAttribute("aria-expanded")).toBe("false");

    chip.click();
    expect(onClick).toHaveBeenCalledWith(chip);
    expect(dom.clipboard.writeText).not.toHaveBeenCalled();
    expect(accountChipEl(ACCOUNT, { expanded: true }).getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the dApp connection mark on the identicon and in the tooltip", async () => {
    const chip = accountChipEl(ACCOUNT, {
      host: "app.example",
      connected: true,
      name: Promise.resolve("alice.dusk"),
    });
    await settle();
    expect(chip.querySelector(".identicon").classList.contains("identicon--badged")).toBe(true);
    expect(chip.querySelector(".identicon-badge--on")).not.toBeNull();
    expect(chip.title).toBe(`alice.dusk\n${ACCOUNT}\nConnected: app.example`);

    const site = accountChipEl(ACCOUNT, { host: "app.example", connected: false });
    expect(site.querySelector(".identicon-badge--off")).not.toBeNull();
    expect(site.title).toBe(`${ACCOUNT}\nSite: app.example`);
  });
});
