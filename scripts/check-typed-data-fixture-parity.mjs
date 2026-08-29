import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WALLET_FIXTURES = path.join(ROOT, "src/shared/fixtures/typed-data-v1");
const FIXTURE_NAMES = [
  "sign_in_basic.json",
  "nested_struct.json",
  "bytes32_field.json",
];

function resolveConnectFixturesDir() {
  const envPath = process.env.CONNECT_TYPED_DATA_FIXTURES?.trim();
  if (envPath) {
    return path.resolve(envPath);
  }

  const sibling = path.resolve(ROOT, "../connect/src/typed-data/fixtures");
  if (fs.existsSync(sibling)) {
    return sibling;
  }

  return null;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function inputFingerprint(fixture) {
  if (fixture.input != null) {
    return JSON.stringify(fixture.input);
  }

  const fields = ["domain", "types", "primaryType", "message", "origin"];
  const slice = {};
  for (const key of fields) {
    if (key in fixture) {
      slice[key] = fixture[key];
    }
  }
  return JSON.stringify(slice);
}

function compareFixture(name, connectDir) {
  const walletPath = path.join(WALLET_FIXTURES, name);
  const connectPath = path.join(connectDir, name);

  if (!fs.existsSync(walletPath)) {
    return { ok: false, detail: `${name}: wallet fixture missing at ${walletPath}` };
  }
  if (!fs.existsSync(connectPath)) {
    return { ok: false, detail: `${name}: connect fixture missing at ${connectPath}` };
  }

  const wallet = loadJson(walletPath);
  const connect = loadJson(connectPath);

  if (wallet.digestHex !== connect.digestHex) {
    return {
      ok: false,
      detail: `${name}: digestHex mismatch (wallet=${wallet.digestHex}, connect=${connect.digestHex})`,
    };
  }

  const walletInput = inputFingerprint(wallet);
  const connectInput = inputFingerprint(connect);
  if (walletInput !== connectInput) {
    return {
      ok: false,
      detail: `${name}: input mismatch`,
    };
  }

  return { ok: true };
}

function main() {
  const connectDir = resolveConnectFixturesDir();
  if (!connectDir || !fs.existsSync(connectDir)) {
    console.log("skip: CONNECT_TYPED_DATA_FIXTURES not set");
    process.exit(0);
  }

  const failures = [];
  for (const name of FIXTURE_NAMES) {
    const result = compareFixture(name, connectDir);
    if (!result.ok) {
      failures.push(result.detail);
    }
  }

  if (failures.length > 0) {
    for (const detail of failures) {
      console.error(detail);
    }
    process.exit(1);
  }

  console.log(`${FIXTURE_NAMES.length} fixtures OK`);
  process.exit(0);
}

main();
