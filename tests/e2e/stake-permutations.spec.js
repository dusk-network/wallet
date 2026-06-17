import { expect, test } from "@playwright/test";

const LUX = 1_000_000_000n;
const dusk = (n) => (BigInt(n) * LUX).toString();

const profiles = [
  {
    profileIndex: 0,
    account: "owner_profile_1_account_abcdefghijklmnopqrstuvwxyz",
    publicBalance: { value: dusk(5000) },
  },
  {
    profileIndex: 1,
    account: "stake_profile_2_account_abcdefghijklmnopqrstuvwxyz",
    publicBalance: { value: dusk(500) },
  },
  {
    profileIndex: 2,
    account: "profile_3_account_abcdefghijklmnopqrstuvwxyz",
    publicBalance: { value: dusk(500) },
  },
];

const stakeInfo = {
  amount: {
    value: dusk(100000),
    locked: dusk(10),
    eligibility: "0",
    total: dusk(100000),
  },
  reward: dusk(42),
  faults: 0,
  hardFaults: 0,
};

function ownerStatusFor(kind) {
  const selected = {
    profileIndex: 0,
    account: profiles[0].account,
    publicBalance: profiles[0].publicBalance,
    hasStake: false,
    info: { amount: null, reward: "0", faults: 0, hardFaults: 0 },
    ownerKind: "none",
    ownerProfileIndex: 0,
    manageable: true,
    profiles,
    relatedStakes: [],
  };

  if (kind === "create-self") return selected;

  const related = {
    profileIndex: 1,
    account: profiles[1].account,
    publicBalance: kind === "local-no-gas" ? { value: "0" } : profiles[1].publicBalance,
    hasStake: true,
    info: stakeInfo,
    keys: { account: profiles[1].account, owner: profiles[0].account },
    ownerKind: kind === "missing" ? "missing" : kind === "contract" ? "contract" : "local",
    ownerProfileIndex: kind === "missing" || kind === "contract" ? null : 0,
    ownerAccount: kind === "contract" ? null : profiles[0].account,
    ownerContract: kind === "contract" ? "contract_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" : null,
    manageable: !(kind === "missing" || kind === "contract"),
    reason:
      kind === "missing"
        ? "Owner key not found in this wallet."
        : kind === "contract"
          ? "Contract-owned stake. View only."
          : "",
  };

  return { ...selected, relatedStakes: [related] };
}

async function installStakeHarness(page, scenario) {
  await page.goto("/");

  await page.evaluate(
    async ({ minimumStakeLux, scenario }) => {
      const mod = await import("/src/ui/popup/views/stake.js");
      const root = document.createElement("main");
      root.id = "stake-harness";
      document.body.innerHTML = "";
      document.body.append(root);

      window.__stakeMessages = [];
      window.__stakeToasts = [];
      window.__stakeState = {
        route: "stake",
        stakeDraft: null,
        staking: {
          loaded: true,
          loading: false,
          error: null,
          updatedAt: Date.now(),
          profileIndex: 0,
          minimumStakeLux,
          ownerStatus: scenario,
          actionKind: "topup",
          activePositionKey: null,
          stakeAmountDusk: "",
          unstakeAmountDusk: "",
          withdrawAmountDusk: "",
          ownerProfileIndex: 0,
          fundingMode: "account",
        },
      };
      window.__stakeOv = { selectedAccountIndex: 0 };
      window.__stakeActions = {
        send: async (message) => {
          window.__stakeMessages.push(message);
          if (message?.type === "DUSK_UI_GET_CACHED_GAS_PRICE") {
            return { ok: true, result: { median: "1" } };
          }
          if (message?.type === "DUSK_UI_SEND_TX") {
            return {
              ok: true,
              result: { hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
            };
          }
          return { ok: true, result: null };
        },
        render: async () => window.__renderStake(),
        showToast: (message) => window.__stakeToasts.push(String(message)),
      };
      window.__renderStake = () => {
        root.innerHTML = "";
        const view = window.__stakeState.route === "stake_confirm"
          ? mod.stakeConfirmView(window.__stakeOv, {
              state: window.__stakeState,
              actions: window.__stakeActions,
            })
          : mod.stakeFormView(window.__stakeOv, {
              state: window.__stakeState,
              actions: window.__stakeActions,
            });
        for (const child of Array.isArray(view) ? view : [view]) {
          if (child) root.append(child);
        }
      };
      window.__renderStake();
    },
    { minimumStakeLux: dusk(1000), scenario }
  );
}

async function setEditorAction(page, action) {
  await page.evaluate((nextAction) => {
    window.__stakeState.staking.actionKind = nextAction;
    window.__stakeState.staking.activePositionKey = "stake:1";
    window.__renderStake();
  }, action);
}

async function clickEnabled(page, label) {
  await page.evaluate((buttonLabel) => {
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === buttonLabel && !b.disabled
    );
    if (!button) throw new Error(`No enabled button: ${buttonLabel}`);
    button.click();
  }, label);
}

