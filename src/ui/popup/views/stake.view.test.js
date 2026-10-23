import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The fake DOM goes before the views: it defines HTMLElement for the gas editor.
import { installFakeDom, isShown, settle } from "../../testing/fakeDom.js";
import { stakeConfirmView, stakeFormView } from "./stake.js";

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
    // One line says which balance pays the amount and the gas.
    expect(source).toContain('h("span", { text: "Paid from" })');
    expect(source).not.toContain("Funding uses the stake profile's public balance.");
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
    // Review's amount line says it, with no line under it to repeat it.
    expect(source).toContain('if (!d.amountLux) return "All stake";');
    expect(source).toContain('if (!d.amountLux) return "All rewards";');
    for (const repeat of ["Max includes the estimated fee.", "Unstake the full position.", "Claim all rewards."]) {
      expect(source).not.toContain(repeat);
    }
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

describe("staking text", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ACCOUNT =
    "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
  const actions = () => ({ send: vi.fn(async () => ({})), render: vi.fn(async () => {}), showToast: vi.fn() });

  it("says once which balance pays a new stake and what Max leaves after the fee", () => {
    const { document } = installFakeDom();
    // Profile 1 has 1482.9383 DUSK public and no stake yet; the fee cap is 0.05 DUSK.
    const state = {
      route: "stake",
      staking: {
        loaded: true,
        loading: false,
        profileIndex: 0,
        minimumStakeLux: "1000000000000",
        actionKind: "topup",
        stakeAmountDusk: "",
        ownerProfileIndex: 0,
        ownerStatus: {
          profileIndex: 0,
          account: ACCOUNT,
          publicBalance: { value: "1482938300000" },
          hasStake: false,
          info: { amount: null, reward: "0", faults: 0, hardFaults: 0 },
          ownerKind: "none",
          ownerProfileIndex: 0,
          manageable: true,
          profiles: [{ profileIndex: 0 }, { profileIndex: 1 }],
          relatedStakes: [],
        },
      },
    };
    document.body.replaceChildren(...stakeFormView({ selectedAccountIndex: 0 }, { state, actions: actions() }));
    const editor = document.body.querySelector(".stake-editor");

    // The position card above names the account; the editor doesn't again.
    expect(editor.querySelector(".stake-editor__head > div").textContent).toBe("Manage position");
    expect(editor.querySelector(".stake-gas-line").textContent).toBe("Paid fromProfile 1 public balance");
    expect(editor.querySelectorAll(".stake-editor > .muted").map((line) => line.textContent)).toEqual([
      "Change the owner only for a separated-owner setup.",
      "Max after the fee: 1482.8883 DUSK.",
    ]);
    expect(editor.querySelector(".err")).toBeNull();
    expect(editor.querySelector("#stake-action-amount").getAttribute("placeholder")).toBe("DUSK");
  });

  it("reviews an unstake of the whole position without repeating it under the amount", async () => {
    const { document } = installFakeDom();
    const state = {
      route: "stake_confirm",
      stakeDraft: {
        kind: "unstake",
        stakeProfileIndex: 1,
        profileIndex: 1,
        ownerProfileIndex: 0,
        amountLux: null,
        amountMode: "all",
        payment: "account",
        stakeProfileLabel: "Profile 2",
        ownerProfileLabel: "Profile 1",
        fundingLabel: "Profile 2 public balance",
        gas: null,
      },
    };
    document.body.replaceChildren(...stakeConfirmView({ selectedAccountIndex: 1 }, { state, actions: actions() }));
    await settle();
    expect(document.body.querySelector(".tx-summary").children.map((line) => line.textContent)).toEqual([
      "Unstake",
      "All stake",
      "Stake account: Profile 2",
      "Owner: Profile 1",
      "Gas: Profile 2 public balance",
    ]);
    expect(document.body.querySelectorAll("button").filter(isShown).map((b) => b.textContent)).toEqual([
      "← Back",
      "Edit",
      "Confirm",
    ]);
  });
});
