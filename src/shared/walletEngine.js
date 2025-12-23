import { mnemonicToSeedSync } from "bip39";
import {
  Bookkeeper,
  Network,
  ProfileGenerator,
  useAsProtocolDriver,
} from "@dusk/w3sper";
import { hexToBytes, toBytes } from "./bytes.js";
import { assetUrl } from "../platform/assets.js";


// ----------------------------------------------------------------------------
// Utilities
// ----------------------------------------------------------------------------

/**
 * Race a promise against a timeout.
 *
 * IMPORTANT: We intentionally do this even when the underlying implementation
 * accepts AbortSignals. Some environments (notably WebViews) may not reliably
 * error/abort a hanging WebSocket connect, which can block the whole UI.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @param {() => void} [onTimeout]
 * @returns {Promise<T>}
 */
async function withTimeout(promise, ms, message, onTimeout) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // ignore
      }
      reject(new Error(message || "Operation timed out"));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}


let engineConfig = { nodeUrl: "https://testnet.nodes.dusk.network" };

export function configure(patch = {}) {
  if (patch.nodeUrl && typeof patch.nodeUrl === "string") {
    const next = patch.nodeUrl;
    const changed = next !== engineConfig.nodeUrl;
    engineConfig.nodeUrl = next;

    // IMPORTANT: allow switching networks/nodes at runtime.
    // If we already have a connected Network instance, we must drop it so the next
    // call reconnects to the new node URL.
    if (changed) {
      try {
        // w3sper's Network exposes connect(); disconnect() exists in newer versions.
        state.network?.disconnect?.();
      } catch {}
      try {
        // Some implementations may use close().
        state.network?.close?.();
      } catch {}

      state.network = null;
      state.treasury = null;
      state.bookkeeper = null;
    }
  }
}

// --- Treasury (MVP) ---------------------------------------------------------
// This treasury implementation is intentionally minimal:
// - It supports public account-based operations: nonce/value + stake info.
// - It DOES NOT manage shielded notes yet. Those require a note cache/sync.
import { AccountSyncer } from "@dusk/w3sper";


class RemoteTreasury {
  #network;
  #profiles = [];

  constructor(network, profiles = []) {
    this.#network = network;
    this.#profiles = profiles;
  }

  setProfiles(profiles) {
    this.#profiles = profiles;
  }