async function stakeState(page) {
  return page.evaluate(() => ({
    route: window.__stakeState.route,
    draft: window.__stakeState.stakeDraft,
    messages: window.__stakeMessages,
    toasts: window.__stakeToasts,
  }));
}

test.describe("owner-aware staking position view", () => {
  test("keeps unsupported owner-separated positions visible but not submittable", async ({ page }) => {
    await installStakeHarness(page, ownerStatusFor("local-no-gas"));

    await expect(page.getByText("Profile 1 owns this Profile 2 stake.")).toBeVisible();
    await expect(page.getByText("Profile 2 public · 0 DUSK")).toBeVisible();
    await expect(page.getByText(/Add gas funds to Profile 2/)).toHaveCount(1);
    await expect(page.locator('button:has-text("Review")[disabled]')).not.toHaveCount(0);

    await installStakeHarness(page, ownerStatusFor("missing"));
    await expect(page.getByText("Owner key not found in this wallet.").first()).toBeVisible();
    await expect(page.locator('button:has-text("Review")[disabled]')).not.toHaveCount(0);

    await installStakeHarness(page, ownerStatusFor("contract"));
    await expect(page.getByText("Contract-owned stake. View only.").first()).toBeVisible();
    await expect(page.locator('button:has-text("Review")[disabled]')).not.toHaveCount(0);
  });

  test("drafts full claim/full unstake and custom stake actions with explicit profiles", async ({ page }) => {
    await installStakeHarness(page, ownerStatusFor("local-funded"));
    await setEditorAction(page, "claim");
    await expect(page.getByLabel("Reward amount")).toHaveCount(0);
    await clickEnabled(page, "Review claim rewards");

    let state = await stakeState(page);
    expect(state.route).toBe("stake_confirm");
    expect(state.draft).toMatchObject({
      kind: "withdraw_reward",
      profileIndex: 1,
      stakeProfileIndex: 1,
      ownerProfileIndex: 0,
      amountLux: null,
      amountMode: "all",
    });
    await clickEnabled(page, "Confirm");
    state = await stakeState(page);
    expect(state.messages.find((m) => m?.type === "DUSK_UI_SEND_TX").params).toMatchObject({
      kind: "withdraw_reward",
      profileIndex: 1,
      ownerProfileIndex: 0,
    });
    expect(state.messages.find((m) => m?.type === "DUSK_UI_SEND_TX").params).not.toHaveProperty("amount");

    await installStakeHarness(page, ownerStatusFor("local-funded"));
    await setEditorAction(page, "unstake");
    await expect(page.getByLabel("Unstake amount")).toHaveCount(0);
    await clickEnabled(page, "Review unstake");
    state = await stakeState(page);
    expect(state.draft).toMatchObject({
      kind: "unstake",
      profileIndex: 1,
      ownerProfileIndex: 0,
      amountLux: null,
      amountMode: "all",
    });

    await installStakeHarness(page, ownerStatusFor("local-funded"));
    await setEditorAction(page, "topup");
    await page.getByLabel("Add stake amount").fill("5");
    await page.getByRole("button", { name: /Review add stake/i }).click();
    state = await stakeState(page);
    expect(state.draft).toMatchObject({
      kind: "stake",
      profileIndex: 1,
      ownerProfileIndex: 0,
      amountLux: dusk(5),
      amountMode: "custom",
    });

    await installStakeHarness(page, ownerStatusFor("local-funded"));
    await setEditorAction(page, "topup");
    await clickEnabled(page, "Max");
    await page.getByRole("button", { name: /Review add stake/i }).click();
    state = await stakeState(page);
    expect(state.draft).toMatchObject({
      kind: "stake",
      profileIndex: 1,
      ownerProfileIndex: 0,
      amountMode: "max",
    });
  });

  test("supports choosing another local owner for new stake", async ({ page }) => {
    await installStakeHarness(page, ownerStatusFor("create-self"));
    await expect(page.getByText("New stakes are self-owned by default. Choose another local owner only for separated-owner setups.")).toBeVisible();
    await page.locator("#stake-owner-profile").selectOption("1");
    await page.getByLabel("Stake amount").fill("1000");
    await page.getByRole("button", { name: /Review stake/i }).click();

    const state = await stakeState(page);
    expect(state.draft).toMatchObject({
      kind: "stake",
      profileIndex: 0,
      ownerProfileIndex: 1,
    });
  });
});
