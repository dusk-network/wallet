import { loadVault } from "../shared/vault.js";
import {
  approveOrigin,
  getPermissionForOrigin,
  revokeOrigin,
} from "../shared/permissions.js";
import { getSettings, setSettings } from "../shared/settings.js";
import { ERROR_CODES, rpcError } from "../shared/errors.js";
import { TX_KIND } from "../shared/constants.js";
import { applyTxDefaults, isCompleteGas } from "../shared/txDefaults.js";
import { chainIdFromNodeUrl, chainReferenceFromChainId } from "../shared/chain.js";
import { networkNameFromNodeUrl } from "../shared/network.js";
import { NETWORK_PRESETS } from "../shared/networkPresets.js";
import { bytesToHex, sha256Hex, toBytes } from "../shared/bytes.js";
import { classifyDuskIdentifier } from "../shared/duskIdentifiers.js";
import { DAPP_LIMITS, DAPP_RPC_METHODS, DAPP_TX_KINDS } from "../shared/providerSurface.js";
import {
  engineCall,
  ensureEngineConfigured,
  getEngineStatus,
  invalidateEngineConfig,
} from "./engineHost.js";
import { requestUserApproval } from "./pending.js";
import { notifyTxSubmitted } from "./txNotify.js";
import { putTxMeta } from "../shared/txStore.js";
import { normalizeContractId, watchToken, watchNft } from "../shared/assetsStore.js";
import {
  broadcastChainChangedAll,
} from "./dappEvents.js";
import { getExtensionApi, runtimeGetURL, tabsCreate } from "../platform/extensionApi.js";

