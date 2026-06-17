import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("connected site status", () => {
  it("renders an explicit active-site bar with connect and disconnect actions", async () => {
    const appSource = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "app.js"),
      "utf8"
    );
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");

    expect(appSource).toContain("function activeSiteBar");
    expect(appSource).toContain('class: "site-bar"');
    expect(appSource).toContain("DUSK_UI_CONNECT_ORIGIN");
    expect(appSource).toContain("DUSK_UI_DISCONNECT_ORIGIN");
    expect(css).toContain(".site-bar");
    expect(css).toContain(".site-bar-action");
  });

  it("exposes UI messages for connecting and disconnecting the active origin", async () => {
    const background = await readFile(
      path.resolve(process.cwd(), "src", "background", "index.js"),
      "utf8"
    );

    expect(background).toContain('message?.type === "DUSK_UI_CONNECT_ORIGIN"');
    expect(background).toContain('message?.type === "DUSK_UI_DISCONNECT_ORIGIN"');
    expect(background).toContain("approveOrigin(origin");
    expect(background).toContain("revokeOrigin(origin)");
  });
});
