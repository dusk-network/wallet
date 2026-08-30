#!/usr/bin/env node
/**
 * Typed-data v1 fixture parity gate.
 *
 * Normative spec: docs/typed-data-v1.md (Connect repo), section 15.
 *
 * This script is the wallet-side half of the interop contract between
 * `src/shared/typedDataHash.js` and Connect's reference implementation
 * (`@dusk/connect/typed-data`). The vectors it checks against live at
 * src/shared/fixtures/typed-data-v1/ - vendored verbatim from Connect, see
 * the SOURCE file in that directory. This script never edits them.
 *
 * Contract with the caller (npm run test:typed-data-parity, and the vitest
 * wrapper at src/shared/typedDataFixtureParity.test.js):
 *
 *   - Runs against the vendored vectors with NO environment setup. There is
 *     no fallback path and no "skip" outcome.
 *   - A missing fixture directory, an unreadable or malformed vector file,
 *     or finding zero vectors is a FAILURE (non-zero exit), never a skip.
 *   - Every accept vector is checked stage-by-stage (each struct's typeHash,
 *     domainSeparator, originBind, structHash, digestHex) via
 *     hashTypedDataDebug, so a mismatch names the stage that diverged
 *     instead of only reporting "digest mismatch".
 *   - Every reject vector must make hashTypedData throw with exactly the
 *     recorded error code.
 *   - CONNECT_TYPED_DATA_FIXTURES is an OPTIONAL extra check: when set, the
 *     vendored copies are additionally byte-diffed against that directory.
 *     It never gates whether the required checks above run.
 *
 * This script intentionally has no dependency on a test runner so it can be
 * invoked standalone (`npm run test:typed-data-parity`) as well as from
 * inside vitest.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hashTypedData, hashTypedDataDebug } from "../src/shared/typedDataHash.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = path.join(ROOT, "src/shared/fixtures/typed-data-v1");
const REJECT_DIR = path.join(FIXTURES_DIR, "reject");

const DEBUG_STAGES = ["domainSeparator", "originBind", "structHash", "digestHex"];

/**
 * Run the full parity gate.
 *
 * @returns {{ ok: boolean, acceptCount: number, rejectCount: number, failures: string[], summary: string }}
 */
export function runTypedDataFixtureParityCheck() {
  const failures = [];

  const acceptFiles = listJsonFiles(FIXTURES_DIR, failures, "accept");
  const rejectFiles = listJsonFiles(REJECT_DIR, failures, "reject");

  let acceptCount = 0;
  let rejectCount = 0;

  for (const filePath of acceptFiles) {
    if (checkAcceptVector(filePath, failures)) {
      acceptCount++;
    }
  }

  for (const filePath of rejectFiles) {
    if (checkRejectVector(filePath, failures)) {
      rejectCount++;
    }
  }

  if (acceptFiles.length === 0 && rejectFiles.length === 0) {
    failures.push(
      `FAILURE: zero typed-data-v1 vectors found under ${FIXTURES_DIR} - this must never happen; ` +
        "a missing/empty fixture set is a failure, not a skip"
    );
  }

  const connectDir = process.env.CONNECT_TYPED_DATA_FIXTURES?.trim();
  if (connectDir) {
    checkAgainstConnect(path.resolve(connectDir), failures);
  }

  const ok = failures.length === 0;
  const summary = ok
    ? `typed-data-v1 parity: ${acceptCount} accept vector(s) verified, ${rejectCount} reject vector(s) verified`
    : `typed-data-v1 parity: FAILED (${failures.length} problem(s)); ` +
      `${acceptCount} accept vector(s) and ${rejectCount} reject vector(s) verified before failure`;

  return { ok, acceptCount, rejectCount, failures, summary };
}

/**
 * List `.json` files directly inside `dir`, sorted. Any problem reading the
 * directory itself is recorded as a failure and results in an empty list -
 * it must never be treated as "nothing to check, skip".
 */
function listJsonFiles(dir, failures, label) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    failures.push(`FAILURE: cannot read ${label} vector directory ${dir}: ${err.message}`);
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => path.join(dir, e.name))
    .sort();
}

/** Read and JSON.parse a fixture file, recording a failure (and returning null) instead of throwing. */
function loadVector(filePath, failures) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    failures.push(`FAILURE: cannot read ${filePath}: ${err.message}`);
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    failures.push(`FAILURE: malformed JSON in ${filePath}: ${err.message}`);
    return null;
  }
}

/**
 * Check one accept vector: recompute every intermediate via
 * hashTypedDataDebug and compare each one against the recorded value. On
 * mismatch, names the exact stage that diverged.
 *
 * @returns {boolean} true if the vector verified cleanly
 */
