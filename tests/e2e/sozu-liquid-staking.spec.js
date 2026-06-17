import { expect, test } from "@playwright/test";

const LUX = 1_000_000_000n;
const dusk = (n) => (BigInt(n) * LUX).toString();
const ST_DUSK_CONTRACT_ID = "fdbf49102e76cf58224003451c6cb9e3403c54ff1d9042f8bc46ec25c6a4337c";
const ST_DUSK_CONTRACT_ID_CANONICAL = `0x${ST_DUSK_CONTRACT_ID}`;

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
      const stakeMod = await import("/src/ui/popup/views/stake.js");
      const sozuMod = await import("/src/ui/popup/views/sozu.js");
      const assetsMod = await import("/src/ui/popup/views/assets.js");
      const root = document.createElement("main");
      document.body.innerHTML = "";
      document.body.append(root);

      window.__stakeMessages = [];
      window.__stakeToasts = [];
      window.__watchedTokens = [];
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
          if (message?.type === "DUSK_UI_GET_SOZU_STATUS") {
            return {
              ok: true,
              result: {
                configured: true,
                networkKey: networkName.toLowerCase(),
                source: networkName === "Local" ? "unavailable" : "hub",
                reason: networkName === "Local"
                  ? "Sozu liquid staking is not configured for this network."
                  : "",
                contracts: networkName === "Local"
                  ? {}
                  : {
                      hub: "bae85f8c24730a5a19fbe3d3bd58248ac8c302b62fe414a8c640d8c0ed286b9e",
                      pool: "72883945ac1aa032a88543aacc9e358d1dfef07717094c05296ce675f23078f2",
                      "staked-dusk": "fdbf49102e76cf58224003451c6cb9e3403c54ff1d9042f8bc46ec25c6a4337c",
                    },
                pool: {
                  totalStakeLux: "5366833972489941",
                  tokenTotalSupply: "3553557929448253",
                  exchangeRate: 1.51027,
                },
                position: {
                  poolBalanceLux: positionBalanceLux,
                  stDuskBalanceLux: "7944063151",
                },
                publicBalance: { value: "5000000000000" },
              },
            };
          }
          if (message?.type === "DUSK_UI_ASSETS_WATCH_TOKEN") {
            window.__watchedTokens = [{
              ...message.token,
              contractId: `0x${String(message.token?.contractId ?? "").replace(/^0x/i, "").toLowerCase()}`,
            }];
            return { ok: true, result: { tokens: window.__watchedTokens, nfts: [] } };
          }
          if (message?.type === "DUSK_UI_ASSETS_GET") {
            return { ok: true, result: { tokens: window.__watchedTokens, nfts: [] } };
          }
          if (message?.type === "DUSK_UI_DRC20_GET_BALANCE") {
            return { ok: true, result: "7944063151" };
          }
          if (message?.type === "DUSK_UI_GET_CACHED_GAS_PRICE") {
            return { ok: true, result: { min: "1", median: "2", max: "3" } };
          }
          if (message?.type === "DUSK_UI_SEND_TX") {
            return {
              ok: true,
              result: { hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
            };
          }
          return { ok: true, result: null };
        },
        render: async () => window.__renderStake(),
        showToast: (message) => window.__stakeToasts.push(String(message)),
      };
      window.__renderStake = () => {
        root.innerHTML = "";
        const view = window.__stakeState.route === "asset_token"
          ? assetsMod.assetTokenView(window.__stakeOv, {
              state: window.__stakeState,
              actions: window.__stakeActions,
            })
          : window.__stakeState.route === "sozu_confirm"
          ? sozuMod.sozuConfirmView(window.__stakeOv, {
              state: window.__stakeState,
              actions: window.__stakeActions,
            })
          : stakeMod.stakeFormView(window.__stakeOv, {
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
    route: window.__stakeState.route,
    assetTokenContractId: window.__stakeState.assetTokenContractId,
    sozuDraft: window.__stakeState.sozuDraft,
    toasts: window.__stakeToasts,
    text: document.body.innerText,
  }));
}

