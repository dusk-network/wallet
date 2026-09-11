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

  it("renders sign_typed_data via the shared flattener, not JSON.stringify of the message", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src", "ui", "notification", "app.js"), "utf8");
    const block = source.match(/if \(kindNorm === "sign_typed_data"\) \{([\s\S]*?)\n  if \(kindNorm === "watch_asset"\)/);

    expect(block?.[1]).toBeTruthy();
    const body = block[1];

    // Must flatten via the shared display module rather than dumping raw JSON.
    expect(source).toContain('import { flattenTypedMessage } from "../../shared/typedDataDisplay.js"');
    expect(body).toContain("flattenTypedMessage(");
    expect(body).not.toContain("JSON.stringify(params?.message");
    expect(body).not.toContain("JSON.stringify(message");

    // Required fields from the spec'd render order.
    expect(body).toContain("Approve typed data signature");
    expect(body).toContain("Domain name");
    expect(body).toContain("Domain version");
    expect(body).toContain("Chain ID");
    expect(body).toContain("Verifying contract");
    expect(body).toContain("Primary type");
    expect(body).toContain("Message fields");
    expect(body).toContain("digestHex");
    expect(body).toContain('decisionButtons("Sign")');

    // Verifying contract row is conditional on presence.
    expect(body).toContain("verifyingContract\n");

    // A text-safety flag on any row must surface a warning to the user.
    expect(body).toContain("hasTextSafetyWarning");
    expect(body).toContain("row.flags");
  });
});
