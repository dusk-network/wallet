// What the node says of a transaction the wallet sent, written on its record:
// in a block (and how it went), waiting in the mempool, or not found. For the
// background's watcher events and rechecks, and the app's (localBus.js).

import { getSettings } from "./settings.js";
import { classifyTxPresence, finalizedTxMetadata } from "./txLifecycle.js";
import { getTxEpoch, getTxMeta, patchTxMeta as patchStored } from "./txStore.js";

export function isShieldedTxMeta(meta) {
  return (
    String(meta?.privacy ?? "") === "shielded" ||
    (Array.isArray(meta?.pendingNullifiers) && meta.pendingNullifiers.length > 0)
  );
}

/**
 * @param {string} hash
 * @param {{ preserveRemoved?: boolean, epoch?: number }} [opts] - `epoch`: the
 *   store's reset count when the work began; after a reset since, nothing is kept
 */
export async function reconcileTxPresence(hash, { preserveRemoved = false, epoch } = {}) {
  const meta = await getTxMeta(hash);
  // Nothing kept to reconcile: cleared by a reset, or never this wallet's.
  if (!meta) return { status: "unknown", origin: "Wallet", nodeUrl: "", error: "" };
  const patchTxMeta = (h, patch) => patchStored(h, patch, { epoch });
  const settings = await getSettings();
  const nodeUrl = meta?.nodeUrl ?? settings?.nodeUrl ?? "";
  const origin = meta?.origin ?? "Wallet";
  const now = Date.now();
  const terminalStatus = meta?.status === "executed" || meta?.status === "failed"
    ? meta.status
    : "";

  if (!nodeUrl && terminalStatus) {
    await patchTxMeta(hash, { lastCheckedAt: now });
    return {
      status: terminalStatus,
      ok: terminalStatus === "executed",
      origin,
      nodeUrl,
      error: meta?.error || "",
    };
  }

  if (!nodeUrl) {
    const status = preserveRemoved ? meta?.status ?? "unknown" : "unknown";
    await patchTxMeta(hash, {
      status,
      lastCheckedAt: now,
      recoveryReason: "node_url_missing",
    });
    return { status, origin, nodeUrl, error: "node_url_missing" };
  }

  const presence = await classifyTxPresence(nodeUrl, hash) ?? {
    state: "unavailable",
    error: "reconciliation_unavailable",
  };
  if (presence.state === "executed_success") {
    const finalized = finalizedTxMetadata(presence.tx);
    const failed = terminalStatus === "failed";
    await patchTxMeta(hash, {
      ...finalized,
      status: failed ? "failed" : "executed",
      error: failed ? meta?.error : undefined,
      executedAt: now,
      lastCheckedAt: now,
      reservationStatus: isShieldedTxMeta(meta) ? "spent" : meta?.reservationStatus,
      reservationUpdatedAt: isShieldedTxMeta(meta) ? now : meta?.reservationUpdatedAt,
    });
    return {
      status: failed ? "failed" : "executed",
      ok: !failed,
      origin,
      nodeUrl,
      error: failed ? meta?.error || "" : "",
      ...finalized,
    };
  }

  if (presence.state === "executed_failed") {
    const finalized = finalizedTxMetadata(presence.tx);
    await patchTxMeta(hash, {
      ...finalized,
      status: "failed",
      error: presence.error || undefined,
      executedAt: now,
      lastCheckedAt: now,
      reservationStatus: isShieldedTxMeta(meta) ? "spent" : meta?.reservationStatus,
      reservationUpdatedAt: isShieldedTxMeta(meta) ? now : meta?.reservationUpdatedAt,
    });
    return {
      status: "failed",
      ok: false,
      origin,
      nodeUrl,
      error: presence.error || "",
      ...finalized,
    };
  }

  if (terminalStatus) {
    await patchTxMeta(hash, { lastCheckedAt: now });
    return {
      status: terminalStatus,
      ok: terminalStatus === "executed",
      origin,
      nodeUrl,
      error: meta?.error || "",
    };
  }

  if (presence.state === "mempool") {
    await patchTxMeta(hash, {
      status: "mempool",
      error: undefined,
      mempoolSeenAt: now,
      lastCheckedAt: now,
      reservationStatus: isShieldedTxMeta(meta) ? "pending" : meta?.reservationStatus,
    });
    return { status: "mempool", origin, nodeUrl };
  }

  if (presence.state === "not_found") {
    const confirmedRemoved = preserveRemoved && (
      meta?.recoveryReason === "removed_unconfirmed" || meta?.status === "removed"
    );
    const status = confirmedRemoved ? "removed" : "unknown";
    await patchTxMeta(hash, {
      status,
      lastCheckedAt: now,
      recoveryReason: preserveRemoved
        ? confirmedRemoved ? "removed" : "removed_unconfirmed"
        : "not_found",
      reservationStatus: confirmedRemoved && isShieldedTxMeta(meta)
        ? "recoverable"
        : meta?.reservationStatus,
      removedAt: confirmedRemoved ? now : meta?.removedAt,
      reservationUpdatedAt:
        confirmedRemoved && isShieldedTxMeta(meta) ? now : meta?.reservationUpdatedAt,
    });
    return { status, origin, nodeUrl };
  }

  const confirmedRemoved = preserveRemoved && meta?.status === "removed";
  const status = confirmedRemoved ? "removed" : "unknown";
  await patchTxMeta(hash, {
    status,
    lastCheckedAt: now,
    recoveryReason: preserveRemoved
      ? confirmedRemoved ? "removed" : "removed_unconfirmed"
      : presence.error || "reconciliation_unavailable",
  });
  return {
    status,
    origin,
    nodeUrl,
    error: presence.error || "reconciliation_unavailable",
  };
}

/**
 * Looks a sent transaction up again by its ID, now: its record as the node
 * says it, and the status event for the page.
 * @param {string} hash
 */
export async function recheckTx(hash) {
  const epoch = await getTxEpoch();
  const meta = await getTxMeta(hash);
  const reconciled = await reconcileTxPresence(hash, {
    preserveRemoved:
      meta?.status === "removed" || meta?.recoveryReason === "removed_unconfirmed",
    epoch,
  });
  return {
    reconciled,
    event: {
      hash,
      status: reconciled.status || meta?.status || "unknown",
      ok: reconciled.status === "executed" ? true : reconciled.status === "failed" ? false : undefined,
      error: reconciled.error,
    },
  };
}
