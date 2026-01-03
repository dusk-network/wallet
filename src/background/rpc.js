import { loadVault } from "../shared/vault.js";
import {
  approveOrigin,
  getPermissionForOrigin,
  revokeOrigin,
} from "../shared/permissions.js";
import { getSettings, setSettings } from "../shared/settings.js";
import { ERROR_CODES, rpcError } from "../shared/errors.js";
import { applyTxDefaults, isCompleteGas } from "../shared/txDefaults.js";
import { chainIdFromNodeUrl } from "../shared/chain.js";
import { networkNameFromNodeUrl } from "../shared/network.js";
import { NETWORK_PRESETS } from "../shared/networkPresets.js";
import {
  engineCall,
  ensureEngineConfigured,
  getEngineStatus,
  invalidateEngineConfig,
} from "./offscreen.js";
import { requestUserApproval } from "./pending.js";
import { notifyTxSubmitted } from "./txNotify.js";
import { putTxMeta } from "../shared/txStore.js";
import {
  broadcastAccountsChangedForOrigin,
  broadcastChainChangedAll,
  broadcastToOrigin,
} from "./dappEvents.js";

// RPC Handler (from dApps)
export async function handleRpc(origin, request) {
  const { method, params } = request || {};

  const MAX_CALLDATA_BYTES = 128 * 1024;

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
    // - true: legacy approve value
    // - object: overrides
    if (!override || override === true || typeof override !== "object") {
      return base;
    }

    const out = { ...base, ...override };
    out.gas = mergeGas(base.gas, override.gas);
    return out;
  }

  switch (method) {
    case "dusk_requestAccounts": {
      // If the wallet isn't set up yet, don't even show a connect prompt.
      // MetaMask forces onboarding first, so we do the same.
      const vault = await loadVault();
      if (!vault) {
        try {
          const url = chrome.runtime.getURL("full.html");
          chrome.tabs.create({ url });
        } catch {
          // ignore
        }
        throw rpcError(
          ERROR_CODES.UNAUTHORIZED,
          "Wallet not set up. Create or import a recovery phrase first."
        );
      }

      // Ask the user to connect this origin.
      await requestUserApproval("connect", origin, { requestedAccounts: true });

      // If user approved, origin is now whitelisted.
      await approveOrigin(origin, 0);

      // Notify provider listeners in this origin that a connection was established.
      try {
        const settings = await getSettings();
        const chainId = chainIdFromNodeUrl(settings?.nodeUrl ?? "");
        broadcastToOrigin(origin, "connect", { chainId });
        // Also push accounts availability (will be [] if still locked).
        await broadcastAccountsChangedForOrigin(origin);
      } catch {
        // ignore
      }

      const { isUnlocked, accounts } = await getEngineStatus();
      if (!isUnlocked) {
        // User approved but wallet is still locked, treat as unauthorized.
        throw rpcError(
          ERROR_CODES.UNAUTHORIZED,
          "Wallet is still locked. Unlock to access accounts."
        );
      }
      // Expose the permitted account only (MetaMask-style).
      const arr = Array.isArray(accounts) ? accounts : [];
      return arr.length ? [arr[0]] : [];
    }

    case "dusk_accounts": {
      const perm = await getPermissionForOrigin(origin);
      if (!perm) return [];

      const { isUnlocked, accounts } = await getEngineStatus();
      if (!isUnlocked) return [];
      const arr = Array.isArray(accounts) ? accounts : [];
      return arr.length ? [arr[0]] : [];
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
        const cid = requestedChainId.toLowerCase();
        const presetId =
          cid === "0x1"
            ? "mainnet"
            : cid === "0x2"
            ? "testnet"
            : cid === "0x3"
            ? "devnet"
            : cid === "0x0"
            ? "local"
            : "";

        if (!presetId) {
          throw rpcError(
            ERROR_CODES.INVALID_PARAMS,
            "Unknown chainId. Provide { nodeUrl } for custom networks."
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

      const { isUnlocked } = await getEngineStatus();
      if (!isUnlocked) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");

      await ensureEngineConfigured();
      return await engineCall("dusk_getPublicBalance");
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

      if (kind === "contract_call") {
        if (params.memo) {
          throw rpcError(
            ERROR_CODES.INVALID_PARAMS,
            "memo is not allowed for contract_call (payload is either memo OR contract call)"
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
      const baseParams = applyTxDefaults(params);

      // Ask approval (the approval UI also lets the user unlock).
      // The approval can return user overrides (e.g. edited gas settings).
      const overrides = await requestUserApproval("send_tx", origin, baseParams);
      const finalParams = mergeTxParams(baseParams, overrides);

      const { isUnlocked } = await getEngineStatus();
      if (!isUnlocked) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");

      await ensureEngineConfigured();
      const result = await engineCall("dusk_sendTransaction", finalParams);
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
              kind === "contract_call" && finalParams?.contractId
                ? String(finalParams.contractId)
                : undefined,
            fnName:
              kind === "contract_call" && finalParams?.fnName
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

    case "dusk_disconnect": {
      await revokeOrigin(origin);

      // Notify provider listeners for this origin.
      try {
        broadcastToOrigin(origin, "disconnect", {
          code: 4900,
          message: "Disconnected",
        });
        await broadcastAccountsChangedForOrigin(origin);
      } catch {
        // ignore
      }
      return true;
    }

    case "dusk_getAddresses": {
      const perm = await getPermissionForOrigin(origin);
      if (!perm) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Not connected");

      const { isUnlocked } = await getEngineStatus();
      if (!isUnlocked) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");

      return await engineCall("dusk_getAddresses");
    }

    default:
      throw rpcError(ERROR_CODES.METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}
