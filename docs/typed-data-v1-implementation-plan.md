# Typed data v1 — implementation plan

Companion to [`docs/typed-data-v1.md`](./typed-data-v1.md). Covers two repos:

| Repo | Role |
|------|------|
| `dusk-network/connect` | Owns the normative hash + golden vectors. Reference implementation. |
| `dusk-network/wallet` | Ships the hasher twin, the RPC, and the approval UI. |

Phases are ordered so each one is independently reviewable and independently
revertable. Phase 1 has no dependency on the spec work and SHOULD ship first.

---

## Land order across repos

Phase 2 changes the digest. The wallet twin and the Connect reference must change
together or the parity gate (Phase 3) fails on both sides.

```
Connect PR #1  ──►  Connect PR #2  ──►  wallet PR (phases 2–7)
(hash + vectors)    (verify + bls)       (twin + RPC + UI)

wallet PR (phase 1) ──── independent, ship immediately ────►
```

- **Wallet Phase 1** is a standalone security fix. It does not touch the hash. Open
  it as its own PR, merge without waiting for anything.
- **Connect PR #1** lands the §5–§9 hash changes and regenerated vectors.
- **Connect PR #2** lands `verifyTypedDataSignature` over the tagged message (§12.3)
  and the `@dusk/connect/bls` subpath.
- **Wallet PR** (phases 2–7) lands last and pins the vendored vectors to the Connect
  commit that produced them.

No published consumer recomputes v1 digests today — `sozuAdapter.js` has no signing
or digest code, and no contract-side verifier exists — so regenerating vectors costs
nothing but coordination. That window closes at the first store release (spec §14
freeze rule).

---

## Phase 0 — Rebase onto a real base

The branch is currently a **root commit** (`3079b85` has no parent). There is no
merge base with `origin/main`, and `git diff 99d5dac...HEAD` reports 219 files and
−32 807 lines because the snapshot is a partial, stale tree. Four of five test
suites fail to import (`./bytes.js`, `./constants.js` are absent).

Until this is fixed no reviewer can tell an intentional change from snapshot rot,
and nothing below can be verified.

**Do**

```bash
git checkout -b feat/typed-data origin/main
git cherry-pick f7ac391 6e09fd3 9450e99 c2c4705 18dd1e6 8afa160 067bf1c 3661642 e6c158b
```

Then re-inspect for changes that came in with the stale snapshot rather than the
feature, and drop them:

- `src/engine/runtime.js` — `inferTxOk` / `inferTxError` reintroduced, replacing the
  shared `txExecution.js` helpers from PR #76.
- `src/shared/walletEngine.js` — `getLoadedProfiles` / `resolveProfileIndex` inlined
  back, reverting PR #87; `broadcastShieldedStatus` indentation mangled;
  `hasWallet()` added returning a hardcoded `true`.
- `src/background/rpc.js` — `validateNodeUrl` returns raw `trimmed` instead of
  `url.origin`, letting path/query/fragment through into the node URL.

**Verify** — `git diff origin/main...HEAD --stat` touches only typed-data files.
`npm run test:run` passes.

---

## Phase 1 — Close the raw-digest signing oracle

**Repo:** wallet. **Independent of the spec. Ship first.**

`handleRpc` validates the caller's origin but never validates the *method* against
`DAPP_RPC_METHODS`. Neither `src/inpage.js` nor `src/contentScript.js` filters method
names. So `dusk_signBlsDigest` is callable by any connected dApp despite
`features.signBlsDigest: false` — un-advertising is discoverability, not access
control.

The consequence is that the typed-data design's central guarantee is bypassable: a
connected `evil.com` can compute the typed digest for a payload whose `origin` reads
`https://good.app`, call `dusk_signBlsDigest` with those 32 bytes, and receive a
signature that verifies as genuine typed data from `good.app`. The approval popup
shows only a hex string. The same key and DST also sign Moonlight pay-auth digests,
so the oracle extends beyond typed data.

`src/shared/providerSurface.conformance.test.js` currently asserts the handler
exists, so CI actively prevents removing it.

**Do**

1. `src/background/rpc.js` — allowlist at the top of `handleRpc`, immediately after
   the origin check:

   ```js
   if (!DAPP_RPC_METHODS.includes(method)) {
     throw rpcError(ERROR_CODES.METHOD_NOT_FOUND, `Unknown method: ${method}`);
   }
   ```

   Fail-closed. Every future internal case is private by default rather than public
   until someone remembers.

