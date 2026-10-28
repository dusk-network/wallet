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
                // Testnet's fees and switches, as Sozu's substrate gives them.
                fees: {
                  deposit: { numerator: "25", denominator: "10000" },
                  reward: { numerator: "10", denominator: "100" },
                },
                features: { maintenance: false, synchronization: false },
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

test.describe("Sozu liquid staking", () => {
  test("is a choice of its own, names Sozu a third party with its site, and creates stake/unstake drafts", async ({ page }) => {
    await installStakeHarness(page, { networkName: "Testnet" });

    // Native and liquid staking are two equal rows; nothing is picked.
    await expect(page.getByRole("button", { name: /Native staking/ })).toBeVisible();
    await page.getByRole("button", { name: /Liquid staking/ }).click();
    await expect(page.locator(".subnav-title")).toHaveText("Liquid staking");
    await expect(page.locator(".liquid-intro")).toHaveText(/^Sozu\s*third party\s*sozu\.fi$/);
    await expect(page.locator(".liquid-intro .tag")).toHaveText("third party");
    await expect(page.locator(".liquid-intro").getByRole("button", { name: "sozu.fi" })).toBeVisible();
    await expect(page.getByText("Hub discovered")).toHaveCount(0);
    await expect(page.getByText("testnet")).toHaveCount(0);
    await expect(page.locator(".kv .kv-label")).toHaveText(["Staked with Sozu", "stDUSK"]);
    await expect(page.getByRole("button", { name: "Review stake" })).toBeVisible();

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
    await expect(page.locator(".asset-token-balance-value")).toHaveText("7.944 stDUSK");

    await installStakeHarness(page, { networkName: "Testnet" });
    await page.getByRole("button", { name: /Liquid staking/ }).click();
    // Too much says so under the field, not in a toast.
    await page.getByLabel("Stake amount").fill("5000");
    await expect(page.locator(".amount-field__error")).toHaveText("That's more than your public balance, with the network fee.");
    await expect(page.getByRole("button", { name: "Review stake" })).toBeDisabled();
    // Max keeps the fee, and the fee to unstake later: 0.005 and 0.01 DUSK.
    await page.getByRole("button", { name: "Max" }).click();
    await expect(page.getByLabel("Stake amount")).toHaveValue("4999.985");

    // Too little for any stDUSK after Sozu's fee says so; Review stays off.
    await page.getByLabel("Stake amount").fill("0.000000001");
    await expect(page.locator(".amount-field__error")).toHaveText("The minimum stake is 0.000000003 DUSK.");
    await expect(page.getByRole("button", { name: "Review stake" })).toBeDisabled();

    await page.getByLabel("Stake amount").fill("5");
    await expect(page.locator(".sozu-terms")).toHaveText("Deposit fee 0.25% · 0.0125 DUSK");
    await expect(page.locator(".stake-estimate__main")).toHaveText(/^You get about [\d.,]+ stDUSK, worth about 4\.9875 DUSK now\.$/);
    await page.getByRole("button", { name: "Review stake" }).click();
    let st = await state(page);
    expect(st.sozuDraft).toMatchObject({
      kind: "contract_call",
      fnName: "sozu_stake",
      amount: "0",
      deposit: dusk(5),
    });
    await expect(page.locator(".review-head")).toContainText("Liquid staking");
    await expect(page.locator(".review-head")).toContainText("With Sozu, a third party");
    await expect(page.locator(".review-visible")).toContainText("Visible to everyone: the amount you stake with Sozu");
    await expect(page.locator(".gas-fee")).toContainText("Network fee");
    // The network's gas price, with one Custom fee, closed, and no presets.
    await expect(page.getByRole("button", { name: "Recommended" })).toHaveCount(0);
    await expect(page.getByLabel("Gas limit")).toBeHidden();
    await page.locator("details.gas-custom summary").click();
    await expect(page.getByLabel("Gas limit")).toBeVisible();

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
    await page.getByRole("button", { name: /Liquid staking/ }).click();
    await page.getByRole("tab", { name: "Unstake" }).click();
    await expect(page.locator(".sozu-terms")).toHaveText("The DUSK comes back in the same transaction. No fee, no waiting.");
    await page.getByLabel("Unstake amount").fill("13");
    await expect(page.locator(".amount-field__error")).toHaveText("That's more than you have staked with Sozu.");
    await page.getByRole("button", { name: "Max" }).click();
    await expect(page.getByLabel("Unstake amount")).toHaveValue("12");
    await page.getByRole("button", { name: "Review unstake" }).click();
    st = await state(page);
    expect(st.sozuDraft).toMatchObject({
      kind: "contract_call",
      fnName: "sozu_unstake",
      amount: "0",
      deposit: "0",
    });
    expect(st.toasts).toEqual([]);
  });

  test("shows a safe disabled state when Sozu config is missing", async ({ page }) => {
    await installStakeHarness(page, { networkName: "Local" });

    await page.getByRole("button", { name: /Liquid staking/ }).click();
    await expect(page.locator(".liquid-intro")).toContainText("Sozu");
    await expect(page.getByText("Sozu liquid staking is not configured for this network.").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Review stake" })).toBeDisabled();
  });
});