// RPC Handler (from dApps)
export async function handleRpc(origin, request) {
  const { method, params } = request || {};

  const MAX_CALLDATA_BYTES = DAPP_LIMITS.maxFnArgsBytes;
  const MAX_U64 = 18446744073709551615n;

  function nullifierHexes(value) {
    const out = [];
    for (const n of Array.isArray(value) ? value : []) {
      try {
        if (typeof n === "string") {
          const hex = n.trim();
          if (/^[0-9a-fA-F]+$/.test(hex)) out.push(hex.toLowerCase());
          continue;
        }
        const u8 = n instanceof Uint8Array ? n : new Uint8Array(n);
        const hex = bytesToHex(u8);
        if (hex) out.push(hex);
      } catch {
        // ignore invalid nullifier shapes
      }
    }
    return out;
  }

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

  function validateGasShape(gas) {
    if (gas === undefined || gas === null) return gas;
    if (typeof gas !== "object" || Array.isArray(gas)) {
      throw rpcError(ERROR_CODES.INVALID_PARAMS, "gas must be an object with { limit, price } or null");
    }
    if (!isCompleteGas(gas)) {
      throw rpcError(ERROR_CODES.INVALID_PARAMS, "gas must include both limit and price, or neither");
    }
    if (!("limit" in gas) && !("price" in gas)) return gas;
    return {
      ...gas,
      limit: validateU64(gas.limit, "gas.limit", { required: true, allowZero: false }),
      price: validateU64(gas.price, "gas.price", { required: true, allowZero: false }),
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
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("protocol");
      }
      return trimmed;
    } catch {
      throw rpcError(ERROR_CODES.INVALID_PARAMS, "Invalid nodeUrl");
    }
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

    const existing = await getPermissionForOrigin(origin);
    const statusBeforePrompt = await getEngineStatus();
    const selectedProfile = profileFromStatus(
      statusBeforePrompt,
      statusBeforePrompt?.selectedAccountIndex ?? existing?.accountIndex ?? 0,
      false
    );
    const effectiveShieldedGrant =
      requestedShieldedGrant ||
      (sameProfilePermission(existing, selectedProfile) && hasShieldedGrant(existing));

    const approved = await requestUserApproval("connect", origin, {
      requestedProfiles: true,
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
    });

    const status = await getEngineStatus();
    if (!status?.isUnlocked) {
      throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet is still locked. Unlock to access accounts.");
    }

    const arr = Array.isArray(status.accounts) ? status.accounts : [];
    const idx = sanitizeAccountIndex(approved?.accountIndex, arr.length, 0);
    const profile = profileFromStatus(status, idx, false);
    if (!profile) throw rpcError(ERROR_CODES.UNAUTHORIZED, "No wallet profile is available");
    const sameProfile = sameProfilePermission(existing, profile);
    const effectiveGrant = requestedShieldedGrant || (sameProfile && hasShieldedGrant(existing));
    const perm = await approveOrigin(origin, {
      profileId: profile.profileId,
      accountIndex: idx,
      grants: {
        publicAccount: true,
        shieldedReceiveAddress: effectiveGrant,
      },
    });
    return { perm, status };
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
        walletVersion,
        chainId,
        nodeUrl,
        networkName,
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
          signAuth: true,
          contractCallPrivacy: true,
          watchAsset: true,
        },
      });
    }

    case "dusk_requestProfiles": {
      const options = firstParamObject(params);
      const { perm, status } = await requestProfileConnection(options);
      const profile = profileFromStatus(status, perm.accountIndex, hasShieldedGrant(perm));
      return profile ? [profile] : [];
    }

    case "dusk_profiles": {
      const perm = await getPermissionForOrigin(origin);
      if (!perm) return [];
      const status = await getEngineStatus();
      if (!status?.isUnlocked) return [];
      const profile = profileFromStatus(status, perm.accountIndex, hasShieldedGrant(perm));
      return profile ? [profile] : [];
    }

    case "dusk_requestShieldedAddress": {
      const options = firstParamObject(params);
      const existing = await getPermissionForOrigin(origin);
      const status0 = await getEngineStatus();
      const existingProfile = existing && status0?.isUnlocked
        ? profileFromStatus(status0, existing.accountIndex, true)
        : null;
      const { perm, status } = existingProfile && sameProfilePermission(existing, existingProfile) && hasShieldedGrant(existing)
        ? { perm: existing, status: status0 }
        : await requestProfileConnection({
            ...options,
            shieldedReceiveAddress: true,
          });
      const profile = profileFromStatus(status, perm.accountIndex, true);
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

    case "dusk_chainId": {
      const settings = await getSettings();
      return chainIdFromNodeUrl(settings?.nodeUrl ?? "");
    }

    case "dusk_switchNetwork": {
      const perm = await getPermissionForOrigin(origin);
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

      const settings = await getSettings();
      const currentNodeUrl = String(settings?.nodeUrl ?? "");
      if (currentNodeUrl === targetNodeUrl) return null;

      const from = {
        chainId: chainIdFromNodeUrl(currentNodeUrl),
        nodeUrl: currentNodeUrl,
        networkName: networkNameFromNodeUrl(currentNodeUrl),
      };

      const to = {
        chainId: chainIdFromNodeUrl(targetNodeUrl),
        nodeUrl: targetNodeUrl,
        networkName: networkNameFromNodeUrl(targetNodeUrl),
      };

      // Ask user approval.
      await requestUserApproval("switch_network", origin, { from, to });

      // Apply new settings and reconfigure engine.
      await setSettings({ nodeUrl: targetNodeUrl });
      invalidateEngineConfig();
      await ensureEngineConfigured();

      // Notify all dApps that chain changed.
      broadcastChainChangedAll().catch(() => {});

      return null;
    }

    case "dusk_getPublicBalance": {
      const perm = await getPermissionForOrigin(origin);
      if (!perm) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Not connected");

      const { isUnlocked, accounts } = await getEngineStatus();
      if (!isUnlocked) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");

      await ensureEngineConfigured();
      const arr = Array.isArray(accounts) ? accounts : [];
      return await engineCall("dusk_getPublicBalance", {
        profileIndex: sanitizeAccountIndex(perm.accountIndex, arr.length, 0),
      });
    }

    case "dusk_estimateGas": {
      // Gas estimation is public info, but still require connection.
      const perm = await getPermissionForOrigin(origin);
      if (!perm) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Not connected");

      await ensureEngineConfigured();
      return await engineCall("dusk_estimateGas", params ?? {});
    }

    case "dusk_sendTransaction": {
      const perm = await getPermissionForOrigin(origin);
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

      let normalizedParams = params;
      if (kind === TX_KIND.TRANSFER) {
        normalizedParams = {
          ...params,
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
        // Use median as a balanced default - not too aggressive, not too cheap
        dynamicPrice = gasData?.median;
      } catch {
        // Ignore errors, will fall back to static default
      }
      const {
        profileIndex: _ignoredProfileIndex,
        accountIndex: _ignoredAccountIndex,
        ...safeNormalizedParams
      } = normalizedParams;
      const baseParams = applyTxDefaults(safeNormalizedParams, { dynamicPrice });
      const approvalSettings = await getSettings();
      const approvalNodeUrl = String(approvalSettings?.nodeUrl ?? "");
      const approvalParams = {
        ...baseParams,
        chainId: chainIdFromNodeUrl(approvalNodeUrl),
        nodeUrl: approvalNodeUrl,
        networkName: networkNameFromNodeUrl(approvalNodeUrl),
      };

      // Ask approval (the approval UI also lets the user unlock).
      // The approval can return user overrides (e.g. edited gas settings).
      const overrides = await requestUserApproval("send_tx", origin, approvalParams);
      const finalParams = mergeTxParams(baseParams, overrides);
      finalParams.gas = validateGasShape(finalParams.gas);

      const { isUnlocked, accounts } = await getEngineStatus();
      if (!isUnlocked) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");

      const arr = Array.isArray(accounts) ? accounts : [];
      const idx = sanitizeAccountIndex(perm.accountIndex, arr.length, 0);

      const engineParams = {
        ...finalParams,
        // Never allow a dApp to select an arbitrary local profile.
        profileIndex: idx,
      };
      const result = await engineCall("dusk_sendTransaction", engineParams);
      const hash = result?.hash ?? "";

      // Persist minimal metadata so we can later show an "executed" notification
      // and link to the right explorer even if the user switches networks.
      try {
        const settings = await getSettings();
        const nodeUrl = settings?.nodeUrl ?? "";
        if (hash) {
          const pendingNullifiers = nullifierHexes(result?.nullifiers);
          await putTxMeta(hash, {
            origin,
            nodeUrl,
            kind,
            privacy: finalParams?.privacy ? String(finalParams.privacy) : undefined,
            profileIndex: idx,
            // Helpful fields for the Activity list UI
            to: finalParams?.to ? String(finalParams.to) : undefined,
            amount:
              finalParams?.amount !== undefined && finalParams?.amount !== null
                ? String(finalParams.amount)
                : undefined,
            deposit:
              finalParams?.deposit !== undefined && finalParams?.deposit !== null
                ? String(finalParams.deposit)
                : undefined,
            contractId:
              kind === TX_KIND.CONTRACT_CALL && finalParams?.contractId
                ? String(finalParams.contractId)
                : undefined,
            fnName:
              kind === TX_KIND.CONTRACT_CALL && finalParams?.fnName
                ? String(finalParams.fnName)
                : undefined,
            gasLimit: finalParams?.gas?.limit != null ? String(finalParams.gas.limit) : undefined,
            gasPrice: finalParams?.gas?.price != null ? String(finalParams.gas.price) : undefined,
            pendingNullifiers,
            reservationStatus: pendingNullifiers.length ? "pending" : undefined,
            reservationUpdatedAt: pendingNullifiers.length ? Date.now() : undefined,
            submittedAt: Date.now(),
            status: "submitted",
          });
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
      return response;
    }

    case "dusk_watchAsset": {
      const perm = await getPermissionForOrigin(origin);
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
      await requestUserApproval("watch_asset", origin, {
        type,
        options: {
          ...options,
          contractId,
          ...(tokenId ? { tokenId } : {}),
        },
      });

      const { isUnlocked, accounts } = await getEngineStatus();
      if (!isUnlocked) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");

      await ensureEngineConfigured();
      const arr = Array.isArray(accounts) ? accounts : [];
      const idx = sanitizeAccountIndex(perm.accountIndex, arr.length, 0);

      const settings = await getSettings();
      const nodeUrl = settings?.nodeUrl ?? "";
      const walletId = String(arr?.[0] ?? "").trim();
      const account = String(arr?.[idx] ?? "").trim();

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
    }

    case "dusk_signMessage": {
      const perm = await getPermissionForOrigin(origin);
      if (!perm) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Not connected");

      if (!params || typeof params !== "object") {
        throw rpcError(ERROR_CODES.INVALID_PARAMS, "params must be an object");
      }
      if (!Object.prototype.hasOwnProperty.call(params, "message")) {
        throw rpcError(ERROR_CODES.INVALID_PARAMS, "params.message is required");
      }

      // Compute a stable message hash for the approval UI.
      let messageLen = 0;
      let messageHash = "";
      try {
        const msgBytes = toBytes(params.message);
        messageLen = msgBytes.length;
        messageHash = await sha256Hex(msgBytes);
      } catch {
        throw rpcError(
          ERROR_CODES.INVALID_PARAMS,
          "params.message must be bytes (hex string, base64 string, Uint8Array, ArrayBuffer, or number[])"
        );
      }

      const settings = await getSettings();
      const chainId = chainIdFromNodeUrl(settings?.nodeUrl ?? "");

      await requestUserApproval("sign_message", origin, {
        chainId,
        messageHash: `0x${messageHash}`,
        messageLen,
      });

      const { isUnlocked, accounts } = await getEngineStatus();
      if (!isUnlocked) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");

      await ensureEngineConfigured();
      const arr = Array.isArray(accounts) ? accounts : [];
      return await engineCall("dusk_signMessage", {
        origin,
        chainId,
        message: params.message,
        profileIndex: sanitizeAccountIndex(perm.accountIndex, arr.length, 0),
      });
    }

    case "dusk_signAuth": {
      const perm = await getPermissionForOrigin(origin);
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

      const settings = await getSettings();
      const chainId = chainIdFromNodeUrl(settings?.nodeUrl ?? "");

      await requestUserApproval("sign_auth", origin, {
        chainId,
        nonce,
        statement,
        expiresAt,
      });

      const { isUnlocked, accounts } = await getEngineStatus();
      if (!isUnlocked) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");

      await ensureEngineConfigured();
      const arr = Array.isArray(accounts) ? accounts : [];
      return await engineCall("dusk_signAuth", {
        origin,
        chainId,
        nonce,
        statement,
        expiresAt,
        profileIndex: sanitizeAccountIndex(perm.accountIndex, arr.length, 0),
      });
    }

    case "dusk_disconnect": {
      await revokeOrigin(origin);
      return true;
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
