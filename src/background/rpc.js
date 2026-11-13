import { loadVault } from "../shared/vault.js";
import {
  adoptLegacyPermissions,
  approveOrigin,
  getPermissionForOrigin,
  permissionProfileState,
  revokeOriginEverywhere,
} from "../shared/permissions.js";
import { getSettings, setSettings } from "../shared/settings.js";
import { noteSiteSendFailed, siteLastsMs } from "../shared/siteRecords.js";
import { sentOf } from "../shared/sendOutcome.js";
import { assertSiteSend, proveSiteSend } from "../shared/sendPassword.js";
import { WALLET_LIFECYCLE_LOCK, withStorageLock } from "../shared/storageLock.js";
import { ERROR_CODES, rpcError } from "../shared/errors.js";
import { TX_KIND } from "../shared/constants.js";
import { applyTxDefaults, defaultGasPriceOf, isCompleteGas } from "../shared/txDefaults.js";
import { chainIdFromNodeUrl, chainReferenceFromChainId } from "../shared/chain.js";
import { networkNameFromNodeUrl } from "../shared/network.js";
import { readChainId } from "../shared/networkStatus.js";
import { nodeHost, pinnedChainOf } from "../shared/nodeNetwork.js";
import { NETWORK_PRESETS } from "../shared/networkPresets.js";
import {
  isAllowedDappEndpoint,
  isAllowedDappOrigin,
} from "../shared/securityPolicy.js";
import { messageBytes, sha256Hex, toBytes } from "../shared/bytes.js";
import { bridgeDepositRecipient } from "../shared/bridgeCalls.js";
import { nameReservationOf, registeredNameOf } from "../shared/knownCalls.js";
import { describeSignMessagePreview } from "../shared/signMessagePreview.js";
import {
  hashTypedDataHex,
  validateTypedDataParams,
} from "@dusk/typed-data";
import { checkPolicyLimits } from "@dusk/typed-data/policy";
import { classifyDuskIdentifier } from "../shared/duskIdentifiers.js";
import {
  DAPP_LIMITS,
  DAPP_RPC_METHODS,
  DAPP_TOMBSTONED_METHODS,
  DAPP_TX_KINDS,
} from "../shared/providerSurface.js";
import {
  engineCall,
  ensureEngineConfigured,
  getEngineStatus,
  getEngineStatusStrict,
  invalidateEngineConfig,
} from "./engineHost.js";
import { cancelPendingApprovals, requestUserApproval as askForApproval, sendOutcome } from "./pending.js";
import { siteWalletId } from "./siteWallet.js";
import { notifyTxSubmitted } from "./txNotify.js";
import { readCurrent, siteNames } from "./siteNames.js";
import { handOverRequestLink } from "./requestLinks.js";
import { getTxEpoch, putTxMeta } from "../shared/txStore.js";
import { submittedTxMeta } from "../shared/txRecord.js";
import { normalizeContractId, watchToken, watchNft } from "../shared/assetsStore.js";
import {
  broadcastChainChangedAll,
} from "./dappEvents.js";
import { getExtensionApi, runtimeGetURL, tabsCreate } from "../platform/extensionApi.js";

