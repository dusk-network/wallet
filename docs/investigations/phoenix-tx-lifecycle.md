# Phoenix Transaction Lifecycle

This note records the v0.1 wallet policy for Phoenix transaction status and
local pending-nullifier reservations.

## Statuses

Wallet-local transaction metadata may use:

| Status | Meaning |
| --- | --- |
| `submitted` | Wallet has a transaction hash, but no later network evidence yet. |
| `mempool` | Best-effort GraphQL reconciliation observed the hash in node mempool. |
| `executed` | The node reported execution without an error. |
| `failed` | Submission/preverify failed, or execution reported an error. Watcher timeout is not failure. |
| `removed` | A removed event was observed, or reconciliation after that event did not find the tx. |
| `unknown` | Watcher timed out or reconciliation could not prove chain/mempool state. |

User-facing copy must not tell users to retry or raise gas for `unknown`
Phoenix transactions. A tx can still be live in mempool after the wallet
watcher times out.

## Phoenix Reservations

Phoenix spends reserve local nullifiers after successful submission so the
wallet does not build another transaction with the same notes while the first
transaction may still be live.

Reservation metadata is separate from transaction status:

| Reservation | Meaning |
| --- | --- |
| `pending` | Local nullifiers remain excluded from spendable notes. |
| `spent` | Future state for sync-proven spent nullifiers. |
| `recoverable` | Removed/unknown evidence suggests review may be needed, but notes are still not spendable. |
| `released` | Future/manual state after an explicit release flow. |

The wallet does not automatically clear Phoenix pending reservations on watcher
timeout or after one missing mempool poll. `markNullifiersSpent()` still clears
pending rows only when shielded sync proves the nullifier spent.

## APIs Used

Finalized transaction lookup:

```graphql
query {
  tx(hash: "...") {
    id
    err
    gasSpent
    blockHash
    blockHeight
    tx { gasLimit gasPrice txType memo }
  }
}
```

Best-effort mempool lookup:

```graphql
query {
  mempoolTxs {
    id
    gasLimit
    gasPrice
    txType
    memo
    json
  }
}
```

Runtime watchers use `executed` and, when exposed by the current w3sper/node
surface, `removed`. If `removed` is unavailable, timeout falls back to
`unknown` plus GraphQL reconciliation.

## Remaining Work

- Add a deliberate manual review/release flow for stale local Phoenix
  reservations.
- Decide whether to poll `mempoolTxs` periodically for long-running pending
  Phoenix transactions.
- Avoid using mempool JSON nullifiers as a required source of truth until that
  shape is explicitly documented/stable.
- Do not implement replace-by-fee in wallet v0.1 unless node semantics are
  specified.
