// The wallets, as the popup changes them, the same in the extension's
// background and in the app's own page: a switch to another wallet (no
// password), another added (the password), one removed (the password), one
// renamed, and a new password for all of them. Each runs in the wallet
// lifecycle lock, unlocked, with the engine the host gives.

import { addVaultWallet, changeVaultPassword, removeVaultWallet } from "../shared/vault.js";
import { getSettings, setSettings } from "../shared/settings.js";
import { adoptLegacyPermissions, getPermissions } from "../shared/permissions.js";
import { adoptLegacyTxs } from "../shared/txStore.js";
import { adoptLegacyArrivals } from "../shared/bridgeArrival.js";
import { forgetWalletData } from "../shared/walletReset.js";
import { getAccountNames } from "../shared/accountNames.js";
import { forgetWallet, getWalletDirectory, noteActiveWallet, normalizeWalletName, setWalletName, walletLabel } from "../shared/wallets.js";
import { WALLET_LIFECYCLE_LOCK, withStorageLock } from "../shared/storageLock.js";
import { ERROR_CODES, rpcError } from "../shared/errors.js";

const COMMANDS = new Set([
  "DUSK_UI_SWITCH_WALLET",
  "DUSK_UI_ADD_WALLET",
  "DUSK_UI_REMOVE_WALLET",
  "DUSK_UI_RENAME_WALLET",
  "DUSK_UI_CHANGE_PASSWORD",
]);

const UNLOCK_TIMEOUT_MS = 120_000;

/**
 * Keep what the switcher shows of the wallet unlocked now (`unlocked`, the
 * engine's answer to an unlock or a switch), and make the data kept before
 * wallets were kept apart its own: the sites of its profiles, and when it's
 * the wallet moved from the one-phrase vault (a "v1-" key), the sends and
 * arrivals of the one wallet there was.
 * @param {{ walletKey: string, accounts: string[], wallets?: Array<{ key: string, n: number }> }} unlocked
 */
export async function keepWalletShown(unlocked) {
  const accounts = Array.isArray(unlocked?.accounts) ? unlocked.accounts : [];
  const walletId = String(accounts[0] ?? "");
  if (!walletId) return;
  await noteActiveWallet(unlocked.walletKey, { walletId, accounts }).catch(() => {});
  await adoptLegacyPermissions(walletId, accounts).catch(() => {});
  if (String(unlocked.walletKey ?? "").startsWith("v1-")) {
    await adoptLegacyTxs(walletId).catch(() => {});
    await adoptLegacyArrivals(walletId).catch(() => {});
  }
}

/**
 * The wallets the switcher shows, by number: each one the engine holds, with
 * its name, its profiles' accounts (the unlocked one's as the engine gives
 * them, the others' as they were last shown) and their labels.
 * @param {object} status - the engine's status
 * @returns {Promise<Array<{ key: string, n: number, name: string, walletId: string, accounts: string[], accountNames: object, active: boolean }>>}
 */
export async function walletsShown(status) {
  if (!status?.isUnlocked) return [];
  const { wallets: kept } = await getWalletDirectory().catch(() => ({ wallets: {} }));
  return Promise.all(
    (Array.isArray(status.wallets) ? status.wallets : []).map(async ({ key, n }) => {
      const active = key === status.walletKey;
      const shown = kept?.[key] ?? {};
      const accounts = active ? status.accounts ?? [] : Array.isArray(shown.accounts) ? shown.accounts : [];
      const walletId = String(accounts[0] ?? shown.walletId ?? "");
      return {
        key,
        n,
        name: normalizeWalletName(shown.name),
        walletId,
        accounts,
        accountNames: walletId ? await getAccountNames(walletId).catch(() => ({})) : {},
        active,
      };
    })
  );
}

/**
 * The open wallet's name, as the switcher shows it, when there's more than
 * one wallet: what a site's request names beside the profile. "" with one.
 * @param {object} status - the engine's status
 * @returns {Promise<string>}
 */