// RPC Handler (from dApps)
export async function handleRpc(origin, request, { pressed, approvalKey = "", resume = false, tabId } = {}) {
  // Each approval this request asks for, by the site's request (`approvalKey`):
  // asked again after the background stopped (`resume`), it takes up the one
  // still open (pending.js).
  // Taken up only for the wallet, profile, network and site it was asked for.
  const requestUserApproval = async (...ask) => {
    if (approvalKey) ask[4] = { ...(ask[4] ?? {}), key: approvalKey, resume, context: await askedFor() };
    return askForApproval(...ask);
  };
  const askedFor = async () => {
    const [settings, status] = await Promise.all([getSettings(), getEngineStatus()]);
    const perm = await permissionFor(status);
    return {
      origin,
      walletId: status?.isUnlocked ? String(status.accounts?.[0] ?? "") : "",
      nodeUrl: String(settings?.nodeUrl ?? ""),
      chainId: settings?.chainId ?? null,
      profileId: perm?.profileId ?? null,
      accountIndex: perm?.accountIndex ?? null,
    };
  };
  origin = String(origin ?? "").trim();
  if (!isAllowedDappOrigin(origin)) {
    throw rpcError(
      ERROR_CODES.UNAUTHORIZED,
      "Dusk Wallet only accepts dApp requests from HTTPS or local HTTP origins"
    );
  }

  const { method, params } = request || {};

  // Fail closed: a method reaches the switch below only if it is on the canonical
  // surface, or is explicitly tombstoned so its handler can explain the refusal.
  // Without this, every `case` added for internal or test use would be publicly
  // callable by any connected dApp regardless of what capabilities advertise.
  // Rejecting here also means an unrecognized method costs no permission lookup,
  // settings read, or approval prompt.
  if (!DAPP_RPC_METHODS.includes(method) && !DAPP_TOMBSTONED_METHODS.includes(method)) {
    throw rpcError(ERROR_CODES.METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }

  // The site's connection to the wallet it's connected to now (siteWallet.js):
  // none of another wallet's. One from before wallets were kept apart that the
  // unlock didn't move yet moves now, when it's of this wallet's profiles.
  const permissionFor = async (status) => {
    const current = status ?? (await getEngineStatus());
    const walletId = await siteWalletId(current);
    const perm = await getPermissionForOrigin(origin, walletId);
    if (perm || !current?.isUnlocked) return perm;
    // Most sites asking have none from before: those cost no move.
    if (!(await getPermissionForOrigin(origin, ""))) return null;
    const moved = await adoptLegacyPermissions(walletId, current.accounts).catch(() => 0);
    return moved ? getPermissionForOrigin(origin, walletId) : null;
  };

  // Whether the site is connected, as its provider state says (dappEvents.js), locked or not.
  const isConnected = async () => {
    const status = await getEngineStatus();
    return permissionProfileState(await permissionFor(status), status).isValid;
  };

  const MAX_CALLDATA_BYTES = DAPP_LIMITS.maxFnArgsBytes;
  const MAX_U64 = 18446744073709551615n;

  function mergeGas(baseGas, overrideGas) {
    if (!overrideGas || typeof overrideGas !== "object") {
      return baseGas;
    }

    const out = { ...(baseGas || {}) };

    if ("limit" in overrideGas) {
      const v = overrideGas.limit;
      if (v === null || v === "") delete out.limit;
      else out.limit = v;
    }
    if ("price" in overrideGas) {
      const v = overrideGas.price;
      if (v === null || v === "") delete out.price;
      else out.price = v;
    }

    if (!Object.keys(out).length) return undefined;

    // Gas must be either fully specified (limit + price) or not specified at all.
    // If it's partial, treat it as "auto".
    if (!isCompleteGas(out)) return undefined;

    return out;
  }

  function mergeTxParams(base, override) {
    // Approvals may return:
    // - null/undefined: no overrides
    // - true: approve value
    // - object: overrides
    if (!override || override === true || typeof override !== "object") {
      return base;
    }

    const out = { ...base, ...override };
    out.gas = mergeGas(base.gas, override.gas);
    return out;
  }

  function applyTxDefaultsForRpc(params, options) {
    try {
      return applyTxDefaults(params, options);
    } catch (err) {
      if (err?.code) throw err;
      throw rpcError(
        ERROR_CODES.INVALID_PARAMS,
        err?.message ?? "Invalid transaction parameters"
      );
    }
  }

  function sanitizeAccountIndex(v, len, fallback = 0) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return fallback;
    const idx = Math.floor(n);
    if (!Number.isFinite(len) || len <= 0) return fallback;
    return Math.max(0, Math.min(idx, len - 1));
  }

  function firstParamObject(value) {
    const p = Array.isArray(value) ? value[0] : value;
    return p && typeof p === "object" ? p : {};
  }

  function validateU64(value, name, { required = false, allowZero = true } = {}) {
    if (value === undefined || value === null || value === "") {
      if (required) {
        throw rpcError(ERROR_CODES.INVALID_PARAMS, `${name} is required`);
      }
      return "0";
    }

    let n;
    try {
      if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) throw new Error("unsafe");
        n = BigInt(value);
      } else if (typeof value === "bigint") {
        n = value;
      } else if (typeof value === "string") {
        const s = value.trim();
        if (!/^\d+$/.test(s)) throw new Error("format");
        n = BigInt(s);
      } else {
        throw new Error("type");
      }
    } catch {
      throw rpcError(ERROR_CODES.INVALID_PARAMS, `${name} must be a u64 decimal string`);
    }

    if (n < 0n || n > MAX_U64) {
      throw rpcError(ERROR_CODES.INVALID_PARAMS, `${name} must be a u64 decimal string`);
    }
    if (!allowZero && n === 0n) {
      throw rpcError(ERROR_CODES.INVALID_PARAMS, `${name} must be > 0`);
    }
    return n.toString();
  }

  // A site may set the gas limit alone: the wallet then fills in the node's
  // gas price, as it does for its own defaults. A price needs a limit.
  function validateGasShape(gas) {
    if (gas === undefined || gas === null) return gas;
    if (typeof gas !== "object" || Array.isArray(gas)) {
      throw rpcError(ERROR_CODES.INVALID_PARAMS, "gas must be an object with { limit, price? } or null");
    }
    const given = (v) => v !== undefined && v !== null && v !== "";
    if (!given(gas.limit) && !given(gas.price)) return gas;
    if (!given(gas.limit)) {
      throw rpcError(ERROR_CODES.INVALID_PARAMS, "gas.limit is required when gas.price is set");
    }
    const { price, ...rest } = gas;
    return {
      ...rest,
      limit: validateU64(gas.limit, "gas.limit", { required: true, allowZero: false }),
      ...(given(price) ? { price: validateU64(price, "gas.price", { required: true, allowZero: false }) } : {}),
    };
  }

  function validateMemo(memo) {
    if (memo === undefined || memo === null || memo === "") return memo;
    if (typeof memo !== "string") {
      throw rpcError(ERROR_CODES.INVALID_PARAMS, "memo must be a string");
    }
    const bytes = new TextEncoder().encode(memo);
    if (bytes.length > DAPP_LIMITS.maxMemoBytes) {
      throw rpcError(
        ERROR_CODES.INVALID_PARAMS,
        `memo too large (max ${DAPP_LIMITS.maxMemoBytes} bytes)`
      );
    }
    return memo;
  }

  function validateContractId(value) {
    try {
      return normalizeContractId(value);
    } catch {
      throw rpcError(
        ERROR_CODES.INVALID_PARAMS,
        "contractId must be a 32-byte hex string (0x + 64 hex chars)"
      );
    }
  }

  function validateFnName(value) {
    if (typeof value !== "string") {
      throw rpcError(ERROR_CODES.INVALID_PARAMS, "fnName must be a string");
    }
    const fnName = value.trim();
    if (!fnName) throw rpcError(ERROR_CODES.INVALID_PARAMS, "fnName is required");
    if (fnName.length > DAPP_LIMITS.maxFnNameChars) {
      throw rpcError(
        ERROR_CODES.INVALID_PARAMS,
        `fnName too long (max ${DAPP_LIMITS.maxFnNameChars} chars)`
      );
    }
    return fnName;
  }

  function validateFnArgs(value) {
    let bytes;
    try {
      bytes = toBytes(value);
    } catch {
      throw rpcError(
        ERROR_CODES.INVALID_PARAMS,
        "fnArgs must be bytes (hex string, base64 string, Uint8Array, ArrayBuffer, or number[])"
      );
    }
    if (bytes.length > MAX_CALLDATA_BYTES) {
      throw rpcError(
        ERROR_CODES.INVALID_PARAMS,
        `fnArgs too large (max ${MAX_CALLDATA_BYTES} bytes)`
      );
    }
    return bytes;
  }

  function validateNodeUrl(value) {
    const trimmed = String(value ?? "").trim();
    let normalized;
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("protocol");
      }
      normalized = url.origin;
    } catch {
      throw rpcError(ERROR_CODES.INVALID_PARAMS, "Invalid nodeUrl");
    }

    if (!isAllowedDappEndpoint(trimmed)) {
      throw rpcError(ERROR_CODES.INVALID_PARAMS, "nodeUrl must use HTTPS or local HTTP");
    }

    return normalized;
  }

  function profileFromStatus(status, index, includeShielded = false) {
    const accounts = Array.isArray(status?.accounts) ? status.accounts : [];
    const addresses = Array.isArray(status?.addresses) ? status.addresses : [];
    const idx = sanitizeAccountIndex(index, accounts.length, 0);
    const account = accounts[idx];
    if (!account) return null;
    const profile = {
      profileId: `account:${idx}:${account}`,
      account,
    };
    if (includeShielded && addresses[idx]) {
      profile.shieldedAddress = addresses[idx];
    }
    return profile;
  }

  function profileFromPermission(status, perm, includeShielded = false, names = null) {
    return permissionProfileState(perm, status, includeShielded, names).profile;
  }

  // The site's profiles as they are now: its connected profile, with its
  // verified .dusk name when that was checked lately. Reading the name never
  // waits for a lookup.
  function siteProfiles() {
    return readCurrent(async () => {
      const status = await getEngineStatus();
      const perm = await permissionFor(status);
      const account = profileFromPermission(status, perm)?.account;
      const names = account ? await siteNames(String((await getSettings())?.nodeUrl ?? ""), [account]) : null;
      const profile = profileFromPermission(status, perm, hasShieldedGrant(perm), names);
      return profile ? [profile] : [];
    });
  }

  async function captureApprovalContext(perm) {
    const [settings, status] = await Promise.all([getSettings(), getEngineStatusStrict()]);
    const permission = permissionProfileState(perm, status);
    if (!permission.isValid) {
      throw rpcError(ERROR_CODES.UNAUTHORIZED, "Connected profile is no longer available");
    }
    const accounts = Array.isArray(status?.accounts) ? status.accounts : [];
    return Object.freeze({
      isUnlocked: Boolean(status?.isUnlocked),
      origin,
      nodeUrl: String(settings?.nodeUrl ?? ""),
      // The chain it signs for: known since the request came, or it isn't what was approved.
      chainId: settings?.chainId ?? null,
      walletId: String(accounts[0] ?? ""),
      account: permission.profile?.account ?? "",
      profileIndex: perm.accountIndex,
      permissionProfileId: perm.profileId,
      permissionUpdatedAt: Number(perm.updatedAt),
    });
  }

  // `shown`: the wallet the prompt was for (promptFor), when there was one.
  async function assertApprovalContext(expected, shown = null) {
    const permission = await permissionFor();
    let current;
    try {
      current = await captureApprovalContext(permission);
    } catch {
      throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet changed while awaiting approval");
    }
    const keys = ["origin", "nodeUrl", "chainId", "profileIndex", "permissionProfileId", "permissionUpdatedAt"];
    if (expected.walletId) keys.push("walletId", "account");
    if (!current.isUnlocked || !current.walletId || keys.some((key) => current[key] !== expected[key])) {
      throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet changed while awaiting approval");
    }
    if (shown) assertShownWallet(shown, current.walletId);
    return current;
  }

  // A prompt is for one wallet (pending.js): the one unlocked as the site
  // asks (`state`: an engine status or an approval context), or, asked while
  // locked, the one its window shows first. Its window shows no other.
  function promptFor(state) {
    return { walletId: state?.isUnlocked ? String(state.walletId ?? state.accounts?.[0] ?? "") : "" };
  }

  // What a prompt approved acts for its wallet alone, the one unlocked now:
  // checked under the wallet lifecycle lock, before anything is kept, signed
  // or sent.
  function assertShownWallet(shown, walletId) {
    if (!shown?.walletId || shown.walletId !== String(walletId ?? "")) {
      throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet changed while awaiting approval");
    }
  }

  function hasShieldedGrant(perm) {
    return Boolean(perm?.grants?.shieldedReceiveAddress);
  }

  function sameProfilePermission(perm, profile) {
    return Boolean(perm?.profileId && profile?.profileId && perm.profileId === profile.profileId);
  }

  async function ensureVaultForProfileRequest() {
    const vault = await loadVault();
    if (!vault) {
      try {
        const url = runtimeGetURL("full.html");
        tabsCreate({ url }).catch(() => {});
      } catch {
        // ignore
      }
      throw rpcError(
        ERROR_CODES.UNAUTHORIZED,
        "Wallet not set up. Create or import a recovery phrase first."
      );
    }
  }

  async function requestProfileConnection(options = {}) {
    const requestedShieldedGrant = Boolean(options?.shieldedReceiveAddress);
    await ensureVaultForProfileRequest();

    const statusBeforePrompt = await getEngineStatus();
    const existing = await permissionFor(statusBeforePrompt);
    const selectedProfile = profileFromStatus(
      statusBeforePrompt,
      statusBeforePrompt?.selectedAccountIndex ?? existing?.accountIndex ?? 0,
      false
    );
    const effectiveShieldedGrant =
      requestedShieldedGrant ||
      (sameProfilePermission(existing, selectedProfile) && hasShieldedGrant(existing));

    const shown = promptFor(statusBeforePrompt);
    // A new connection lasts as this site was set to, else as new sites are.
    const lastsMs = await siteLastsMs(await siteWalletId(statusBeforePrompt), origin, (await getSettings()).newSiteLastsMs);
    const approved = await requestUserApproval("connect", origin, {
      requestedProfiles: true,
      lastsMs,
      endsAt: Number(existing?.expiresAt) || 0,
      stays: Boolean(existing),
      shieldedReceiveAddress: requestedShieldedGrant,
      effectiveShieldedReceiveAddress: effectiveShieldedGrant,
      currentProfileId: existing?.profileId,
      currentAccountIndex:
        existing && existing.accountIndex !== undefined && existing.accountIndex !== null
          ? Number(existing.accountIndex) || 0
          : null,
      currentGrants: existing?.grants ?? null,
      reason: options?.reason,
      label: options?.label,
    }, shown);

    return withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
      const status = await getEngineStatusStrict();
      if (!status?.isUnlocked) {
        throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet is still locked. Unlock to access accounts.");
      }

      const arr = Array.isArray(status.accounts) ? status.accounts : [];
      // Granted to the wallet the prompt showed, still the one unlocked, or to none.
      assertShownWallet(shown, arr[0]);
      const idx = sanitizeAccountIndex(approved?.accountIndex, arr.length, 0);
      const profile = profileFromStatus(status, idx, false);
      if (!profile) throw rpcError(ERROR_CODES.UNAUTHORIZED, "No wallet profile is available");
      const sameProfile = sameProfilePermission(existing, profile);
      const effectiveGrant = requestedShieldedGrant || (sameProfile && hasShieldedGrant(existing));
      // That wallet's alone.
      const perm = await approveOrigin(origin, {
        profileId: profile.profileId,
        accountIndex: idx,
        lastsMs,
        grants: {
          publicAccount: true,
          shieldedReceiveAddress: effectiveGrant,
        },
      }, String(arr[0] ?? ""));
      return { perm, status };
    });
  }

  function validateTransferPrivacy(params) {
    const privacyRaw = params?.privacy === undefined || params?.privacy === null
      ? ""
      : String(params.privacy).trim().toLowerCase();
    if (!privacyRaw) {
      throw rpcError(ERROR_CODES.INVALID_PARAMS, 'privacy is required for transfer ("public" or "shielded")');
    }
    if (privacyRaw !== "public" && privacyRaw !== "shielded") {
      throw rpcError(ERROR_CODES.INVALID_PARAMS, 'privacy must be "public" or "shielded"');
    }
    const to = String(params?.to ?? "").trim();
    const toType = to ? classifyDuskIdentifier(to) : "";
    if (privacyRaw === "public" && toType !== "account") {
      throw rpcError(ERROR_CODES.INVALID_PARAMS, "Public transfer requires a public recipient account");
    }
    if (privacyRaw === "shielded" && toType !== "address") {
      throw rpcError(ERROR_CODES.INVALID_PARAMS, "Shielded transfer requires a shielded recipient address");
    }
    return privacyRaw;
  }

  switch (method) {
    case "dusk_getCapabilities": {
      // Before a site connects, it learns nothing of the wallet: not its version, nor the network it's on.
      const known = await isConnected();
      const settings = await getSettings();
      const nodeUrl = String(settings?.nodeUrl ?? "");
      const chainId = chainIdFromNodeUrl(nodeUrl);
      const networkName = networkNameFromNodeUrl(nodeUrl);

      let walletVersion = "";
      try {
        const ext = getExtensionApi();
        walletVersion = String(ext?.runtime?.getManifest?.()?.version ?? "");
      } catch {
        walletVersion = "";
      }

      // Capabilities are public (no permission required).
      return Object.freeze({
        provider: "dusk-wallet",
        ...(known ? { walletVersion, chainId, nodeUrl, networkName } : {}),
        methods: [...DAPP_RPC_METHODS],
        txKinds: [...DAPP_TX_KINDS],
        limits: { ...DAPP_LIMITS },
        features: {
          // dApps must not read shielded state (addresses/balances/sync).
          shieldedRead: false,
          // Transfers *to* shielded recipients are supported.
          shieldedRecipients: true,
          shieldedReceiveAddress: true,
          signMessage: true,
          signTypedData: true,
          signTypedDataVersions: [1],
          signAuth: true,
          contractCallPrivacy: true,
          watchAsset: true,
        },
      });
    }

    case "dusk_requestProfiles": {
      const options = firstParamObject(params);
      await requestProfileConnection(options);
      return siteProfiles();
    }

    case "dusk_profiles":
      return siteProfiles();

    case "dusk_requestShieldedAddress": {
      const options = firstParamObject(params);
      const status0 = await getEngineStatus();
      const existing = await permissionFor(status0);
      const existingProfile = existing && status0?.isUnlocked
        ? profileFromPermission(status0, existing, true)
        : null;
      const { perm, status } = existingProfile && sameProfilePermission(existing, existingProfile) && hasShieldedGrant(existing)
        ? { perm: existing, status: status0 }
        : await requestProfileConnection({
            ...options,
            shieldedReceiveAddress: true,
          });
      const profile = profileFromPermission(status, perm, true);
      if (!profile?.shieldedAddress) {
        throw rpcError(ERROR_CODES.UNAUTHORIZED, "No shielded receive address is available");
      }
      return {
        address: profile.shieldedAddress,
        account: profile.account,
        profileId: profile.profileId,
        chainId: chainIdFromNodeUrl((await getSettings())?.nodeUrl ?? ""),
      };
    }

    case "dusk_openPaymentLink": {
      // Not a connection's: a web wallet hands over its own request, to be reviewed in Send.
      return handOverRequestLink(origin, firstParamObject(params)?.link, { pressed, tabId });
    }

    case "dusk_chainId": {
      // A site learns the network as it connects: null before.
      if (!(await isConnected())) return null;
      const settings = await getSettings();
      return chainIdFromNodeUrl(settings?.nodeUrl ?? "");
    }

    case "dusk_switchNetwork": {
      const perm = await permissionFor();
      if (!perm) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Not connected");

      // Switching networks only makes sense if the wallet exists.
      const vault = await loadVault();
      if (!vault) {
        throw rpcError(
          ERROR_CODES.UNAUTHORIZED,
          "No wallet vault found. Create or import a wallet first."
        );
      }

      // Normalize params: allow object or single-element array.
      let p = params;
      if (Array.isArray(p)) p = p[0];
      if (!p || typeof p !== "object") {
        throw rpcError(
          ERROR_CODES.INVALID_PARAMS,
          "params must be an object (or single-element array) with { chainId } or { nodeUrl }"
        );
      }

      const requestedChainId = String(p.chainId ?? "").trim();
      const requestedNodeUrl = String(p.nodeUrl ?? "").trim();

      let targetNodeUrl = requestedNodeUrl;

      // Map known chain IDs to presets.
      if (!targetNodeUrl) {
        const ref = chainReferenceFromChainId(requestedChainId);
        const presetId =
          ref === "1"
            ? "mainnet"
            : ref === "2"
            ? "testnet"
            : ref === "3"
            ? "devnet"
            : ref === "0"
            ? "local"
            : "";

        if (!presetId) {
          throw rpcError(
            ERROR_CODES.INVALID_PARAMS,
            "Unknown chainId. Use CAIP-2 (dusk:1) or provide { nodeUrl } for custom networks."
          );
        }

        targetNodeUrl =
          NETWORK_PRESETS.find((n) => n.id === presetId)?.nodeUrl ?? "";
      }

      targetNodeUrl = validateNodeUrl(targetNodeUrl);

      const approvalContext = await captureApprovalContext(perm);
      const currentNodeUrl = approvalContext.nodeUrl;
      if (currentNodeUrl === targetNodeUrl) return null;

      const from = {
        chainId: chainIdFromNodeUrl(currentNodeUrl),
        nodeUrl: currentNodeUrl,
        host: nodeHost(currentNodeUrl),
        networkName: networkNameFromNodeUrl(currentNodeUrl),
      };

      const to = {
        chainId: chainIdFromNodeUrl(targetNodeUrl),
        nodeUrl: targetNodeUrl,
        host: nodeHost(targetNodeUrl),
        networkName: networkNameFromNodeUrl(targetNodeUrl),
      };

      // Ask user approval.
      const shown = promptFor(approvalContext);
      await requestUserApproval("switch_network", origin, { from, to }, shown);
      // Then the node's chain ID, fixed with it as Settings fixes a chosen
      // node's: a site's node is asked nothing before the user agreed, and one
      // added before keeps the chain ID it was added with, whatever it says now.
      const chainId = pinnedChainOf(await getSettings(), targetNodeUrl) ?? (await readChainId(targetNodeUrl));
      return withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
        await assertApprovalContext(approvalContext, shown);
        cancelPendingApprovals(null, "Network changed");
        await setSettings({ nodeUrl: targetNodeUrl, chainId });
        invalidateEngineConfig();
        await ensureEngineConfigured();
        broadcastChainChangedAll().catch(() => {});
        return null;
      });
    }

    case "dusk_getPublicBalance": {
      const perm = await permissionFor();
      if (!perm) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Not connected");

      const approvalContext = await captureApprovalContext(perm);
      if (!approvalContext.isUnlocked) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
      // The connected profile's balance alone: a site that names another
      // account or profile is refused, never answered with this one's.
      const asked = Array.isArray(params) ? params[0] : params;
      const askedAccount = typeof asked === "string" ? asked : asked && typeof asked === "object" ? asked.account : undefined;
      const askedProfile = asked && typeof asked === "object" ? asked.profileId : undefined;
      if (
        (askedAccount !== undefined && String(askedAccount) !== approvalContext.account) ||
        (askedProfile !== undefined && String(askedProfile) !== approvalContext.permissionProfileId)
      ) {
        throw rpcError(ERROR_CODES.UNAUTHORIZED, "Only the connected profile's balance can be read");
      }

      return withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
        const executionContext = await assertApprovalContext(approvalContext);
        await ensureEngineConfigured();
        return engineCall("dusk_getPublicBalance", {
          profileIndex: executionContext.profileIndex,
          _approvalContext: executionContext,
        });
      });
    }

    case "dusk_estimateGas": {
      // Gas estimation is public info, but still require connection.
      const perm = await permissionFor();
      if (!perm) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Not connected");

      await ensureEngineConfigured();
      return await engineCall("dusk_estimateGas", params ?? {});
    }

    case "dusk_sendTransaction": {
      const perm = await permissionFor();
      if (!perm) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Not connected");

      if (!params || typeof params !== "object") {
        throw rpcError(ERROR_CODES.INVALID_PARAMS, "params must be an object");
      }

      const kind = String(params.kind || "").toLowerCase();
      if (!kind) {
        throw rpcError(ERROR_CODES.INVALID_PARAMS, "params.kind is required");
      }

      // dApps are only allowed to request a limited set of tx kinds.
      // Shielded conversion and staking flows are wallet-internal.
      if (!DAPP_TX_KINDS.includes(kind)) {
        throw rpcError(
          ERROR_CODES.UNSUPPORTED,
          `Unsupported transaction kind for dApps: ${kind}`
        );
      }

      // The kind as checked, from here on: the approval, the engine and the
      // transaction's record all read this one spelling (txRecord.js).
      let normalizedParams = { ...params, kind };
      if (kind === TX_KIND.TRANSFER) {
        normalizedParams = {
          ...normalizedParams,
          privacy: validateTransferPrivacy(params),
          amount: validateU64(params.amount, "amount", { required: true, allowZero: false }),
          memo: validateMemo(params.memo),
          gas: validateGasShape(params.gas),
        };
      }

      if (kind === TX_KIND.CONTRACT_CALL) {
        if (normalizedParams.memo !== undefined && normalizedParams.memo !== null && normalizedParams.memo !== "") {
          throw rpcError(
            ERROR_CODES.INVALID_PARAMS,
            "memo is not allowed for contract_call (payload is either memo OR contract call)"
          );
        }

        const privacy = String(normalizedParams.privacy ?? "public").trim().toLowerCase();
        if (privacy !== "public" && privacy !== "shielded") {
          throw rpcError(
            ERROR_CODES.INVALID_PARAMS,
            "privacy must be \"public\" or \"shielded\""
          );
        }

        validateFnArgs(normalizedParams.fnArgs);
        normalizedParams = {
          ...normalizedParams,
          privacy,
          contractId: validateContractId(normalizedParams.contractId),
          fnName: validateFnName(normalizedParams.fnName),
          amount: validateU64(normalizedParams.amount, "amount"),
          deposit: validateU64(normalizedParams.deposit, "deposit"),
          gas: validateGasShape(normalizedParams.gas),
        };
      }

      // Fill wallet defaults (standard gas settings) so the user always sees a fee.
      // NOTE: We do this BEFORE approval, so the approval UI can display max fee and total.
      // Fetch live gas price from node (cached for 30s) to use as default.
      await ensureEngineConfigured();
      let dynamicPrice;
      try {
        const gasData = await engineCall("dusk_getCachedGasPrice");
        // Both wallets' one rule: the mempool's median, under a ceiling.
        dynamicPrice = defaultGasPriceOf(gasData).price.toString();
      } catch {
        // Ignore errors, will fall back to static default
      }
      const {
        profileIndex: _ignoredProfileIndex,
        accountIndex: _ignoredAccountIndex,
        // The wallet's own Send's, to call one off: never a site's.
        sendId: _ignoredSendId,
        ...safeNormalizedParams
      } = normalizedParams;
      const baseParams = applyTxDefaultsForRpc(safeNormalizedParams, { dynamicPrice });
      const approvalContext = await captureApprovalContext(perm);
      const approvalNodeUrl = approvalContext.nodeUrl;
      const given = (v) => v !== undefined && v !== null && v !== "";
      const approvalParams = {
        ...baseParams,
        chainId: chainIdFromNodeUrl(approvalNodeUrl),
        nodeUrl: approvalNodeUrl,
        networkName: networkNameFromNodeUrl(approvalNodeUrl),
        // Which of the gas the site chose, for its approval to say so.
        feeFromSite: { limit: given(normalizedParams.gas?.limit), price: given(normalizedParams.gas?.price) },
      };

      // Ask approval (the approval UI also lets the user unlock).
      // The approval can return user overrides (e.g. edited gas settings).
      const shown = promptFor(approvalContext);
      // What the approval sends, as its window answers it.
      const paramsAnswered = (answered) => {
        const params = applyTxDefaultsForRpc(mergeTxParams(baseParams, answered), { dynamicPrice });
        return { ...params, gas: validateGasShape(params.gas) };
      };
      // Above the amount chosen in Settings, the password, checked here against
      // the vault as the window answers: a wrong one leaves the request waiting.
      let passwordFor = null;
      const overrides = await requestUserApproval("send_tx", origin, approvalParams, shown, {
        beforeApprove: async ({ approvedParams, sendPassword }) => {
          const { walletKey } = await getEngineStatusStrict();
          passwordFor = await proveSiteSend(paramsAnswered(approvedParams), { password: sendPassword, walletKey, nodeUrl: approvalNodeUrl });
        },
      });
      // Approved, and then not sent, or maybe not: its site's record says so,
      // and its approval, kept open in a tab, says it in the wallet.
      const sayFailed = (error) => {
        const walletId = shown.walletId || approvalContext.walletId;
        noteSiteSendFailed(walletId, origin, { id: shown.rid, answer: sentOf(error) === false ? "failed" : "unconfirmed" }).catch(() => {});
        sendOutcome(shown.rid, { error });
        throw error;
      };
      return withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
      const executionContext = await assertApprovalContext(approvalContext, shown);
      const finalParams = paramsAnswered(overrides);
      await assertSiteSend(finalParams, passwordFor, executionContext.nodeUrl);

      const idx = executionContext.profileIndex;
      // The engine signs for the chain the node is fixed to now.
      await ensureEngineConfigured();
      // What this send and its watcher keep is dropped after a wallet reset.
      const txEpoch = await getTxEpoch();
      const engineParams = {
        ...finalParams,
        // Never allow a dApp to select an arbitrary local profile.
        profileIndex: idx,
        _approvalContext: executionContext,
        txEpoch,
      };
      const result = await engineCall("dusk_sendTransaction", engineParams);
      const hash = result?.hash ?? "";

      // Persist minimal metadata so we can later show an "executed" notification
      // and link to the right explorer even if the user switches networks.
      try {
        const nodeUrl = executionContext.nodeUrl;
        if (hash) {
          await putTxMeta(
            hash,
            submittedTxMeta(finalParams, { walletId: executionContext.walletId, origin, nodeUrl, profileIndex: idx, nullifiers: result?.nullifiers }, {
              // Where a deposit to DuskEVM pays, the .dusk name a registration
              // registers, and a name's reservation, for Activity: the chain
              // keeps them in the call's bytes.
              bridgeTo: kind === TX_KIND.CONTRACT_CALL ? bridgeDepositRecipient({ ...finalParams, nodeUrl }) : undefined,
              registeredName:
                kind === TX_KIND.CONTRACT_CALL ? registeredNameOf({ ...finalParams, nodeUrl, args: finalParams?.fnArgs }) || undefined : undefined,
              reservation:
                kind === TX_KIND.CONTRACT_CALL
                  ? nameReservationOf({ ...finalParams, nodeUrl, args: finalParams?.fnArgs, account: executionContext.account }) || undefined
                  : undefined,
            }),
            { epoch: txEpoch }
          );
        }

        // Best-effort system notification (extension).
        notifyTxSubmitted({ hash, origin, nodeUrl }).catch(() => {});
      } catch {
        notifyTxSubmitted({ hash, origin }).catch(() => {});
      }
      const response = { hash };
      if (result?.nonce !== undefined && result?.nonce !== null) {
        response.nonce = result.nonce?.toString?.() ?? String(result.nonce);
      }
      // Handed over: its approval's tab goes.
      sendOutcome(shown.rid);
      return response;
      }).catch(sayFailed);
    }

    case "dusk_watchAsset": {
      const perm = await permissionFor();
      if (!perm) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Not connected");

      // Normalize params: allow object or single-element array.
      let p = params;
      if (Array.isArray(p)) p = p[0];
      if (!p || typeof p !== "object") {
        throw rpcError(
          ERROR_CODES.INVALID_PARAMS,
          "params must be an object (or single-element array) with { type, options }"
        );
      }

      const typeRaw = String(p.type ?? "").trim();
      const type = typeRaw.toUpperCase();
      const options = p.options;
      if (!options || typeof options !== "object") {
        throw rpcError(ERROR_CODES.INVALID_PARAMS, "params.options must be an object");
      }

      // Normalize contractId early so the approval UI has a canonical value.
      let contractId;
      try {
        contractId = normalizeContractId(options.contractId);
      } catch {
        throw rpcError(
          ERROR_CODES.INVALID_PARAMS,
          "options.contractId must be a 32-byte hex string (0x + 64 hex chars)"
        );
      }

      // For NFTs tokenId is required.
      let tokenId = null;
      if (type === "DRC721") {
        const raw = String(options.tokenId ?? "").trim();
        if (!raw) throw rpcError(ERROR_CODES.INVALID_PARAMS, "options.tokenId is required for DRC721");
        try {
          const n = BigInt(raw);
          if (n < 0n || n > 18446744073709551615n) throw new Error("range");
          tokenId = n.toString();
        } catch {
          throw rpcError(ERROR_CODES.INVALID_PARAMS, "options.tokenId must be a u64 decimal string");
        }
      }

      if (type !== "DRC20" && type !== "DRC721") {
        throw rpcError(ERROR_CODES.INVALID_PARAMS, `Unsupported asset type: ${typeRaw || "(missing)"}`);
      }

      // Ask the user to approve adding this asset (approval UI includes unlock).
      const approvalContext = await captureApprovalContext(perm);
      const shown = promptFor(approvalContext);
      await requestUserApproval("watch_asset", origin, {
        type,
        options: {
          ...options,
          contractId,
          ...(tokenId ? { tokenId } : {}),
        },
      }, shown);

      return withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
      const executionContext = await assertApprovalContext(approvalContext, shown);
      await ensureEngineConfigured();
      const idx = executionContext.profileIndex;
      const nodeUrl = executionContext.nodeUrl;
      const walletId = executionContext.walletId;
      const account = executionContext.account;

      if (!walletId) throw rpcError(ERROR_CODES.INTERNAL, "Wallet ID unavailable");
      if (!account) throw rpcError(ERROR_CODES.INTERNAL, "Account unavailable");

      if (type === "DRC20") {
        // Verify on-chain metadata via the canonical driver.
        const meta = await engineCall("dusk_getDrc20Metadata", { contractId });
        await watchToken(walletId, nodeUrl, idx, {
          contractId,
          name: meta?.name ?? "",
          symbol: meta?.symbol ?? "",
          decimals: meta?.decimals ?? 0,
        });
        return true;
      }

      // type === "DRC721"
      const meta = await engineCall("dusk_getDrc721Metadata", { contractId });
      const owner = await engineCall("dusk_getDrc721OwnerOf", { contractId, tokenId });
      const owned = Boolean(owner && typeof owner === "object" && owner.External === account);
      if (!owned) {
        throw rpcError(ERROR_CODES.INVALID_PARAMS, "NFT is not owned by the connected account");
      }
      const tokenUri = await engineCall("dusk_getDrc721TokenUri", { contractId, tokenId });

      await watchNft(walletId, nodeUrl, idx, {
        contractId,
        tokenId,
        name: meta?.name ?? "",
        symbol: meta?.symbol ?? "",
        tokenUri: tokenUri ?? "",
      });

      return true;
      });
    }

    case "dusk_signMessage": {
      const perm = await permissionFor();
      if (!perm) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Not connected");

      if (!params || typeof params !== "object") {
        throw rpcError(ERROR_CODES.INVALID_PARAMS, "params must be an object");
      }
      if (!Object.prototype.hasOwnProperty.call(params, "message")) {
        throw rpcError(ERROR_CODES.INVALID_PARAMS, "params.message is required");
      }

      // Compute a stable message hash for the approval UI. The message must
      // be bytes in an explicit encoding: plain text is refused, not guessed
      // at, so the approval shows the bytes the site meant.
      let messageLen = 0;
      let messageHash = "";
      let messagePreview = null;
      try {
        const msgBytes = messageBytes(params.message);
        messageLen = msgBytes.length;
        messageHash = await sha256Hex(msgBytes);
        messagePreview = describeSignMessagePreview(msgBytes);
      } catch {
        throw rpcError(
          ERROR_CODES.INVALID_PARAMS,
          "params.message must be bytes: 0x-hex, base64: followed by base64, or an array of bytes. To sign text, send its UTF-8 bytes as 0x-hex."
        );
      }

      const approvalContext = await captureApprovalContext(perm);
      const chainId = chainIdFromNodeUrl(approvalContext.nodeUrl);

      const shown = promptFor(approvalContext);
      await requestUserApproval("sign_message", origin, {
        chainId,
        messageHash: `0x${messageHash}`,
        messageLen,
        messagePreview,
      }, shown);

      return withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
        const executionContext = await assertApprovalContext(approvalContext, shown);
        await ensureEngineConfigured();
        return engineCall("dusk_signMessage", {
          origin,
          chainId,
          message: params.message,
          profileIndex: executionContext.profileIndex,
          _approvalContext: executionContext,
        });
      });
    }

    case "dusk_signTypedData": {
      // Connection is required up front, same as the sibling sign_* methods -
      // an unconnected origin should not be able to trigger any of the work below.
      const perm = await permissionFor();
      if (!perm) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Not connected");

      // Reject a non-object params before touching its shape any further.
      if (!params || typeof params !== "object") {
        throw rpcError(ERROR_CODES.INVALID_PARAMS, "params must be an object");
      }

      // Version check (spec 14): defaults to 1, and an unknown version is a
      // hard reject rather than a silent fallback, so a caller that precomputed
      // a digest locally gets a clear error instead of a mismatch.
      const version = params.version === undefined ? 1 : params.version;
      if (version !== 1) {
        throw rpcError(ERROR_CODES.INVALID_PARAMS, `Unsupported typed-data version: ${version}`);
      }

      // Build the exact input that will be hashed, with the wallet's own view
      // of `origin`. The dApp MUST NOT be able to influence origin binding
      // (spec 8): any params.origin is dropped here, and the input is assembled
      // field by field rather than by spreading params, so a future field added
      // to the request cannot leak into the digest.
      //
      // Validation runs on this assembled input rather than on raw params.
      // Origin is a field of the hash input (spec 3) and the validator checks
      // it, so validating raw params would demand a caller-supplied origin --
      // exactly the field the docs tell dApps not to send.
      const typedInput = {
        domain: params.domain,
        types: params.types,
        primaryType: params.primaryType,
        message: params.message,
        origin,
      };

      // Initial structural validation (spec 4-10). Map the shared validator's
      // stable error code (E_*) onto INVALID_PARAMS, preserving both the message
      // and the code so a caller/dev can tell which spec 10 rule fired.
      try {
        validateTypedDataParams(typedInput);
      } catch (err) {
        throw rpcError(
          ERROR_CODES.INVALID_PARAMS,
          err?.message || "Invalid typed data params",
          err?.code ? { code: err.code } : undefined
        );
      }

      // Chain check, before approval: a dApp must ask for the chain the
      // wallet is actually on. This also keeps the approval UI from ever
      // showing a chain the wallet cannot act on.
      //
      // The chain comes from the approval context rather than a bare settings
      // read, so the value compared here is the same one re-verified after
      // approval. Note this is the *wallet's* chain, used only to reject a
      // mismatch and to display/echo — the digest binds the dApp's
      // `domain.chainId`, never this.
      const approvalContext = await captureApprovalContext(perm);
      const activeChainId = chainIdFromNodeUrl(approvalContext.nodeUrl);
      const requestedChainId = String(params.domain?.chainId ?? "");
      if (requestedChainId !== activeChainId) {
        throw rpcError(
          ERROR_CODES.INVALID_PARAMS,
          `domain.chainId ${requestedChainId || "(missing)"} does not match active chain ${activeChainId}`
        );
      }

      // Signer-side resource floor (spec 11). Deliberately not part of the
      // hash path - it must never influence the digest - so oversized payloads
      // are rejected here, before the user ever sees an approval popup.
      let digestHex;
      try {
        checkPolicyLimits(typedInput);
        // Hashing completes value validation; translate its errors too.
        digestHex = hashTypedDataHex(typedInput);
      } catch (err) {
        throw rpcError(
          ERROR_CODES.INVALID_PARAMS,
          err?.message || "Invalid typed data params",
          err?.code ? { code: err.code } : undefined
        );
      }

      const { domain, types, primaryType, message } = typedInput;

      // Ask the user to approve.
      const shown = promptFor(approvalContext);
      await requestUserApproval("sign_typed_data", origin, {
        domain,
        types,
        primaryType,
        message,
        chainId: activeChainId,
        digestHex,
      }, shown);

      // Sign under the wallet lifecycle lock, re-verifying that nothing the
      // approval depended on changed while the popup was open. A user can
      // switch network, lock, or change the connected profile mid-approval, and
      // a signature must not outlive the context it was approved under.
      // `assertApprovalContext` covers node URL (hence chain), profile index,
      // permission identity, wallet identity (the prompt's too), and unlock
      // state; the engine re-checks its own view via `_approvalContext`.
      return withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
        const executionContext = await assertApprovalContext(approvalContext, shown);
        await ensureEngineConfigured();

        // The engine wraps this digest with the shared typed-data signature tag.
        const signed = await engineCall("dusk_signTypedData", {
          digestHex,
          profileIndex: executionContext.profileIndex,
          _approvalContext: executionContext,
        });

        // Result shape, spec 13. Echo the wallet's context; verifiers still need
        // the original request and their own expected policy. Normalize hex case.
        return {
          account: signed?.account,
          publicKeyHex: String(signed?.publicKeyHex ?? "").toLowerCase(),
          origin,
          chainId: activeChainId,
          primaryType,
          digestHex: digestHex.toLowerCase(),
          signature: String(signed?.signature ?? "").toLowerCase(),
        };
      });
    }

    case "dusk_signAuth": {
      const perm = await permissionFor();
      if (!perm) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Not connected");

      if (!params || typeof params !== "object") {
        throw rpcError(ERROR_CODES.INVALID_PARAMS, "params must be an object");
      }

      const nonce = String(params.nonce ?? "").trim();
      if (!nonce) {
        throw rpcError(ERROR_CODES.INVALID_PARAMS, "params.nonce is required");
      }
      if (nonce.length > 128) {
        throw rpcError(ERROR_CODES.INVALID_PARAMS, "params.nonce too long (max 128 chars)");
      }

      const statement = params.statement != null ? String(params.statement).trim() : "";
      if (statement.length > 280) {
        throw rpcError(ERROR_CODES.INVALID_PARAMS, "params.statement too long (max 280 chars)");
      }

      let expiresAt = "";
      if (params.expiresAt != null && String(params.expiresAt).trim()) {
        const t = Date.parse(String(params.expiresAt));
        if (!Number.isFinite(t)) {
          throw rpcError(ERROR_CODES.INVALID_PARAMS, "params.expiresAt must be an ISO timestamp");
        }
        expiresAt = new Date(t).toISOString();
      }

      const approvalContext = await captureApprovalContext(perm);
      const chainId = chainIdFromNodeUrl(approvalContext.nodeUrl);

      const shown = promptFor(approvalContext);
      await requestUserApproval("sign_auth", origin, {
        chainId,
        nonce,
        statement,
        expiresAt,
      }, shown);

      return withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
        const executionContext = await assertApprovalContext(approvalContext, shown);
        await ensureEngineConfigured();
        return engineCall("dusk_signAuth", {
          origin,
          chainId,
          nonce,
          statement,
          expiresAt,
          profileIndex: executionContext.profileIndex,
          _approvalContext: executionContext,
        });
      });
    }

    // The site disconnects itself: from every wallet, as it can't tell them apart.
    case "dusk_disconnect": {
      return withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
        cancelPendingApprovals(origin, "Site disconnected");
        await revokeOriginEverywhere(origin);
        return true;
      });
    }

    case "dusk_getAddresses": {
      // Shielded address visibility is intentionally not part of the dApp surface.
      // dApps can still *send* to shielded addresses, but they must not be able
      // to enumerate the user's shielded addresses.
      throw rpcError(
        ERROR_CODES.UNSUPPORTED,
        "dusk_getAddresses is not available to dApps"
      );
    }

    default:
      throw rpcError(ERROR_CODES.METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}
