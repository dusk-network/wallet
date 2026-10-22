import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("send view", () => {
  it("keeps the amount input visually separate from the slider helper", async () => {
    const component = await readFile(
      path.resolve(process.cwd(), "src", "ui", "components", "AmountSliderCard.js"),
      "utf8"
    );
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");

    expect(component).toContain('class: "input-row amount-input-row"');
    expect(component).toContain('class: "amount-range-wrap amount-slider-helper"');
    expect(css).toContain(".amount-input-row");
    expect(css).toContain(".amount-card .amount-range-wrap");
    expect(css).not.toMatch(
      /\.amount-card \.amount-input\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/s
    );
  });

  it("passes explicit privacy for wallet-initiated transfers", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "send.js"),
      "utf8"
    );

    const draftBlock = source.match(/state\.draft = \{([\s\S]*?)state\.route = "confirm"/);
    expect(draftBlock?.[1]).toContain("privacy,");

    const sendBlock = source.match(/type: "DUSK_UI_SEND_TX"([\s\S]*?)memo: d\.memo/);
    expect(sendBlock?.[1]).toContain("privacy:");
    expect(sendBlock?.[1]).toContain('"shielded"');
    expect(sendBlock?.[1]).toContain('"public"');
  });

  it("sends to the address a .dusk name resolves to and shows both on review", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "send.js"),
      "utf8"
    );

    const reviewBlock = source.match(/if \(isDuskName\(toVal\)\) \{([\s\S]*?)state\.route = "confirm"/);
    expect(reviewBlock?.[1]).toContain("if (!applyNameResult(toVal, result)) return;");
    expect(reviewBlock?.[1]).toContain("recipient = nameRecipient(result);");
    expect(reviewBlock?.[1]).toContain("to: recipient,");
    expect(reviewBlock?.[1]).toContain("duskName,");
    // A name's shielded address makes a shielded transfer, with its gas and balance.
    expect(reviewBlock?.[1]).toContain('const privacy = recType === "address" ? "shielded" : "public";');
    expect(source).toContain('privacy: d.privacy || (recType === "address" ? "shielded" : "public")');

    expect(source).toContain("nextBtn.disabled = !usable;");
    expect(source).toContain("detectedRecipientType = usable ? t : null;");
    expect(source).toContain('d.duskName ? h("div", { text: d.duskName.name }) : null');
    expect(source).toContain('d.duskName.nodeUrl !== String(ov?.nodeUrl ?? "")');
    expect(source).toMatch(/type: "DUSK_UI_SEND_TX"[\s\S]*?to: d\.to,/);
  });

  it("lets a name with both addresses go to its shielded address instead", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "send.js"),
      "utf8"
    );
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");

    expect(source).toContain("const nameRecipient = (result) => duskNameRecipient(result, { shielded: nameShielded });");
    expect(source).toContain("result.account && result.address ? nameAddressToggle(v, result) : null");
    expect(source).toContain('[option("Public account", false), option("Shielded address", true)]');
    expect(source).toMatch(/onclick: \(\) => \{\s*nameShielded = shielded;\s*syncDraft\(\);\s*applyNameResult\(v, result\);/);
    expect(css).toMatch(/\.tabs\.tabs--mini\.name-address-toggle\s*\{[^}]*margin-top/s);

    // A name typed anew starts on its public account; re-renders and a return from review keep the pick.
    expect(source).toMatch(/to\.addEventListener\("input", \(\) => \{\s*\/\/[^\n]*\n\s*nameShielded = false;/);
    expect(source).toContain("let nameShielded = draft.nameShielded === true;");
    expect(source.match(/^ {2}syncDraft = \(\) => \{([\s\S]*?)^ {2}\};/m)?.[1]).toContain("nameShielded,");
    expect(source.match(/state\.draft = \{\s*to: recipient,([\s\S]*?)\};/)?.[1]).toContain("nameShielded,");
  });

  it("uses shared recipient badges for send contact and privacy indicators", async () => {
    const sendView = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "send.js"),
      "utf8"
    );
    const badgeComponent = await readFile(
      path.resolve(process.cwd(), "src", "ui", "components", "RecipientBadge.js"),
      "utf8"
    );
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");

    expect(sendView).toContain("RecipientBadge.js");
    expect(sendView).toContain("recipientTypeBadgeOptions");
    expect(sendView).toContain('kind: "contact"');
    expect(sendView).toContain('className: "to-chip"');

    expect(badgeComponent).toContain("recipientBadge");
    expect(badgeComponent).toContain('label: "Public"');
    expect(badgeComponent).toContain('label: "Shielded"');
    expect(badgeComponent).toContain('icon: "public"');
    expect(badgeComponent).toContain('icon: "shielded"');
    expect(badgeComponent).not.toContain('icon: "P"');
    expect(badgeComponent).not.toContain('icon: "S"');

    expect(css).toContain(".recipient-badge--contact");
    expect(css).toMatch(/\.recipient-badge--contact\s*\{[^}]*var\(--ok\)/s);
    expect(css).toContain(".recipient-badge--rail");
    expect(css).toMatch(/\.recipient-badge--rail\s*\{[^}]*var\(--primary\)/s);
    expect(css).toContain(".recipient-badge__glyph--svg svg");
  });
});