  /**
   * @param {any} identifier profile.account Key
   * @returns {Promise<{nonce:bigint,value:bigint}>}
   */
  async account(identifier) {
    const idx = +identifier;
    const profile = this.#profiles.at(idx);
    if (!profile) {
      throw new Error(`Unknown account index ${idx}`);
    }
    const syncer = new AccountSyncer(this.#network);
    const [balance] = await withTimeout(
      syncer.balances([profile]),
      10_000,
      "Balance request timed out"
    );
    return balance;
  }

  /**
   * Shielded notes are not supported in this MVP.
   */
  async address(_identifier) {
    return new Map();
  }

  /**
   * @param {any} identifier
   */
  async stakeInfo(identifier) {
    const idx = +identifier;
    const profile = this.#profiles.at(idx);
    if (!profile) {
      throw new Error(`Unknown account index ${idx}`);
    }
    const syncer = new AccountSyncer(this.#network);
    const [stakeInfo] = await withTimeout(
      syncer.stakes([profile]),
      10_000,
      "Stake request timed out"
    );
    return stakeInfo;
  }
}

// --- Engine state -----------------------------------------------------------
const state = {
  unlocked: false,
  mnemonic: null,
  seed: null,
  profiles: [],
  currentIndex: 0,
  profileGenerator: null,
  network: null,
  treasury: null,
  bookkeeper: null,
  protocolLoaded: false,
};

export function isUnlocked() {
  return state.unlocked;
}

export function hasWallet() {
  // wallet existence is tracked via vault in storage;
  // engine just tells whether it's currently unlocked.
  return true;
}

export function lock() {
  state.unlocked = false;
  state.mnemonic = null;
  if (state.seed) {
    try {
      state.seed.fill(0);
    } catch {}
  }
  state.seed = null;
  state.profiles = [];
  state.profileGenerator = null;
  state.currentIndex = 0;
  // we keep network instance around, it holds no secrets
}

/**
 * Unlock engine with mnemonic (already decrypted from vault)
 * @param {string} mnemonic
 */
export async function unlockWithMnemonic(mnemonic) {
  await ensureProtocolDriverLoaded();
  mnemonic = mnemonic.trim().replace(/\s+/g, " ");
  const seed = Uint8Array.from(mnemonicToSeedSync(mnemonic));

  // ProfileGenerator needs a seeder fn; return a copy each time.
  const seeder = async () => seed.slice();
  const pg = new ProfileGenerator(seeder);

  // Generate default profile (index 0)
  const p0 = await pg.default;

  state.unlocked = true;
  state.mnemonic = mnemonic;
  state.seed = seed;
  state.profileGenerator = pg;
  state.profiles = [p0];
  state.currentIndex = 0;

  return p0;
}

export function getCurrentProfile() {
  const p = state.profiles[state.currentIndex];
  if (!p) throw new Error("Wallet not unlocked");
  return p;
}

export function getAccounts() {
  // Return public account identifiers (base58)
  return state.profiles.map((p) => p.account.toString());
}

export function getAddresses() {
  return state.profiles.map((p) => p.address.toString());
}

async function ensureProtocolDriverLoaded() {
  if (state.protocolLoaded) return;

  // Load wasm bytes packaged with the extension, or from web/tauri assets.
  const wasmUrl = assetUrl("wallet_core-1.3.0.wasm");
  const buffer = await fetch(wasmUrl).then((r) => r.arrayBuffer());
  useAsProtocolDriver(new Uint8Array(buffer));
  state.protocolLoaded = true;
}

export async function ensureNetwork() {
  if (state.network?.connected) return state.network;

  const url = new URL(engineConfig.nodeUrl);

  await ensureProtocolDriverLoaded();

  state.network = state.network ?? new Network(url);

  try {
    // NOTE: Some WebViews do not reliably abort a hanging WebSocket connect.
    // We therefore always enforce a timeout via Promise.race.
    const controller = new AbortController();

    const abortAndTearDown = () => {
      try {
        controller.abort();
      } catch {
        // ignore
      }
      try {
        state.network?.disconnect?.();
      } catch {
        // ignore
      }
      try {
        state.network?.close?.();
      } catch {
        // ignore
      }
    };

    // Some versions of w3sper accept an options bag with a signal, others do not.
    // Try the signal form, then fall back to the no-arg signature.
    let connectPromise;
    try {
      connectPromise = state.network.connect({ signal: controller.signal });
    } catch {
      connectPromise = state.network.connect();
    }

    await withTimeout(
      connectPromise,
      10_000,
      `Timed out connecting to node ${url.toString()}`,
      abortAndTearDown
    );
  } catch (err) {
    // Drop the cached network/bookkeeper objects so a retry starts from a
    // clean state.
    try {
      state.network?.disconnect?.();
    } catch {
      // ignore
    }
    try {
      state.network?.close?.();
    } catch {
      // ignore
    }
    state.network = null;
    state.treasury = null;
    state.bookkeeper = null;

    throw new Error(formatWsError(err, url.toString()));
  }

  state.treasury = state.treasury ?? new RemoteTreasury(state.network, state.profiles);
  state.treasury.setProfiles(state.profiles);
  state.bookkeeper = state.bookkeeper ?? new Bookkeeper(state.treasury);

  return state.network;
}

function formatWsError(err, nodeUrl) {
  const name = err?.name || "Error";
  const msg = err?.message;

  // Try to extract target websocket info
  const t = err?.target;
  const wsUrl = typeof t?.url === "string" ? t.url : null;
  const rs = typeof t?.readyState === "number" ? t.readyState : null;

  if (typeof msg === "string" && msg.length) {
    return `${name}: ${msg}`;
  }

  if (wsUrl) {
    return `WebSocket connection failed to ${wsUrl} (readyState=${rs ?? "?"})`;
  }

  // Last resort
  return `Failed to connect to node ${nodeUrl} (unknown websocket error)`;
}

export async function getPublicBalance() {
  if (!state.unlocked) throw new Error("Wallet locked");
  await ensureNetwork();
  const profile = getCurrentProfile();
  return await withTimeout(
    state.bookkeeper.balance(profile.account),
    12_000,
    "Balance request timed out"
  );
}

function normalizeGas(gas) {
  if (!gas || typeof gas !== "object") return undefined;
  const out = {};
  if (gas.limit !== undefined && gas.limit !== null && gas.limit !== "") {
    out.limit = typeof gas.limit === "bigint" ? gas.limit : BigInt(gas.limit);
  }
  if (gas.price !== undefined && gas.price !== null && gas.price !== "") {
    out.price = typeof gas.price === "bigint" ? gas.price : BigInt(gas.price);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Public account transfer (account -> account) MVP.
 * @param {{to:string, amount:string|bigint, memo?:string, gas?:{limit?:string|bigint, price?:string|bigint}}} params
 */
export async function transfer(params) {
  if (!state.unlocked) throw new Error("Wallet locked");
  const { to, memo } = params;

  const amount = typeof params.amount === "bigint" ? params.amount : BigInt(params.amount);

  // MVP: only allow public account destination
  if (ProfileGenerator.typeOf(to) !== "account") {
    throw new Error(
      "MVP only supports public account transfers. Shielded address transfers are not implemented yet."
    );
  }

  const network = await ensureNetwork();
  const profile = getCurrentProfile();

  let tx = state.bookkeeper.as(profile).transfer(amount).to(to);

  if (typeof memo === "string" && memo.length > 0) {
    tx = tx.memo(memo);
  }

  const gas = normalizeGas(params.gas);
  if (gas) tx = tx.gas(gas);

  const result = await network.execute(tx);
  // network.execute returns the tx object returned by tx.build, frozen
  return { hash: result.hash, nonce: result.nonce };
}

// ----------------------------------------------------------------------------
// dusk_sendTransaction
// ----------------------------------------------------------------------------

function toU64(value, { name } = { name: "value" }) {
  if (value === undefined || value === null || value === "") return 0n;
  try {
    const v = typeof value === "bigint" ? value : BigInt(value);
    if (v < 0n) throw new Error("negative");
    return v;
  } catch {
    throw new Error(`Invalid ${name}: must be a u64 decimal string`);
  }
}

function toContractIdBytes(contractId) {
  if (typeof contractId === "string") {
    const b = hexToBytes(contractId);
    if (b.length !== 32) throw new Error("contractId must be 32 bytes");
    return b;
  }
  if (contractId instanceof Uint8Array) {
    if (contractId.length !== 32) throw new Error("contractId must be 32 bytes");
    return contractId;
  }
  if (Array.isArray(contractId)) {
    const b = new Uint8Array(contractId);
    if (b.length !== 32) throw new Error("contractId must be 32 bytes");
    return b;
  }
  throw new Error("Invalid contractId (expected 32-byte hex string or number[32])");
}

/**
 * Send a transaction from the currently selected account.
 *
 * Supported kinds:
 * - { kind: 'transfer', to, amount, memo?, gas? }
 * - { kind: 'contract_call', contractId, fnName, fnArgs, to?, amount?, deposit?, gas? }
 */
export async function sendTransaction(params) {
  if (!state.unlocked) throw new Error("Wallet locked");
  if (!params || typeof params !== "object") {
    throw new Error("Invalid params: object required");
  }

  const kind = String(params.kind || "").toLowerCase();
  if (!kind) throw new Error("Invalid params: kind is required");

  // Common
  const network = await ensureNetwork();
  const profile = getCurrentProfile();

  if (kind === "transfer") {
    // Reuse existing transfer logic for now.
    return await transfer(params);
  }

  if (kind === "contract_call") {
    if ("memo" in params && params.memo) {
      throw new Error("Contract calls cannot include a memo payload");
    }

    const contractIdBytes = toContractIdBytes(params.contractId);
    const fnName = String(params.fnName ?? "").trim();
    if (!fnName) throw new Error("fnName is required");
    if (fnName.length > 64) throw new Error("fnName too long (max 64 chars)");

    const fnArgsBytes = toBytes(params.fnArgs);
    if (fnArgsBytes.length > 64 * 1024) {
      throw new Error("fnArgs too large (max 64KB)");
    }

    const to = params.to ? String(params.to) : profile.account.toString();
    if (ProfileGenerator.typeOf(to) !== "account") {
      throw new Error("Contract calls currently require an account 'to' (base58)" );
    }

    const amount = toU64(params.amount, { name: "amount" });
    const deposit = toU64(params.deposit, { name: "deposit" });

    // NOTE: W3sper / protocol-driver uses 'payload' either as memo OR contract call data.
    const payload = Object.freeze({
      fnName,
      fnArgs: fnArgsBytes,
      contractId: Array.from(contractIdBytes),
    });

    let tx = state.bookkeeper.as(profile).transfer(amount).to(to).payload(payload);

    if (deposit > 0n) {
      tx = tx.deposit(deposit);
    }

    const gas = normalizeGas(params.gas);
    if (gas) tx = tx.gas(gas);

    const result = await network.execute(tx);
    return { hash: result.hash, nonce: result.nonce };
  }

  throw new Error(`Unsupported transaction kind: ${params.kind}`);
}
