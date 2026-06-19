import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("address book contact detail view", () => {
  it("opens manage-mode contacts into detail with full address, actions, and filtered activity", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "addressbook.js"),
      "utf8"
    );
    const stateSource = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "state.js"),
      "utf8"
    );
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");

    expect(stateSource).toContain('view: "list", // "list" | "detail" | "edit"');
    expect(source).toContain("const renderDetail = () =>");
    expect(source).toContain('ab.view = "detail"');
    expect(source).toContain("contactTxs(ov?.txs, addr)");
    expect(source).toContain("explorerAccountUrl(nodeUrl, addr)");
    expect(source).toContain('text: "History ↗"');
    expect(source).toContain('text: "Edit"');
    expect(source).toContain('text: "Send"');
    expect(source).toContain('state.txDetailFrom = "contacts"');
    expect(source).toContain("No local wallet activity for this contact.");
    expect(source).toContain("contact-address-line");
    expect(source).toContain("contact-detect-pill");
    expect(source).not.toContain("await startEdit(entry);");
    expect(css).toContain(".contact-detail-address code");
    expect(css).toContain(".contact-detect-pill");
    expect(css).toContain("align-self: flex-start");
    expect(css).toContain("overflow-wrap: anywhere");
  });
});
