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
import { sha256Hex, toBytes } from "../shared/bytes.js";
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
import {
  broadcastChainChangedAll,
} from "./dappEvents.js";
import { getExtensionApi, runtimeGetURL, tabsCreate } from "../platform/extensionApi.js";

// RPC Handler (from dApps)
export async function handleRpc(origin, request) {
  const { method, params } = request || {};

  const MAX_CALLDATA_BYTES = DAPP_LIMITS.maxFnArgsBytes;

  function estimateBytes(v) {
    if (v == null) return 0;
    if (Array.isArray(v)) return v.length;
    if (typeof v === "string") {
      let s = v.trim();
      if (s.startsWith("0x") || s.startsWith("0X")) s = s.slice(2);
      // hex
      if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return s.length / 2;
      // base64-ish estimate
      s = s.replace(/^base64:/i, "");
      return Math.floor((s.length * 3) / 4);
    }
    return null;
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
          signMessage: true,
          signAuth: true,
          contractCallPrivacy: true,
        },
      });
    }

    case "dusk_requestAccounts": {
      // If the wallet isn't set up yet, don't even show a connect prompt.
      // MetaMask forces onboarding first, so we do the same.
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

      // If the site is already connected and the wallet is unlocked, return the
      // currently permitted account without prompting again.
      const existing = await getPermissionForOrigin(origin);
      const st0 = await getEngineStatus();
      if (existing && st0?.isUnlocked) {
        const arr = Array.isArray(st0.accounts) ? st0.accounts : [];
        const idx = sanitizeAccountIndex(existing.accountIndex, arr.length, 0);
        return arr[idx] ? [arr[idx]] : [];
      }

      // Ask the user to connect this origin (approval UI includes unlock).
      const approved = await requestUserApproval("connect", origin, { requestedAccounts: true });

      const { isUnlocked, accounts } = await getEngineStatus();
      if (!isUnlocked) {
        throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet is still locked. Unlock to access accounts.");
      }

      const arr = Array.isArray(accounts) ? accounts : [];
      const idx = sanitizeAccountIndex(approved?.accountIndex, arr.length, 0);

      // If user approved, origin is now whitelisted with the chosen account.
      await approveOrigin(origin, idx);

      // Expose the permitted account only (MetaMask-style array).
      return arr[idx] ? [arr[idx]] : [];
    }

    case "dusk_accounts": {
      const perm = await getPermissionForOrigin(origin);
      if (!perm) return [];

      const { isUnlocked, accounts } = await getEngineStatus();
      if (!isUnlocked) return [];
      const arr = Array.isArray(accounts) ? accounts : [];
      const idx = sanitizeAccountIndex(perm.accountIndex, arr.length, 0);
      return arr[idx] ? [arr[idx]] : [];
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

      // Validate nodeUrl
      try {
        // eslint-disable-next-line no-new
        new URL(targetNodeUrl);
      } catch {
        throw rpcError(ERROR_CODES.INVALID_PARAMS, "Invalid nodeUrl");
      }

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

      if (kind === TX_KIND.CONTRACT_CALL) {
        if (params.memo) {
          throw rpcError(
            ERROR_CODES.INVALID_PARAMS,
            "memo is not allowed for contract_call (payload is either memo OR contract call)"
          );
        }

        const privacy = String(params.privacy ?? "public").trim().toLowerCase();
        if (privacy !== "public" && privacy !== "shielded") {
          throw rpcError(
            ERROR_CODES.INVALID_PARAMS,
            "privacy must be \"public\" or \"shielded\""
          );
        }

        const est = estimateBytes(params.fnArgs);
        if (typeof est === "number" && est > MAX_CALLDATA_BYTES) {
          throw rpcError(
            ERROR_CODES.INVALID_PARAMS,
            `fnArgs too large (max ${MAX_CALLDATA_BYTES} bytes)`
          );
        }
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
      const baseParams = applyTxDefaults(params, { dynamicPrice });

      // Ask approval (the approval UI also lets the user unlock).
      // The approval can return user overrides (e.g. edited gas settings).
      const overrides = await requestUserApproval("send_tx", origin, baseParams);
      const finalParams = mergeTxParams(baseParams, overrides);

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
          await putTxMeta(hash, {
            origin,
            nodeUrl,
            kind,
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
            submittedAt: Date.now(),
            status: "submitted",
          });
        }

        // Best-effort system notification (extension).
        notifyTxSubmitted({ hash, origin, nodeUrl }).catch(() => {});
      } catch {
        notifyTxSubmitted({ hash, origin }).catch(() => {});
      }
      return result;
    }

    case "dusk_signMessage": {
      const perm = await getPermissionForOrigin(origin);
      if (!perm) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Not connected");

      if (!params || typeof params !== "object") {
        throw rpcError(ERROR_CODES.INVALID_PARAMS, "params must be an object");
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

      const settings = await getSettings();
      const chainId = chainIdFromNodeUrl(settings?.nodeUrl ?? "");

      await requestUserApproval("sign_auth", origin, {
        chainId,
        nonce,
        statement: params.statement ?? "",
      });

      const { isUnlocked, accounts } = await getEngineStatus();
      if (!isUnlocked) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");

      await ensureEngineConfigured();
      const arr = Array.isArray(accounts) ? accounts : [];
      return await engineCall("dusk_signAuth", {
        origin,
        chainId,
        nonce,
        statement: params.statement ?? "",
        expiresAt: params.expiresAt ?? "",
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
