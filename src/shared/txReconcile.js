// What the node says of a transaction the wallet sent, written on its record:
// in a block (and how it went), waiting in the mempool, or not found. For the
// background's watcher events and rechecks, and the app's (localBus.js).

import { getSettings } from "./settings.js";
import { classifyTxPresence, finalizedTxMetadata, handedOverState } from "./txLifecycle.js";
import { forgetTxs, getTxEpoch, getTxMeta, patchTxMeta as patchStored } from "./txStore.js";

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
  // Nothing kept to reconcile: forgotten once the chain's history had it (as
  // Activity settles a send, in any window), or cleared by a reset. Where it
  // stands is still asked of the node the wallet's on, and nothing written:
  // the Sent screen still hears its block and fee (Lena's, third time:
  // "Completed … Network fee Up to 0,0025" for good, Home opened meanwhile).
  if (!meta) return presenceOnly(hash);
  const patchTxMeta = (h, patch) => patchStored(h, patch, { epoch });
  const settings = await getSettings();
  const nodeUrl = meta?.nodeUrl ?? settings?.nodeUrl ?? "";
  const origin = meta?.origin ?? "Wallet";
  const now = Date.now();
  const terminalStatus = meta?.status === "executed" || meta?.status === "failed"
    ? meta.status
    : "";
  // Not sent, as another of its account's transactions took its nonce: it
  // never will go, and it's said so for good (Astra's: looked up again, it
  // went back to "Not confirmed yet" for good).
  if (meta.status === "not_sent") {
    await patchTxMeta(hash, { lastCheckedAt: now });
    return { status: "not_sent", origin, nodeUrl };
  }
  // Don't send, on one handed over with no clear answer (`dontSendAt`): it may
  // still arrive, and is followed till its nonce is used. Used by it, it went
  // after all, Sent, as the store marks it as its outcome's written
  // (`wentAfterAll`, txStore.js), the page told so once; by another, it never
  // will, and its record goes.
  const afterAll = (stored) => (stored?.wentAfterAll && !meta.wentAfterAll ? { wentAfterAll: true } : {});

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
    const stored = await patchTxMeta(hash, {
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
      ...afterAll(stored),
    };
  }

  if (presence.state === "executed_failed") {
    const finalized = finalizedTxMetadata(presence.tx);
    const stored = await patchTxMeta(hash, {
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
      ...afterAll(stored),
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

  if (presence.state === "not_found" && meta.dontSendAt) {
    const where = meta.account && /^\d+$/.test(String(meta.nonce ?? ""))
      ? (await handedOverState(nodeUrl, { hash, account: meta.account, nonce: meta.nonce, at: meta.submittedAt }).catch(() => null))?.state
      : null;
    if (where === "replaced") {
      await forgetTxs([hash], { epoch });
      return { status: "not_sent", origin, nodeUrl };
    }
    await patchTxMeta(hash, { lastCheckedAt: now });
    return { status: meta.status, origin, nodeUrl };
  }

  if (presence.state === "not_found") {
    // A public send handed over without a clear answer, kept as it was signed
    // (txRecord.js signedTxFields): nowhere and its nonce unused, the node
    // never had it, and it's Not sent yet, which Send it now sends again as it
    // is; the account's transaction at its nonce another, it never will go
    // (Chen's: "Not confirmed yet" for good, with nothing to tap, though the
    // node never had it). Its nonce gone past it, nothing seen at it yet, it's
    // looked up again as before.
    const unsent = meta?.signedTx && meta?.account && /^\d+$/.test(String(meta?.nonce ?? ""))
      ? (await handedOverState(nodeUrl, { hash, account: meta.account, nonce: meta.nonce, at: meta.submittedAt }).catch(() => null))?.state
      : null;
    if (unsent === "absent" || unsent === "replaced") {
      const status = unsent === "absent" ? "unsent" : "not_sent";
      await patchTxMeta(hash, {
        status,
        lastCheckedAt: now,
        recoveryReason: unsent === "absent" ? "not_reached" : "replaced",
        ...(unsent === "replaced" ? { signedTx: undefined } : {}),
      });
      return { status, origin, nodeUrl };
    }
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

// Where a transaction no record is kept of stands, as the node the wallet's on
// says it: in a block, with its fee, or not known here.
async function presenceOnly(hash) {
  const nodeUrl = String((await getSettings().catch(() => null))?.nodeUrl ?? "");
  const presence = nodeUrl ? await classifyTxPresence(nodeUrl, hash) : null;
  if (presence?.state === "executed_success" || presence?.state === "executed_failed") {
    const failed = presence.state === "executed_failed";
    return { status: failed ? "failed" : "executed", ok: !failed, origin: "Wallet", nodeUrl, error: failed ? presence.error || "" : "", ...finalizedTxMetadata(presence.tx) };
  }
  return { status: "unknown", origin: "Wallet", nodeUrl: "", error: "" };
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
      // Its block and fee, as the node has them now: Sent says the fee charged, not the most it could be.
      ...(reconciled.feePaid ? { feePaid: reconciled.feePaid } : {}),
      ...(reconciled.blockHeight ? { blockHeight: reconciled.blockHeight } : {}),
    },
  };
}