test.describe("Sozu liquid staking panel", () => {
  test("renders separately from native staking and creates stake/unstake drafts", async ({ page }) => {
    await installStakeHarness(page, { networkName: "Testnet" });

    await expect(page.getByText("Stake positions")).toBeVisible();
    await page.getByRole("button", { name: "Liquid staking" }).click();
    await expect(page.locator(".sozu-kicker")).toHaveCount(0);
    await expect(page.getByText("Sozu", { exact: true })).toBeVisible();
    await expect(page.getByText("Stake DUSK through Sozu.")).toBeVisible();
    await expect(page.getByText("Third-party", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "sozu.fi" })).toHaveAttribute("href", "https://sozu.fi/");
    await expect(page.getByText("Hub discovered")).toHaveCount(0);
    await expect(page.getByText("testnet")).toHaveCount(0);
    await expect(page.getByText("Pool balance")).toBeVisible();
    await expect(page.getByText("Available", { exact: true })).toBeVisible();
    await expect(page.getByText("stDUSK", { exact: true })).toBeVisible();
    await expect(page.getByText("Rate")).toBeVisible();
    await expect(page.locator(".sozu-stats .hrow .muted")).toHaveText([
      "Pool balance",
      "Available",
      "stDUSK",
      "Rate",
    ]);
    await expect(page.getByText("stDUSK is available in Assets.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Review Sozu stake" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Review unstake" })).not.toBeVisible();

    await expect.poll(async () => {
      const messages = await page.evaluate(() => window.__stakeMessages);
      return messages.find((msg) => msg?.type === "DUSK_UI_ASSETS_WATCH_TOKEN")?.token;
    }).toMatchObject({
      contractId: ST_DUSK_CONTRACT_ID,
      symbol: "stDUSK",
      decimals: 9,
      driver: "sozu_staked_dusk",
    });

    await page.getByRole("button", { name: "Open stDUSK in Assets" }).click();
    await expect.poll(async () => {
      const st = await state(page);
      return {
        route: st.route,
        contractId: st.assetTokenContractId,
      };
    }).toEqual({
      route: "asset_token",
      contractId: ST_DUSK_CONTRACT_ID_CANONICAL,
    });
    await expect(page.getByText("Staked DUSK")).toBeVisible();
    await expect(page.getByText("7.944", { exact: true })).toBeVisible();

    await installStakeHarness(page, { networkName: "Testnet" });
    await page.getByRole("button", { name: "Liquid staking" }).click();
    await page.getByLabel("Stake amount").fill("5000");
    await page.getByRole("button", { name: "Review Sozu stake" }).click();
    await expect.poll(async () => (await state(page)).toasts.at(-1)).toBe("Stake amount exceeds public balance after gas.");
    await page.getByRole("button", { name: "Max" }).click();
    await expect(page.getByLabel("Stake amount")).toHaveValue("4999.5");

    await page.getByLabel("Stake amount").fill("5");
    await page.getByRole("button", { name: "Review Sozu stake" }).click();
    let st = await state(page);
    expect(st.sozuDraft).toMatchObject({
      kind: "contract_call",
      fnName: "sozu_stake",
      amount: "0",
      deposit: dusk(5),
      label: "Stake with Sozu",
    });
    await expect(page.getByText("You are about to use Sozu")).toBeVisible();
    await expect(page.getByText("Stake with Sozu")).toBeVisible();
    await expect(page.getByText("Funding Profile 1 public")).toBeVisible();
    await expect(page.getByRole("button", { name: "Recommended" })).toBeVisible();

    await page.getByRole("button", { name: "Confirm" }).click();
    const submitted = await page.evaluate(() =>
      window.__stakeMessages.findLast((msg) => msg?.type === "DUSK_UI_SEND_TX")
    );
    expect(submitted).toMatchObject({
      type: "DUSK_UI_SEND_TX",
      params: {
        kind: "contract_call",
        fnName: "sozu_stake",
        profileIndex: 0,
      },
      asset: {
        kind: "sozu",
        action: "sozu_stake",
      },
    });

    await installStakeHarness(page, { networkName: "Testnet" });
    await page.getByRole("button", { name: "Liquid staking" }).click();
    await page.getByRole("button", { name: "Unstake" }).last().click();
    await page.getByLabel("Unstake amount").fill("13");
    await page.getByRole("button", { name: "Review Sozu unstake" }).click();
    await expect.poll(async () => (await state(page)).toasts.at(-1)).toBe("Unstake amount exceeds pool balance.");
    await page.getByRole("button", { name: "Max" }).click();
    await expect(page.getByLabel("Unstake amount")).toHaveValue("12");
    await page.getByRole("button", { name: "Review Sozu unstake" }).click();
    st = await state(page);
    expect(st.sozuDraft).toMatchObject({
      kind: "contract_call",
      fnName: "sozu_unstake",
      amount: "0",
      deposit: "0",
      label: "Unstake from Sozu",
    });
  });

  test("shows a safe disabled state when Sozu config is missing", async ({ page }) => {
    await installStakeHarness(page, { networkName: "Local" });

    await page.getByRole("button", { name: "Liquid staking" }).click();
    await expect(page.getByText("Sozu", { exact: true })).toBeVisible();
    await expect(page.getByText("Sozu liquid staking is not configured for this network.").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Review Sozu stake" })).toBeDisabled();
  });
});
