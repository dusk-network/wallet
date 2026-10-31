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
    const el = duskNameEl(new Promise((resolve) => (answer = resolve)), { className: "receive-field__name" });
    expect(el.className).toBe("dusk-name receive-field__name");
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
    const receive = await read("src", "ui", "popup", "views", "receive.js");
    const css = await read("public", "ui.css");
    // The declarations of the top-level rule for exactly `selector`.
    const rule = (selector) => css.split("\n}").find((block) => `\n${block}`.includes(`\n${selector} {`)) ?? "";

    expect(header).toContain("name: lookupPrimaryName(account, { nodeUrl: ov?.nodeUrl, stale: true }),");
    // The public account's name; beside the shielded address only when the name pays to it.
    expect(receive).toMatch(
      /tab === "public"\s*\? lookupPrimaryName\(account, \{ nodeUrl: ov\?\.nodeUrl \}\)\s*: lookupShieldedName\(account, address, \{ nodeUrl: ov\?\.nodeUrl \}\)/
    );

    // The name leads at full contrast, with no colour of its own; the address
    // after it is smaller and muted, on Receive one line ending in "…". The
    // header chip's line is the name, never the account; with more than one
    // wallet, the wallet's name goes under it, smaller and muted.
    expect(rule(".dusk-name")).toContain("color: var(--foreground);");
    expect(rule(".account-chip .chip-wallet")).toContain("color: var(--text-muted);");
    expect(rule(".receive-field__name")).toContain("font-size: 14px;");
    const oneMutedLine = ["font-size: 12px;", "color: var(--muted-foreground);", "white-space: nowrap;", "text-overflow: ellipsis;"];
    for (const decl of oneMutedLine) expect(rule(".receive-field__address")).toContain(decl);
    // A hidden field is hidden, as every hidden element is.
    expect(rule("[hidden]")).toContain("display: none !important;");
    expect(rule(".named-address .dusk-name")).toContain("font-size: 14px;");
    expect(rule(".named-address code")).toContain("color: var(--muted-foreground);");
  });
});
