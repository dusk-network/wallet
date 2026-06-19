import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("home dashboard action icons", () => {
  it("uses crisp SVG glyphs for the primary wallet actions", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "home.js"),
      "utf8"
    );

    const iconSource = await readFile(
      path.resolve(process.cwd(), "src", "ui", "components", "ActionIcon.js"),
      "utf8"
    );

    expect(source).toContain('import { actionIcon } from "../../components/ActionIcon.js";');
    expect(iconSource).toContain('send: [');
    expect(iconSource).toContain('receive: [');
    expect(iconSource).toContain('shield: [');
    expect(iconSource).toContain('stake: [');
    expect(source).toContain('actionBtn("Send", "send"');
    expect(source).toContain('actionBtn("Receive", "receive"');
    expect(source).toContain('actionBtn("Shield", "shield"');
    expect(source).toContain('actionBtn("Stake", "stake"');
    expect(source).not.toContain('actionBtn("Send", "↑"');
    expect(source).not.toContain('actionBtn("Receive", "↓"');
    expect(source).not.toContain('actionBtn("Shield", "✦"');
    expect(source).not.toContain('actionBtn("Stake", "△"');
  });

  it("uses dashboard-style SVG glyphs for onboarding setup actions", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "onboarding.js"),
      "utf8"
    );
    const iconSource = await readFile(
      path.resolve(process.cwd(), "src", "ui", "components", "ActionIcon.js"),
      "utf8"
    );

    expect(source).toContain('actionIcon("create", { className: "action-icon" })');
    expect(source).toContain('actionIcon("import", { className: "action-icon" })');
    expect(source).not.toContain('class: "action-icon", text: "+"');
    expect(source).not.toContain("Testing? Create a wallet");
    expect(iconSource).toContain('create: [');
    expect(iconSource).toContain('import: [');
    expect(iconSource).toContain('<circle cx="12" cy="12" r="7.5"/>');
    expect(iconSource).toContain('<path d="M4 13v4.5A2.5 2.5 0 0 0 6.5 20h11A2.5 2.5 0 0 0 20 17.5V13"/>');
  });

  it("keeps recent activity on the dashboard without a History tab", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "home.js"),
      "utf8"
    );

    expect(source).toContain("Recent activity");
    expect(source).toContain("View all");
    expect(source).toContain("History ↗");
    expect(source).toContain("explorerAccountUrl");
    expect(source).toContain('state.route = "activity"');
    expect(source).toContain("txs.slice(0, 5)");
    expect(source).toContain("activity-head-actions");
    expect(source).toContain("activity-card-footer");
    expect(source).toContain("activityList(txs");
    expect(source).toContain("listAddressBook()");
    expect(source).toContain("contactForTx(tx)");
    expect(source).toContain("activity-contact-badge");
    expect(source).not.toContain("Cached activity");
    expect(source).not.toContain('h("span", { text: "Activity" })');
    expect(source).not.toContain('class: "tabs"');
    expect(source).not.toContain("switchTab");
  });
});
