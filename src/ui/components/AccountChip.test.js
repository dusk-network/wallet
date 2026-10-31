import { readFile } from "node:fs/promises";
import path from "node:path";
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
  it("shows the profile's label on one line, then a ▾, with the account only in the tooltip", () => {
    const chip = accountChipEl(ACCOUNT, { label: "Profile 2" });
    expect(parts(chip)).toEqual(["identicon", "chip-text", "chip-chev"]);
    // One piece of text, no address in it, for screen readers either.
    expect([line(chip).textContent, line(chip).children.length]).toEqual(["Profile 2", 0]);
    expect(screenReaderText(chip)).not.toContain(ACCOUNT.slice(0, 6));
    expect(chip.querySelector(".chip-chev").textContent).toBe("▾");
    expect(chip.querySelector(".chip-chev").getAttribute("aria-hidden")).toBe("true");
    expect(chip.title).toBe(`Profile 2\n${ACCOUNT}`);

    // A label set on this device, as it was typed.
    expect(visibleText(line(accountChipEl(ACCOUNT, { label: "Savings for the trip" })))).toBe("Savings for the trip");
  });

  it("shows the verified name in place of the label, with the name and account in the tooltip", async () => {
    const chip = accountChipEl(ACCOUNT, { label: "Profile 1", name: Promise.resolve("verylongname-shop.dusk") });
    await settle();
    expect(parts(chip)).toEqual(["identicon", "chip-text", "chip-chev"]);
    expect([line(chip).textContent, line(chip).children.length]).toEqual(["verylongname-shop.dusk", 0]);
    expect(chip.title).toBe(`verylongname-shop.dusk\n${ACCOUNT}`);
  });

  it("puts a wallet's name under the profile's, smaller, each line cut short on its own, and reads both", async () => {
    const chip = accountChipEl(ACCOUNT, { label: "Profile 1", wallet: "Wallet 2", name: Promise.resolve("alice.dusk") });
    await settle();
    expect(parts(chip)).toEqual(["identicon", "chip-lines", "chip-chev"]);
    expect(chip.querySelector(".chip-lines").children.map((child) => child.className)).toEqual(["chip-text", "sr-only", "chip-wallet"]);
    expect([visibleText(line(chip)), visibleText(chip.querySelector(".chip-wallet"))]).toEqual(["alice.dusk", "Wallet 2"]);
    expect(screenReaderText(chip)).toBe("alice.dusk, Wallet 2");
    expect(chip.title).toBe(`alice.dusk\nWallet 2\n${ACCOUNT}`);
    expect(chip.classList.contains("account-chip--wallet")).toBe(true);

    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");
    const rule = (selector) => css.split("\n}").find((block) => `\n${block}`.includes(`\n${selector} {`)) ?? "";
    for (const declaration of ["display: block;", "min-width: 0;", "overflow: hidden;", "text-overflow: ellipsis;", "white-space: nowrap;", "color: var(--text-muted);"]) {
      expect(rule(".account-chip .chip-wallet")).toContain(declaration);
    }
    // Two lines take a few pixels more than the chip's one.
    expect(rule("body.page--popup .account-chip.account-chip--wallet")).toContain("height: 38px;");
  });

  it("keeps the label when there is no name", async () => {
    const chip = accountChipEl(ACCOUNT, { label: "Profile 2", name: Promise.resolve(null) });
    await settle();
    expect(visibleText(line(chip))).toBe("Profile 2");
    expect(chip.title).toBe(`Profile 2\n${ACCOUNT}`);
  });

  it("ends a long name or label in one ellipsis when the chip has to shrink", async () => {
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");
    const rule = css.split("\n}").find((block) => `\n${block}`.includes("\n.account-chip .chip-text {")) ?? "";
    for (const declaration of ["display: block;", "min-width: 0;", "overflow: hidden;", "text-overflow: ellipsis;", "white-space: nowrap;"]) {
      expect(rule).toContain(declaration);
    }
    // Nothing else on the line cuts it, so there is no second "…".
    expect(css).not.toContain("chip-text__");
  });

  it("opens through onClick and no longer copies the account", () => {
    const onClick = vi.fn();
    const chip = accountChipEl(ACCOUNT, { onClick, label: "Profile 1" });
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
      label: "Profile 1",
      name: Promise.resolve("alice.dusk"),
    });
    await settle();
    expect(chip.querySelector(".identicon").classList.contains("identicon--badged")).toBe(true);
    expect(chip.querySelector(".identicon-badge--on")).not.toBeNull();
    expect(chip.title).toBe(`alice.dusk\n${ACCOUNT}\nConnected: app.example`);

    const site = accountChipEl(ACCOUNT, { host: "app.example", connected: false, label: "Profile 1" });
    expect(site.querySelector(".identicon-badge--off")).not.toBeNull();
    expect(site.title).toBe(`Profile 1\n${ACCOUNT}\nSite: app.example`);
  });
});
