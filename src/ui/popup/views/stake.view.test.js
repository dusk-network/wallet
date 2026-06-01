import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("stake view", () => {
  it("submits staking actions with explicit stake and owner profiles", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "stake.js"),
      "utf8"
    );

    const confirmBlock = source.match(/const params = \{([\s\S]*?)\};\s*\n\s*const res = await actions\?\.send/);

    expect(confirmBlock?.[1]).toContain("profileIndex: d.stakeProfileIndex ?? d.profileIndex");
    expect(confirmBlock?.[1]).toContain("ownerProfileIndex: d.ownerProfileIndex");
    expect(confirmBlock?.[1]).toContain("payment: d.payment || FUNDING_PUBLIC");
  });

  it("keeps position UX explicit about gas payer and unsupported owner-funded gas", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "stake.js"),
      "utf8"
    );

    expect(source).toContain("Stake positions");
    expect(source).toContain("Gas");
    expect(source).toContain("Owner-paid gas is not available here.");
    expect(source).toContain("Gas still comes from");
    expect(source).toContain("Contract-owned stake. View only.");
  });

  it("supports all/max action modes in the draft", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "stake.js"),
      "utf8"
    );

    expect(source).toContain('st.amountMode = "max"');
    expect(source).toContain('makeDraft(null, "all")');
    expect(source).toContain("Max leaves room for the estimated fee.");
    expect(source).toContain("Unstake the full position.");
    expect(source).toContain("Claim all rewards.");
  });

  it("reads custom staking amounts from current state at review time", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "stake.js"),
      "utf8"
    );

    expect(source).toContain("const currentAmountValue = () =>");
    expect(source).toContain("const raw = String(currentAmountValue() ?? \"\").trim();");
    expect(source).toContain("const currentState = actionState(pos, actionKind, null, minLux);");
  });
});
