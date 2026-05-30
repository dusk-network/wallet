import { expect, test } from "@playwright/test";

const LUX = 1_000_000_000n;
const dusk = (n) => (BigInt(n) * LUX).toString();

const ownerStatus = {
  profileIndex: 0,
  account: "owner_profile_1_account_abcdefghijklmnopqrstuvwxyz",
  publicBalance: { value: dusk(5000) },
  hasStake: false,
  info: { amount: null, reward: "0", faults: 0, hardFaults: 0 },
  ownerKind: "none",
  ownerProfileIndex: 0,
  manageable: true,
  profiles: [
    {
      profileIndex: 0,
      account: "owner_profile_1_account_abcdefghijklmnopqrstuvwxyz",
      publicBalance: { value: dusk(5000) },
    },
  ],
  relatedStakes: [],
};

async function installStakeHarness(page, { networkName = "Testnet" } = {}) {
  await page.goto("/");
  await page.evaluate(
    async ({ networkName, ownerStatus, minimumStakeLux, positionBalanceLux }) => {
      const mod = await import("/src/ui/popup/views/stake.js");
      const root = document.createElement("main");
      document.body.innerHTML = "";
      document.body.append(root);

      window.__stakeMessages = [];
      window.__stakeToasts = [];
      window.__stakeState = {
        route: "stake",
        stakeDraft: null,
        sozuDraft: null,
        staking: {
          loaded: true,
          loading: false,
          error: null,
          updatedAt: Date.now(),
          profileIndex: 0,
          minimumStakeLux,
          ownerStatus,
          actionKind: "topup",
          activePositionKey: null,
          stakeAmountDusk: "",
          unstakeAmountDusk: "",
          withdrawAmountDusk: "",
          ownerProfileIndex: 0,
          fundingMode: "account",
        },
        sozu: {
          action: "deposit",
          depositAmountDusk: "",
          withdrawAmountDusk: "",
          pool: {
            exchangeRate: {
              numerator: "5366833972489941",
              denominator: "3553557929448253",
            },
          },
          position: { balance: positionBalanceLux },
        },
      };
      window.__stakeOv = { selectedAccountIndex: 0, networkName };
      window.__stakeActions = {
        send: async (message) => {
          window.__stakeMessages.push(message);
          return { ok: true, result: null };
        },
        render: async () => window.__renderStake(),
        showToast: (message) => window.__stakeToasts.push(String(message)),
      };
      window.__renderStake = () => {
        root.innerHTML = "";
        const view = mod.stakeFormView(window.__stakeOv, {
          state: window.__stakeState,
          actions: window.__stakeActions,
        });
        for (const child of Array.isArray(view) ? view : [view]) {
          if (child) root.append(child);
        }
      };
      window.__renderStake();
    },
    { networkName, ownerStatus, minimumStakeLux: dusk(1000), positionBalanceLux: dusk(12) }
  );
}

async function state(page) {
  return await page.evaluate(() => ({
    sozuDraft: window.__stakeState.sozuDraft,
    toasts: window.__stakeToasts,
    text: document.body.innerText,
  }));
}

test.describe("Sozu liquid staking panel", () => {
  test("renders separately from native staking and creates deposit/withdraw drafts", async ({ page }) => {
    await installStakeHarness(page, { networkName: "Testnet" });

    await expect(page.getByText("Stake positions")).toBeVisible();
    await expect(page.getByText("Liquid staking with Sozu")).toBeVisible();
    await expect(page.getByText("Stake without running a node")).toBeVisible();
    await expect(page.getByText("This uses Sozu contracts, not native provisioner staking.")).toBeVisible();
    await expect(page.getByText("Your Sozu shares")).toBeVisible();
    await expect(page.getByRole("button", { name: "Review deposit" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Review withdraw" })).not.toBeVisible();

    await page.getByLabel("Deposit amount").fill("5");
    await page.getByRole("button", { name: "Review deposit" }).click();
    let st = await state(page);
    expect(st.sozuDraft).toMatchObject({
      kind: "contract_call",
      fnName: "sozu_stake",
      amount: "0",
      deposit: dusk(5),
      label: "Deposit into Sozu",
    });

    await page.getByRole("button", { name: "Withdraw" }).click();
    await page.getByLabel("Withdraw amount").fill("2");
    await page.getByRole("button", { name: "Review withdraw" }).click();
    st = await state(page);
    expect(st.sozuDraft).toMatchObject({
      kind: "contract_call",
      fnName: "sozu_unstake",
      amount: "0",
      deposit: "0",
      label: "Withdraw from Sozu",
    });
  });

  test("shows a safe disabled state when Sozu config is missing", async ({ page }) => {
    await installStakeHarness(page, { networkName: "Local" });

    await expect(page.getByText("Liquid staking with Sozu")).toBeVisible();
    await expect(page.getByText("Sozu liquid staking is not configured for this network.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Review deposit" })).toBeDisabled();
  });
});
