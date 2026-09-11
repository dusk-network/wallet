# Typed-data signing: how the design was reached

Background notes for [#22](https://github.com/dusk-network/wallet/issues/22) and
[#90](https://github.com/dusk-network/wallet/issues/90).

This records the questions that shaped `dusk_signTypedData` and why the design
landed where it did. It is written for reviewers who want the reasoning behind a
decision, and for anyone who later wonders why a rule exists before changing it.

The normative specification lives in Connect:
[`docs/typed-data-v1.md`](https://github.com/dusk-network/connect/blob/main/docs/typed-data-v1.md).
This document does not restate it; it explains how it got that shape.

This work was written with AI assistance under human direction and review. The
specification was agreed before the implementation, and the digest was checked
against an implementation written independently from the specification text, so
the two agree on every intermediate value rather than only on the final result.

---

## Where this started

Two issues arrived from opposite directions.

**#90** asked for a way to sign an exact 32-byte digest with the profile Moonlight
BLS key. Some contract flows compute a digest themselves — a domain tag plus
canonical field bytes — and need a signature over precisely those bytes, verifiable
on-chain as `verify(signature, digest)` under `BlsVersion::V2`. Nothing in the
wallet could produce that: `dusk_signMessage` wraps its input in a memo envelope,
so its output is not a bare digest signature.

**#22** asked for typed intents: let a dApp request a signature over *structured
data* that the wallet renders, rather than an opaque blob the user cannot evaluate.
The Ethereum analogue is `eth_signTypedData_v4`, and the contrast that matters is
with `eth_sign`, which signs whatever it is handed.

Both are real. They are also in tension, and most of the design work below comes
from taking that tension seriously rather than shipping both and hoping.

An initial implementation established the shape: a canonical SHA-256 digest over
domain, types, primary type, and message; the origin injected by the wallet;
direct BLS signing rather than the memo envelope; and an approval screen showing
the fields. That shape survived. The questions below are what refined it.

---

## Question 1 — what does "un-advertised" actually guarantee?

The first version exposed both methods and handled the tension by advertising only
the typed one: `features.signBlsDigest: false`, and the raw method absent from the
capabilities method list.

Tracing an actual request showed this guarantees less than it appears to. The RPC
handler validated the caller's **origin** but never the **method name** — it
dispatched straight into `switch (method)`. Neither the in-page provider nor the
content script filtered method names either. So every `case` in that switch was
reachable by any connected dApp, whatever the capabilities said. Advertising
governed discoverability, not access.

The consequence is not "raw signing remains available." It is that **typed data
provided no additional guarantee at all**, because the two methods sign with the
same key:

> A connected site can compute the typed-data digest for a payload whose `origin`
> field names a *different* site, pass those 32 bytes to the raw method, and
> receive a signature that a typed-data verifier accepts as genuine — attributed
> to a site it does not control. Origin binding, domain binding, and the rendered
> approval screen are all bypassed by the sibling method.

The scope is wider than typed data. The same key and the same DST are used across
the ecosystem for other 32-byte digests, so an arbitrary-digest signing oracle
reaches anything built on that pattern.

A conformance test had also pinned the situation in place by asserting the raw
handler *existed*, so removing it would have failed CI.

**Resolution.** The dispatcher now fails closed: a method reaches the switch only
if it is on the canonical surface. Anything else is rejected before any permission
lookup, settings read, or approval prompt, so an unknown method costs nothing. The
raw method is not on the public surface, and the conformance test now asserts its
*absence*.

This does not settle #90, which remains open and undesigned. What it changes is the
constraint #90 has to satisfy: whatever raw-digest capability is eventually offered,
if any, must be reachable only through a path that is deliberately on the surface,
because "present in the dispatcher" no longer implies "callable". Question 3 removes
the remaining coupling between the two.

### A smaller thing the allowlist surfaced

`dusk_getAddresses` exists purely to return a specific refusal: shielded address
enumeration is deliberately not offered, and the handler says so. A bare allowlist
would have flattened that into "Unknown method" — misleading, because the method
is known and declined.

So "deliberately refused" became a declared category (`DAPP_TOMBSTONED_METHODS`)
rather than an accident of a `case` existing. Conformance keeps the two lists
disjoint and asserts every `dusk_` case is on one of them, which is what prevents
the original problem from recurring: a case that is on neither list is now a test
failure rather than a silently public method.

---

## Question 2 — do two implementations agree on what is valid?

The design deliberately uses two implementations: a reference in Connect, and a
twin in the wallet. A runtime dependency on Connect would pull its transitive tree
into an extension bundle that is store-reviewed and can sign with user keys, which
is a bad trade for an extension. The cost of a twin is drift, so the question is
what keeps them aligned.

Comparing them on identical inputs produced disagreement in **both** directions:

| Payload | Wallet | Connect |
|---|---|---|
| 600 KB domain field + 500 KB message field | rejected | accepted |
| `string[2]` holding two 400 KB values | accepted | rejected |

The second row is the damaging one: the wallet signs, the user approves, and the
verifier cannot check the result.

The cause was a 1 MiB encoded-size cap that was part of **validity**. One side used
a per-tree budget and counted array bytes once per element plus once for the
concatenation; the other shared a single budget across domain and message and
counted array bytes once. Both are defensible; neither is more correct; and while
the cap decides validity, a difference of opinion becomes an interoperability bug.

The deeper cause is that encoded size depended on the *value*. Length-prefixed
dynamic fields (`len32 || bytes`) grow with the payload, so bounding them requires
a size rule, and a size rule in the hash is a consensus rule.

**Resolution, in two parts.**

Dynamic values are now hashed rather than length-prefixed: `string` and `bytes`
encode as `sha256(value)`. Every type has a width fixed by the type alone, so
encoded size no longer depends on the payload, and the cap has nothing to bound.
This also makes the encoding streamable and shrinks the buffer a verifier must
materialise from O(payload) to O(fields), which matters for constrained verifiers.

Limits then returned as a **floor rather than a ceiling** (spec §11): verifiers
MUST accept anything valid within it, signers SHOULD reject above it as local
policy, and limits MUST NOT influence the digest. `checkPolicyLimits` is a separate
function the hashing path never calls.

The effect on the two payloads above: both now produce identical digests in both
implementations, and both are refused by the wallet's *policy* layer. Resource
policy moved to the transport boundary, where implementations may differ safely,
and left the validity rules, where they may not.

### Two other rules settled while the encoding was open

**`encodeType` now names the primary type first**, then its sorted dependencies.
The earlier form sorted the whole set, which gave equal `typeHash` to two struct
types with equal dependency closures. That is only reachable for mutually recursive
types, which admit no finite value — so it was not exploitable, but the safety
argument was an unstated invariant rather than a rule. Type cycles are now rejected
outright, and the ordering matches EIP-712's, so its wording applies directly.

**Field presence is tested as an own property.** Prototype-chain lookup means a
field named `__proto__` or `constructor` can appear present while absent. Not
reachable as the code stood; one refactor away from mattering. Those names are now
rejected as field names too.

---

## Question 3 — what stops a digest being reinterpreted?

The typed-data digest is 32 bytes. So is a pay-auth digest. So is anything else
built on the same convention. Under one shared DST, they occupy the same message
space, and the only thing keeping them apart was that the wallet controlled which
preimages it signed.

That is a procedural guarantee where a cryptographic one is available — and
Question 1 showed exactly how a procedural guarantee fails.

The first instinct was a typed-data-specific DST. That turns out to be the wrong
trade: `dusk-core` pins `BlsVersion::V2` and accepts no caller-supplied DST, so a
custom DST would make these signatures unverifiable through the standard on-chain
path. On-chain verifiability is a core goal of the feature.

**Resolution.** Keep the DST; make the *signed message* structurally distinct
(spec §12.1):

```
SIG_TAG       = utf8("DUSK_TYPED_DATA_SIG_V1\0")   // 23 bytes
signedMessage = SIG_TAG || digest                  // 55 bytes
```

The tag sits outside the digest deliberately: a value inside the SHA-256 preimage
constrains the preimage, not the 32-byte output, and the output is what gets
signed. A signer restricted to exactly 32 bytes cannot produce a 55-byte tagged
message, so the two spaces are disjoint. `hashToCurve` accepts arbitrary-length
input, so on-chain verification is unaffected.

This decouples the two issues. Whatever #90 eventually concludes — a gated method,
an internal-only capability, or nothing — a signature over a caller-supplied
32-byte digest cannot be a valid typed-data signature, and a typed-data signature
cannot be presented as one. #90 can therefore be designed on its own merits rather
than as a constraint on this one. The separation does not depend on remembering.

Both directions are asserted end to end — a bare-digest signature is rejected by
the typed-data verifier, and a typed-data signature is rejected by the bare-digest
verifier — with the wallet producing signatures and Connect verifying them, which
is the path integrators will actually use.

---

## Question 4 — what does the approval screen convey?

The screen is the entire justification for typed data over raw digests, so it was
worth asking what a user can actually act on.

**Rendering.** The obvious approach, `JSON.stringify`, is the wrong one. Pretty
printing overflows a ~360px popup and pushes the Sign button off-screen; scroll
fatigue produces approvals without reading, which is the failure the feature exists
to prevent. Flat JSON is unreadable once anything nests. Values are now flattened
to one row per leaf with a dotted path (`inner.name`, `parts[0].amount`).

**Declared types are shown.** `amount: "42"` looks identical whether the field is a
`uint64` or a `string`, and those sign different bytes. The row carries the type
from the schema, never one inferred from the value.

**Text is untrusted input.** Field values are attacker-controlled and rendered on a
signing screen. A right-to-left override can make `Send 1 DUSK` display as
something else. The existing `dusk_signMessage` path already guarded control
characters; the typed path must not be weaker. Strings are capped, and control
characters, bidi overrides, and lone surrogates are replaced with a placeholder and
flagged. The shared definition is exported from the message-preview module rather
than duplicated.

**Structural limits are separated from content warnings.** Depth and row caps are
needed, but a payload nested past the cap at the root would otherwise render an
approval with no visible fields and a "1 more field" notice — showing the user
nothing while understating what was hidden. A marker row now appears at the cut
point. And only genuinely deceptive content raises the spoofing warning: a value
truncated for length is a display limit, and a warning that fires on benign input
trains people to dismiss it.

**The digest is shown, collapsed.** Rendered fields are the right default, but the
digest is what a careful user or an integrator cross-checks against what the site
claims it asked for.

Because the extension's tests run without a DOM, this logic lives in a pure module
with the render layer as a thin mapping over it — the same split the existing
message-preview path uses, and the reason these rules can be tested by behaviour
rather than by inspecting source.

---

## Question 5 — how does any of this stay true?

Two implementations and a written spec are only as good as what compares them.

The golden vectors are the contract. Every accept vector now carries its
intermediates — per-struct `typeHash`, `domainSeparator`, `originBind`,
`structHash`, `digestHex`, and `signedMessageHex` — not just the final digest, so a
future mismatch names the stage that diverged instead of only proving two numbers
differ. Reject vectors carry a stable error code, one for every rule in the
specification's validation table, so the two sides can be compared on *why* they
reject rather than merely that they do.

The corpus is generated in Connect from its reference implementation, and vendored
into the wallet verbatim with the source commit recorded. It is never hand-edited
on either side, and a change starts in Connect.

The parity checker had a defect worth naming, because it is a general one: when it
could not find fixtures, it printed `skip` and exited 0. A checker that cannot
distinguish "everything passed" from "nothing ran" reports success either way — and
this one had already gone unnoticed while the two repositories shipped different
vectors under the same filename. It now runs against the vendored corpus with no
environment setup, and a missing directory, unreadable file, malformed JSON, or
zero vectors found is a hard failure. It runs as part of the normal test command.

One check is deliberately cross-module: the signed message is recomputed from the
wallet's own tag constant rather than trusted from the vector, so if the wallet's
tag ever drifts from Connect's, every vector fails immediately instead of the
wallet quietly producing signatures nothing accepts.

---

## How the pieces hold each other up

The parts are not independent, and reviewing them separately understates them:

- **Origin binding** is only meaningful because no sibling method will sign a
  caller-supplied digest (Q1), and remains meaningful even if one returns (Q3).
- **The rendered approval screen** is only meaningful because the digest it shows
  is the digest that gets signed, which requires both implementations to agree on
  encoding (Q2).
- **Agreement between implementations** is only durable because the vectors pin
  intermediates and the gate cannot silently skip (Q5).
- **The signing tag** is what turns "the wallet does not sign arbitrary digests"
  from a policy into a property.

Remove any one and the others weaken. That is the argument for landing them
together rather than as independent improvements.

---

## Deliberately not solved

- **Dynamic arrays (`T[]`).** No current use case; fixed `T[n]` suffices. Adding
  them needs a new width rule, hence a version.
- **Extracting the hasher to a shared package.** The twin plus an enforced gate is
  the cheaper correct answer for an extension. Revisit if a third implementation
  appears.
- **Decoding contract calldata inside the signing RPC.** Separate problem, separate
  approval surface.
- **Migrating existing application-specific digest schemes.** Per-application, and
  typed data does not force a cutover.
- **Version 1 is not frozen.** Nothing consumes these digests in production yet, so
  vectors can still be regenerated. That window closes at the first published
  release; after it, a change to the encoding requires a new scheme identifier.
  This is the main reason to review the encoding decisions now rather than later.