export async function openWalletName(status) {
  const wallets = status?.isUnlocked && Array.isArray(status.wallets) ? status.wallets : [];
  const open = wallets.length > 1 ? wallets.find((w) => w?.key === status.walletKey) : null;
  if (!open) return "";
  const { wallets: kept } = await getWalletDirectory().catch(() => ({ wallets: {} }));
  return walletLabel({ n: open.n, name: kept?.[open.key]?.name });
}

/**
 * @param {object} message
 * @param {{
 *   engineCall: (method: string, params?: object, options?: object) => Promise<any>,
 *   ensureEngineConfigured: () => Promise<any>,
 *   getEngineStatus: () => Promise<object>,
 *   lock: () => Promise<void>,
 *   beforeSwitch?: () => void,
 *   afterSwitch?: (change: { oldPerms: object, oldStatus: object }) => Promise<void>,
 *   walletsChanged?: () => void,
 * }} host - the engine, its lock, and what the host does around a switch:
 *   the background cancels sites' pending approvals before, and tells sites
 *   and pages after
 * @returns {Promise<object|null>} the answer, or null for another message
 */
export function handleWalletCommand(message, host) {
  const type = message?.type;
  if (!COMMANDS.has(type)) return Promise.resolve(null);
  return withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
    const status = await host.getEngineStatus();
    if (!status?.isUnlocked) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
    const keys = (Array.isArray(status.wallets) ? status.wallets : []).map((w) => w.key);
    const held = (key) => keys.includes(key);

    if (type === "DUSK_UI_SWITCH_WALLET") {
      const walletKey = String(message.walletKey ?? "");
      if (!held(walletKey)) throw rpcError(ERROR_CODES.INVALID_PARAMS, "That wallet isn't here.");
      return { ok: true, result: await switchTo(walletKey, message.index, host, status) };
    }

    if (type === "DUSK_UI_ADD_WALLET") {
      const mnemonic = String(message.mnemonic ?? "").trim();
      const password = String(message.password ?? "");
      if (!mnemonic || !password) throw rpcError(ERROR_CODES.INVALID_PARAMS, "mnemonic and password required");
      // A phrase that isn't one is refused before the vault is touched.
      await host.engineCall("engine_walletId", { mnemonic }, { timeoutMs: UNLOCK_TIMEOUT_MS });
      // Under the password the wallets here were unlocked with.
      const wallet = await addVaultWallet(mnemonic, password, { held: keys });
      // The vault holds it: the engine keeps it too, then switches to it, at its first profile.
      let switched;
      try {
        await host.engineCall("engine_addWallet", { walletKey: wallet.id, n: wallet.n, mnemonic });
        switched = await switchTo(wallet.id, 0, host, await host.getEngineStatus());
      } catch {
        // Kept all the same: the next unlock opens it with the others.
        throw rpcError(ERROR_CODES.INTERNAL, "The wallet was added. Lock and unlock to open it.");
      }
      // A phrase made here has no history: its shielded sync starts now. In
      // this same step, for this wallet alone, the one open as it's set.
      if (message.fresh === true && (await host.getEngineStatus())?.walletKey === wallet.id) {
        await host.engineCall("dusk_setShieldedCheckpointNow", { profileIndex: 0 }).catch(() => {});
      }
      return { ok: true, result: { ...switched, n: wallet.n } };
    }

    if (type === "DUSK_UI_REMOVE_WALLET") {
      const walletKey = String(message.walletKey ?? "");
      if (!held(walletKey)) throw rpcError(ERROR_CODES.INVALID_PARAMS, "That wallet isn't here.");
      if (status.wallets.length < 2) throw rpcError(ERROR_CODES.INVALID_PARAMS, "This is the only wallet here. Reset removes it.");
      const { wallets: kept } = await getWalletDirectory().catch(() => ({ wallets: {} }));
      const active = walletKey === status.walletKey;
      // Its profiles' accounts, whose data goes with it: from its phrase, while
      // the engine still holds it, and as the switcher last showed them.
      const shown = Array.isArray(kept?.[walletKey]?.accounts) ? kept[walletKey].accounts : [];
      const derived = active
        ? status.accounts ?? []
        : await host.engineCall("engine_walletAccounts", { walletKey }, { timeoutMs: UNLOCK_TIMEOUT_MS }).catch(() => []);
      const accounts = [...new Set([...(Array.isArray(derived) ? derived : []), ...shown].map(String).filter(Boolean))];
      const walletId = String(accounts[0] ?? kept?.[walletKey]?.walletId ?? "");
      // The vault first: the password must open the wallet it removes, and a
      // wrong one changes nothing.
      await removeVaultWallet(walletKey, String(message.password ?? ""));
      if (active) {
        const next = status.wallets.find((w) => w.key !== walletKey);
        try {
          await switchTo(next.key, 0, host, status);
        } catch (error) {
          // Never left on a wallet the vault no longer holds: the next unlock opens the others.
          await host.lock();
          throw error;
        }
      }
      await host.engineCall("engine_removeWallet", { walletKey });
      await forgetWallet(walletKey).catch(() => {});
      // Its data goes with it; another wallet's stays.
      if (walletId) await forgetWalletData({ walletId, accounts }).catch(() => false);
      // Every page lists the wallets as they are now, the open one or not.
      host.walletsChanged?.();
      return { ok: true };
    }

    if (type === "DUSK_UI_RENAME_WALLET") {
      const walletKey = String(message.walletKey ?? "");
      if (!held(walletKey)) throw rpcError(ERROR_CODES.INVALID_PARAMS, "That wallet isn't here.");
      await setWalletName(walletKey, message.name);
      host.walletsChanged?.();
      return { ok: true, result: { name: normalizeWalletName(message.name) } };
    }

    // DUSK_UI_CHANGE_PASSWORD: every phrase sealed again under the new one.
    const newPassword = String(message.newPassword ?? "");
    if (newPassword.length < 8) throw rpcError(ERROR_CODES.INVALID_PARAMS, "Use at least 8 characters.");
    await changeVaultPassword(String(message.password ?? ""), newPassword, { held: keys });
    return { ok: true };
  });
}