2. `src/background/rpc.js` — delete the `case "dusk_signBlsDigest":` block entirely.
   Keep `signBlsDigest()` in `src/shared/walletEngine.js` and the
   `"dusk_signBlsDigest"` case in `src/engine/runtime.js` — that is the
   engine-internal channel `dusk_signTypedData` already calls through `engineCall`,
   and it is not reachable from a page.

3. `src/shared/providerSurface.conformance.test.js` — invert the assertion:

   ```js
   expect(extractRpcSwitchCases(js)).not.toContain("dusk_signBlsDigest");
   ```

4. Add a regression test in `src/background/rpc.test.js`: a connected origin calling
   `dusk_signBlsDigest` gets `METHOD_NOT_FOUND`, and calling an invented method name
   gets `METHOD_NOT_FOUND` before any permission or approval work happens.

**Verify** — the new tests pass; no approval popup is reachable for a raw digest
from a page context; typed-data signing still works end to end.

**Note for the PR body.** The current draft lists this under "holes we accepted"
(#7, "un-advertising closes the product hole"). That framing should change: it
closes the product hole and leaves the security hole open.

---

## Phase 2 — Hash conformance

**Repo:** Connect first (`packages/dusk-typed-data/src/hash.ts`), then the wallet
twin (`src/shared/typedDataHash.js`). Identical edits; the twin is a port.

| # | Change | Spec |
|---|--------|------|
| 2.1 | `string` → `sha256(utf8(v))`; `bytes` → `sha256(raw)` | §5.1 |
| 2.2 | Delete `MAX_ENCODED`, the `size` accumulator, and `account()` entirely | §11 |
| 2.3 | `encodeType` prepends the primary before sorted deps | §6.1 |
| 2.4 | Reject type cycles in `collectStructs` (`E_TYPE_CYCLE`) | §10 |
| 2.5 | Field presence via `Object.prototype.hasOwnProperty.call` | §6.3 |
| 2.6 | Reject `__proto__` / `constructor` / `prototype` in `checkFields` | §10 |
| 2.7 | Reject `primaryType === "DuskTypedDataDomain"` | §7 |
| 2.8 | Reject `T[0]` and leading-zero array sizes | §4 |
| 2.9 | `originBindHash` → `sha256(ORIGIN_TAG \|\| sha256(utf8(origin)))` | §8 |
| 2.10 | Replace bare `throw new Error(msg)` with stable error codes | §10 |
| 2.11 | Signer-side policy limits (§11 floor) as a separate, clearly-named check | §11 |

2.2 is the change that removes the current wallet↔Connect divergence at its root.
Today the wallet shares one budget across domain and message and counts array
children once, while Connect uses per-tree budgets and double-counts arrays — so
each accepts payloads the other rejects, in both directions. Deleting the budget
deletes the disagreement.

2.11 replaces it with a policy check the two implementations are *allowed* to
differ on. Put it behind its own function and its own error code so it never gets
confused with validation.

**Verify** — a differential test: generate payloads, assert both implementations
either produce the same digest or reject with the same error code. Run it over the
reject-vector corpus from Phase 3.

---

## Phase 3 — Golden vectors and a parity gate that runs

The current gate is a no-op:

```js
if (!connectDir || !fs.existsSync(connectDir)) {
  console.log("skip: CONNECT_TYPED_DATA_FIXTURES not set");
  process.exit(0);
}
```

Default path is `../connect/src/typed-data/fixtures`; the goldens are elsewhere; the
env var is undocumented; the script is in neither `npm test` nor CI. It has already
failed silently — `sign_in_basic.json` uses different domain values on each side and
therefore different digests, while commit `18dd1e6` claims alignment with a Connect
golden that does not exist. Both digests are individually correct; the two repos
simply ship different vectors under one filename.

**Do**

1. **Connect** — regenerate vectors under §15, with intermediates
   (`typeHashes`, `domainSeparator`, `originBind`, `structHash`, `digestHex`,
   `signedMessageHex`). Cover every accept case and one vector per §10 error code.
2. **Wallet** — vendor the vectors into `src/shared/fixtures/typed-data-v1/`
   verbatim. Record the source Connect commit SHA in a `SOURCE` file next to them.
3. **Wallet** — rewrite `scripts/check-typed-data-fixture-parity.mjs`:
   - Compare against the **vendored** copy by default; no env var needed.
   - Compare every intermediate, not only `digestHex`, so a mismatch localizes.
   - A missing or unreadable vector is a **failure**, never a skip.
   - Keep `CONNECT_TYPED_DATA_FIXTURES` as an optional override for cross-checking a
     Connect working tree, but never as the thing that decides whether to run.
4. **Wallet** — add to `test:run` and to CI.
5. Add a unit test asserting each reject vector produces its documented error code.

**Verify** — deleting a fixture fails CI; changing one byte of any intermediate
fails CI; `npm run test:run` runs the gate with no environment setup.

---

## Phase 4 — Signed message tag

**Repos:** both. Depends on Phase 2.

Sign `SIG_TAG || digest` (55 bytes) rather than the bare 32-byte digest (§12.1). The
digest alone is indistinguishable from any other 32-byte value the same key signs,
including pay-auth digests; the tag makes the spaces disjoint.

The DST stays `BLS_SIG_BLS12381G1_XMD:SHA-256_DUSK_V2`. A custom DST would give the
same separation but would break verification through the stock dusk-core path, which
pins `BlsVersion::V2` and takes no caller-supplied DST — and on-chain verifiability
is a core goal. `hashToCurve` accepts arbitrary-length input, so the longer message
needs no special handling anywhere.

**Do**

1. **Wallet** `src/shared/blsDigest.js` — add `signTypedDataDigest(profile, digest)`
   that prepends `SIG_TAG` and calls the existing `signBlsMessageBytes`. Leave
   `signProfileBlsDigest` alone; it remains the engine-internal raw path.
2. **Wallet** `src/shared/walletEngine.js` — `signBlsDigest()` gains an explicit
   mode, or add a separate `signTypedData()` export. Do not overload one function
   with an ambiguous flag — the two message spaces must stay visibly distinct in the
   source.
3. **Connect** — `verifyTypedDataSignature` recomputes the digest, prepends `SIG_TAG`,
   and verifies over the tagged message. Add a test asserting that a signature valid
   over the *bare* digest is **rejected** — that test is the whole point.
4. Vectors gain `signedMessageHex` (Phase 3 already provides for it).

**Verify** — golden signature verifies; bare-digest signature over the same payload
fails; a pay-auth digest signature cannot be replayed as typed data.

---

## Phase 5 — RPC surface

**Repo:** wallet. `src/background/rpc.js`, `src/shared/providerSurface.js`.

1. **Result shape** (§13) — return `account`, `publicKeyHex`, `origin`, `chainId`,
   `primaryType`, `digestHex`, `signature`.
   - `fundsPkHex` → `publicKeyHex`. "funds pk" is vocabulary from a downstream
     product and does not belong on the Dusk provider surface.
   - `signatureHex` → `signature`, matching `dusk_signMessage` and `dusk_signAuth`.
   - **Add `origin`.** It is a digest input the caller cannot derive reliably; a
     verifier that guesses it wrong cannot distinguish a normalization mismatch from
     a tampered signature. Both sibling methods already echo it.
   - Add `chainId` and `primaryType` so a verifier need not hold the request.
2. **chainId re-check.** `chainId` is read before `requestUserApproval` and never
   re-read. The user can switch networks mid-approval. Re-read settings after
   approval returns and throw if it changed.
3. **Version negotiation.** `features.typedDataVersion: 1` →
   `features.signTypedDataVersions: [1]`. Accept optional `params.version`,
   defaulting to `1`, and reject anything else explicitly (§14). A scalar forces a
   flag day: a v1-only dApp seeing `2` cannot tell whether v1 payloads are still
   accepted, and a wallet supporting both has no way to say so. This matters
   concretely here — the digest scheme is changing in this same effort.
4. **Policy limits** — enforce the §11 floor before approval, with `E_POLICY_LIMIT`,
   so oversized payloads never reach the popup.

**Verify** — `rpc.test.js` covers: wrong `chainId` rejected before approval;
caller-supplied `origin` ignored; network switch during approval rejected; unknown
`version` rejected; response shape exact.

---

## Phase 6 — Approval UI

**Repo:** wallet. `src/ui/notification/app.js`.

1. **Flatten nested values into labeled rows.** Replace both `JSON.stringify`
   branches in `formatTypedFieldDisplay`. Neither is right: pretty-print blows up
   vertical space in a ~360 px popup and pushes the Sign button off-screen, and
   scroll fatigue produces approvals without reading — the exact failure the feature
   exists to prevent. Flat JSON is unreadable for nested structs.

   Recurse through the type table instead, one row per leaf, dotted paths:

   ```
   inner.name      string    fuji
   note            string    hello
   parts[0]        string    abc
   assetId         bytes32   32 bytes · sha256=aabbccddeeff…55667788
   ```

   `renderTypedDataFieldRows` already walks `types[primaryType]`, so it has what it
   needs. This also closes the "nested `bytes` lack the length+hash preview" gap for
   free, because nested leaves go through the same formatter as top-level ones.

   Cap depth at 8 and rows at 200; past the cap render
   "N more fields — the digest covers all of them".

2. **Show the declared type per row.** `amount: "42"` is currently identical whether
   it is a `uint64` or a `string`, and those are different signatures over different
   bytes.

3. **Restore the digest row**, collapsed. It was present in `f7ac391` and dropped by
   `6e09fd3` in favour of rendered fields. Rendered fields are the right default, but
   the digest is what a careful user cross-checks against what the dApp claims.

4. **Guard text.** The `sign_message` path runs `describeSignMessagePreview` and
   handles `too_large`, `invalid_utf8`, `control_characters`. The typed-data path has
   none of it — `formatTypedFieldDisplay` returns raw `String(value)`, so a 1 MiB
   string renders in full and a U+202E right-to-left override passes straight through
   to the popup. `h()` sets `textContent`, so there is no HTML injection, but visual
   spoofing works, and a signing approval screen is where that pays off.

   Reuse `describeSignMessagePreview` per leaf; cap ~2 KiB per row with
   expand-on-click; flag bidi and control characters the way the message path does.

**Verify** — extend `src/ui/notification.app.test.js` beyond source-text assertions
to actually render a payload: nested struct, fixed array, oversized string, bidi
override, deep nesting past the cap.

---

## Phase 7 — Docs and capability surface

1. `docs/typed-data-v1.md` — this spec, mirrored into Connect as the SSOT copy, or
   moved there with a pointer left behind. One of the two, not two drifting copies.
2. `docs/provider-api.md` — update the `dusk_signTypedData` section: new result
   shape, `signTypedDataVersions`, `params.version`, link to the spec. Remove the
   paragraph describing `dusk_signBlsDigest` as an internal RPC that "may exist" — it
   is gone from the public surface after Phase 1.
3. `docs/SECURITY.md` — keep `dusk_signTypedData` in the permission table. Extend the
   typed-data review checklist with the origin-binding rationale and the signed-message
   tag.
4. `README.md` — dApp example using the current result shape.
5. Conformance test already enforces doc ↔ `providerSurface.js` ↔ `rpc.js` agreement;
   confirm it still passes after the surface changes.

---

## Deferred

Explicitly out of scope, recorded so they are not rediscovered as findings.

| Item | Rationale |
|------|-----------|
| Dynamic `T[]` | No v1 use case; fixed `T[n]` suffices. Adding it later needs a new width rule, hence a version bump |
| Extracting the hasher to a shared `@dusk/typed-data` package | The twin plus a real parity gate is the cheaper correct answer for an extension; a runtime dependency puts Connect's transitive tree into a bundle that gets store-reviewed and can sign with user keys |
| Decoding `contract_call` `fnArgs` inside the sign RPC | Separate problem, separate approval surface |
| Migrating existing app-specific digest schemes | Per-app decision; typed data does not force a cutover |
| External security review | Wanted before promoting the method as store-ready; not a prerequisite for landing reviewable code and vectors |

---

## Checklist

```
[ ] 0   Rebase onto origin/main; snapshot reverts dropped; test:run green
[ ] 1   Method allowlist; raw-digest case deleted; conformance assertion inverted
[ ] 2   Connect hash conforms to spec §5–§11
[ ] 2   Wallet twin conforms; differential test green
[ ] 3   Vectors regenerated with intermediates + reject corpus
[ ] 3   Vectors vendored with source SHA; parity gate fails on missing/mismatch; in CI
[ ] 4   SIG_TAG applied both sides; bare-digest signature rejected by verify
[ ] 5   Result shape per §13 incl. origin echo; chainId re-check; version array
[ ] 6   Flattened rows + types + digest row + text guards; render tests
[ ] 7   Spec published; provider-api / SECURITY / README updated
```
