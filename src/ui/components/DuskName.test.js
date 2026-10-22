import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installFakeDom, settle } from "../testing/fakeDom.js";
import { duskNameEl } from "./DuskName.js";

beforeEach(() => {
  installFakeDom();
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

    // Name first, the address after it muted; no colour of its own. The header
    // chip has one line, the name or the short account.
    expect(css).toMatch(/\.dusk-name\s*\{[^}]*color: var\(--foreground\)/s);
    expect(css).not.toContain(".chip-lines");
    expect(css).toMatch(/\.receive-chip-name:not\(\[hidden\]\) \+ \.receive-chip-text\s*\{[^}]*var\(--muted-foreground\)/s);
  });
});