// Switch to the wallet `walletKey` at profile `index`, within the wallet
// unlocked when it's that one. A switch that fails leaves the profile chosen
// as it was.
async function switchTo(walletKey, index, host, status) {
  const settings = await getSettings();
  const maxIndex = Math.max(0, Number(settings?.accountCount ?? 1) - 1);
  const profile = Math.min(Math.max(0, Math.floor(Number(index) || 0)), maxIndex);
  if (walletKey === status.walletKey) {
    await setSettings({ selectedAccountIndex: profile });
    await host.ensureEngineConfigured();
    const selected = await host.engineCall("engine_selectAccount", { index: profile });
    return { accounts: selected?.accounts ?? status.accounts, walletKey, selectedAccountIndex: profile };
  }
  const oldPerms = await getPermissions(String(status.accounts?.[0] ?? "")).catch(() => ({}));
  host.beforeSwitch?.();
  const previous = Number(settings?.selectedAccountIndex ?? 0) || 0;
  await setSettings({ selectedAccountIndex: profile });
  let unlocked;
  try {
    await host.ensureEngineConfigured();
  } catch (error) {
    await setSettings({ selectedAccountIndex: previous }).catch(() => {});
    throw error;
  }
  try {
    unlocked = await host.engineCall("engine_switchWallet", { walletKey }, { timeoutMs: UNLOCK_TIMEOUT_MS });
  } catch (error) {
    // No answer, or none to trust: the engine may still switch after this
    // step, with no wallet list or page told. Locked, it can't (an unlock
    // since outruns it), and the next unlock opens the wallet listed open.
    await setSettings({ selectedAccountIndex: previous }).catch(() => {});
    await host.lock("switch").catch(() => {});
    throw error;
  }
  await keepWalletShown(unlocked);
  await host.afterSwitch?.({ oldPerms, oldStatus: status });
  return { accounts: unlocked?.accounts ?? [], walletKey: unlocked?.walletKey ?? walletKey, selectedAccountIndex: profile };
}
