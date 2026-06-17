import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("notification approval UI", () => {
  it("keeps the locked approval form retryable after an unlock error", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src", "ui", "notification", "app.js"), "utf8");
    const lockBoxBlock = source.match(/const lockBox = \(\) => \{([\s\S]*?)const decisionButtons =/);

    expect(lockBoxBlock?.[1]).toContain('const errBox = h("div", { class: "err", style: "display:none" })');
    expect(lockBoxBlock?.[1]).toContain('errBox.textContent = res.error.message || "Unlock failed"');
    expect(lockBoxBlock?.[1]).toContain('pwd.value = ""');
    expect(lockBoxBlock?.[1]).toContain("unlockBtn.disabled = false");
    expect(lockBoxBlock?.[1]).toContain("pwd.disabled = false");
    expect(lockBoxBlock?.[1]).not.toContain("renderError(res.error.message");
  });

  it("derives transfer rail labels from declared privacy, not recipient type", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src", "ui", "notification", "app.js"), "utf8");
    const transferBlock = source.match(/if \(txKind === TX_KIND\.TRANSFER\) \{([\s\S]*?)const amountLuxStr = prettyAmount/);

    expect(transferBlock?.[1]).toContain('privacy === "shielded"');
    expect(transferBlock?.[1]).toContain("Shielded (Phoenix)");
    expect(transferBlock?.[1]).toContain("Public (Moonlight)");
    expect(transferBlock?.[1]).not.toContain("ProfileGenerator.typeOf");
  });

  it("sends contract-call decode requests with serializable hex args", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src", "ui", "notification", "app.js"), "utf8");

    expect(source).toContain("argsHex = `0x${bytesToHex(argsBytes)}`");
    expect(source).toContain('type: "DUSK_UI_DRC20_DECODE_INPUT"');
    expect(source).toContain('type: "DUSK_UI_DRC721_DECODE_INPUT"');
    expect(source).toContain("fnArgs: argsHex");
    expect(source).not.toContain("fnArgs: argsBytes");
  });
});
