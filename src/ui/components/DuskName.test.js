import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { accountChipEl } from "./AccountChip.js";
import { duskNameEl } from "./DuskName.js";

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";

// Just enough document for h(): elements keep their attributes, text and children.
function element(tagName) {
  const attributes = new Map();
  return {
    tagName,
    className: "",
    textContent: "",
    title: "",
    children: [],
    setAttribute: (name, value) => attributes.set(name, String(value)),
    get hidden() {
      return attributes.has("hidden");
    },
    set hidden(value) {
      if (value) attributes.set("hidden", "");
      else attributes.delete("hidden");
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener() {},
  };
}

// Lets the promise jobs queued so far run, as they do before the next paint.
const settle = () => new Promise((resolve) => setTimeout(resolve));

beforeEach(() => {
  vi.stubGlobal("document", { createElement: element, createTextNode: (text) => ({ textContent: text }) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("duskNameEl", () => {
  it("stays hidden until the lookup gives a name, then shows it", async () => {
    let answer;
    const el = duskNameEl(new Promise((resolve) => (answer = resolve)), { className: "receive-chip-name" });
    expect(el.className).toBe("dusk-name receive-chip-name");
    expect(el.hidden).toBe(true);
    expect(el.textContent).toBe("");

    answer("domains.dusk");
    await settle();
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe("domains.dusk");
    expect(el.title).toBe("domains.dusk");
  });

  it("shows nothing when there is no name to show", async () => {
    // The lookups give null for no name, a failed lookup and an unsupported network alike.
    const el = duskNameEl(Promise.resolve(null));
    await settle();
    expect(el.hidden).toBe(true);
    expect(el.textContent).toBe("");
  });

  it("fills in a known name within the same turn, before the next paint", async () => {
    const el = duskNameEl(Promise.resolve("domains.dusk"));
    await Promise.resolve();
    expect(el.textContent).toBe("domains.dusk");
  });
});

describe("account chip", () => {
  const texts = (el) => el.children.map((child) => child.className);

  it("shows the account alone without a name lookup", () => {
    const chip = accountChipEl(ACCOUNT);
    expect(texts(chip)).toEqual(["identicon", "chip-text"]);
    expect(chip.children[1].textContent).toBe("26FCH7…k927");
  });

  it("puts the account's name above its short account once the lookup gives one", async () => {
    const chip = accountChipEl(ACCOUNT, { name: Promise.resolve("domains.dusk") });
    const lines = chip.children[1];
    expect(texts(chip)).toEqual(["identicon", "chip-lines"]);
    expect(texts(lines)).toEqual(["dusk-name", "chip-text"]);

    await settle();
    expect(lines.children[0].hidden).toBe(false);
    expect(lines.children[0].textContent).toBe("domains.dusk");
    expect(lines.children[1].textContent).toBe("26FCH7…k927");
  });
});

describe("own .dusk names in the popup", () => {
  it("shows each profile's verified name where its account shows", async () => {
    const read = (...parts) => readFile(path.resolve(process.cwd(), ...parts), "utf8");
    const header = await read("src", "ui", "popup", "header.js");
    const menu = await read("src", "ui", "components", "AccountMenu.js");
    const receive = await read("src", "ui", "popup", "views", "receive.js");
    const css = await read("public", "ui.css");

    expect(header).toContain("name: lookupPrimaryName(account, { nodeUrl: ov?.nodeUrl }),");
    expect(menu).toContain("acct ? duskNameEl(lookupPrimaryName(String(acct), { nodeUrl: ov?.nodeUrl })) : null,");
    // The public account's name; beside the shielded address only when the name pays to it.
    expect(receive).toMatch(
      /tab === "public"\s*\? lookupPrimaryName\(account, \{ nodeUrl: ov\?\.nodeUrl \}\)\s*: lookupShieldedName\(account, address, \{ nodeUrl: ov\?\.nodeUrl \}\)/
    );
    expect(receive).toContain("[chipKind, chipName, chipText]");

    // Name first, the address after it muted; no colour of its own.
    expect(css).toMatch(/\.dusk-name\s*\{[^}]*color: var\(--foreground\)/s);
    expect(css).toMatch(/\.account-chip \.dusk-name:not\(\[hidden\]\) \+ \.chip-text\s*\{[^}]*var\(--muted-foreground\)/s);
    expect(css).toMatch(/\.receive-chip-name:not\(\[hidden\]\) \+ \.receive-chip-text\s*\{[^}]*var\(--muted-foreground\)/s);
  });
});
