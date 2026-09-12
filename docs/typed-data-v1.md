# Typed-data signing

Wallet uses [`@dusk/typed-data`](https://github.com/dusk-network/typed-data) for validation, hashing, signer resource limits and tagged-message construction. The shared library owns the [specification](https://github.com/dusk-network/typed-data/blob/main/docs/typed-data-v1.md), encoder and vector corpus; Wallet has no second encoder or vendored corpus.

Wallet owns keys and signing, trusted origin/chain checks, permissions and account selection, RPC error translation, approval display and lifecycle rechecks. Display clipping never changes the signed input. See [the provider API](provider-api.md#dusk_signtypeddata) for request/result fields.

Applications verify with `verifyTypedDataSignature` from `@dusk/typed-data/bls`, using trusted chain/origin expectations and checking `result.ok`. Signer identity, authorization, nonce and expiry checks remain application responsibilities.

## Status

The protocol is **draft, not frozen**. This integration pins unpublished `0.1.0-next.0`; registry publication and regenerated lockfiles are required before merge/release. Local tests with a built tarball do not establish registry availability or independent encoding approval.

## Provenance

The Wallet-specific functionality comes from ichbindas's [Wallet #101](https://github.com/dusk-network/wallet/pull/101). Its retained commits are ported individually with their original authors, author dates and messages, plus source-commit trailers. Hash implementation, vendored vectors, parity scripts and obsolete twin-design documents are excluded. The original PR remains separate and is not a prerequisite for this branch.

Hein's RPC-error and preview-disclosure fix is retained as a separate commit before the shared-package integration. The protocol's own history is recorded in the library's [PROVENANCE.md](https://github.com/dusk-network/typed-data/blob/main/PROVENANCE.md).