function checkAcceptVector(filePath, failures) {
  const name = path.relative(ROOT, filePath);
  const vector = loadVector(filePath, failures);
  if (!vector) {
    return false;
  }
  if (!vector.input) {
    failures.push(`FAILURE: ${name}: vector has no "input" field`);
    return false;
  }

  let debug;
  try {
    debug = hashTypedDataDebug(vector.input);
  } catch (err) {
    failures.push(
      `FAILURE: ${name}: hashTypedDataDebug threw unexpectedly (code=${err.code ?? "?"}): ${err.message}`
    );
    return false;
  }

  const stageFailures = [];

  const vectorTypeHashes = vector.typeHashes ?? {};
  const computedTypeHashes = debug.typeHashes ?? {};
  const allStructNames = new Set([
    ...Object.keys(vectorTypeHashes),
    ...Object.keys(computedTypeHashes),
  ]);
  for (const structName of allStructNames) {
    const expected = vectorTypeHashes[structName];
    const actual = computedTypeHashes[structName];
    if (expected === undefined) {
      stageFailures.push(
        `typeHashes.${structName} was computed (${actual}) but is not present in the vector`
      );
    } else if (actual === undefined) {
      stageFailures.push(
        `typeHashes.${structName} is recorded in the vector (${expected}) but was not computed`
      );
    } else if (expected !== actual) {
      stageFailures.push(`typeHashes.${structName} mismatch: vector=${expected} computed=${actual}`);
    }
  }

  for (const stage of DEBUG_STAGES) {
    if (vector[stage] !== debug[stage]) {
      stageFailures.push(`${stage} mismatch: vector=${vector[stage]} computed=${debug[stage]}`);
    }
  }

  if (stageFailures.length > 0) {
    for (const f of stageFailures) {
      failures.push(`FAILURE: ${name}: ${f}`);
    }
    return false;
  }
  return true;
}

/**
 * Check one reject vector: hashTypedData must throw with exactly the
 * recorded error code.
 *
 * @returns {boolean} true if the vector verified cleanly
 */
function checkRejectVector(filePath, failures) {
  const name = path.relative(ROOT, filePath);
  const vector = loadVector(filePath, failures);
  if (!vector) {
    return false;
  }
  if (typeof vector.error !== "string") {
    failures.push(`FAILURE: ${name}: vector has no "error" field`);
    return false;
  }

  let caught;
  try {
    hashTypedData(vector.input);
  } catch (err) {
    caught = err;
  }

  if (caught === undefined) {
    failures.push(
      `FAILURE: ${name}: expected hashTypedData to throw ${vector.error}, but it succeeded`
    );
    return false;
  }
  if (caught.code !== vector.error) {
    failures.push(
      `FAILURE: ${name}: expected error code ${vector.error}, got ${caught.code ?? "(no code)"} (${caught.message})`
    );
    return false;
  }
  return true;
}

/**
 * Optional extra check (CONNECT_TYPED_DATA_FIXTURES): byte-diff the vendored
 * vectors against a Connect checkout's vectors/typed-data-v1 directory. Only
 * runs when the env var is set; never gates whether the required checks
 * above ran.
 */
function checkAgainstConnect(connectDir, failures) {
  const connectAccept = connectDir;
  const connectReject = path.join(connectDir, "reject");

  if (!isDirectory(connectAccept)) {
    failures.push(
      `FAILURE: CONNECT_TYPED_DATA_FIXTURES=${connectDir} does not exist or is not a directory`
    );
    return;
  }

  diffDirectories(FIXTURES_DIR, connectAccept, "accept", failures);
  diffDirectories(REJECT_DIR, connectReject, "reject", failures);
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function diffDirectories(vendoredDir, connectDir, label, failures) {
  const vendoredNames = new Set(listJsonFileNames(vendoredDir));
  const connectNames = new Set(listJsonFileNames(connectDir));
  const allNames = new Set([...vendoredNames, ...connectNames]);

  for (const fileName of allNames) {
    const vendoredPath = path.join(vendoredDir, fileName);
    const connectPath = path.join(connectDir, fileName);

    if (!vendoredNames.has(fileName)) {
      failures.push(`FAILURE: ${label}/${fileName}: present in Connect but not vendored in the wallet`);
      continue;
    }
    if (!connectNames.has(fileName)) {
      failures.push(`FAILURE: ${label}/${fileName}: vendored in the wallet but missing from Connect`);
      continue;
    }

    const vendoredContent = readFileSync(vendoredPath, "utf8");
    const connectContent = readFileSync(connectPath, "utf8");
    if (vendoredContent !== connectContent) {
      failures.push(
        `FAILURE: ${label}/${fileName}: vendored copy differs from CONNECT_TYPED_DATA_FIXTURES source`
      );
    }
  }
}

function listJsonFileNames(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function main() {
  const result = runTypedDataFixtureParityCheck();
  if (!result.ok) {
    for (const failure of result.failures) {
      console.error(failure);
    }
    console.error(result.summary);
    process.exit(1);
  }
  console.log(result.summary);
  process.exit(0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
