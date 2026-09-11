import { describe, expect, it } from "vitest";

import { runTypedDataFixtureParityCheck } from "../../scripts/check-typed-data-fixture-parity.mjs";

/**
 * Wires the typed-data-v1 fixture parity gate (scripts/check-typed-data-fixture-parity.mjs)
 * into the default `npm run test:run` path.
 *
 * The gate checks src/shared/typedDataHash.js against the vectors vendored
 * from Connect at src/shared/fixtures/typed-data-v1/ (see SOURCE in that
 * directory). It is deliberately NOT allowed to report "skip" under any
 * circumstance - a missing/empty fixture directory is a failure, and this
 * test asserts that too, rather than only the happy path, so the gate can
 * never silently stop running without someone noticing here first.
 *
 * `npm run test:typed-data-parity` runs the same check standalone via the
 * script's CLI entry point, for use outside vitest (e.g. a dedicated CI step).
 */
describe("typed-data-v1 fixture parity (Connect vector corpus)", () => {
  it("verifies every vendored accept and reject vector, with a non-zero count", () => {
    const result = runTypedDataFixtureParityCheck();

    if (!result.ok) {
      throw new Error(
        `${result.summary}\n${result.failures.join("\n")}`
      );
    }

    // Guards against the historical failure mode this gate replaces: the
    // script silently resolving nothing and reporting success anyway.
    expect(result.acceptCount).toBeGreaterThan(0);
    expect(result.rejectCount).toBeGreaterThan(0);
  });
});
