// AES-GCM encryption helpers (ported from web-wallet/src/lib/wallet)

/**
 * @param {string} str
 * @returns {Uint8Array}
 */
export function utf8ToBytes(str) {
  return new TextEncoder().encode(str);
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

/**
 * Robust base64 encoding for Uint8Array
 * @param {Uint8Array} bytes
 */
export function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * @param {string} base64
 */
export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * @param {string} pwd
 */
async function getKeyMaterial(pwd) {
  return crypto.subtle.importKey(
    "raw",
    utf8ToBytes(pwd),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"]
  );
}

const DEFAULT_PBKDF2_ITERATIONS = 900_000;

/**
 * @param {string} pwd
 * @param {Uint8Array} salt
 * @param {number} iterations
 */
async function getDerivedKey(pwd, salt, iterations = DEFAULT_PBKDF2_ITERATIONS) {
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256",
    },
    await getKeyMaterial(pwd),
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

/**
 * The key a password makes with a salt: PBKDF2-SHA-256 at `iterations`, never
 * fewer than the default, to an AES-GCM-256 key. Every phrase sealed with
 * that salt opens with it, so it's derived once for all of them.
 * @param {string} pwd
 * @param {Uint8Array} salt
 * @param {number} [iterations]
 */
export async function deriveVaultKey(pwd, salt, iterations = DEFAULT_PBKDF2_ITERATIONS) {
  const iterRaw = Number(iterations);
  if (!Number.isFinite(iterRaw) || iterRaw < DEFAULT_PBKDF2_ITERATIONS) {
    throw new Error("Vault format not supported");
  }
  return getDerivedKey(pwd, salt, iterRaw);
}

/** A new random salt, with the iterations a key for it is derived with. */
export function newKeySalt() {
  return { salt: crypto.getRandomValues(new Uint8Array(32)), iterations: DEFAULT_PBKDF2_ITERATIONS };
}

/**
 * `buffer` sealed with a key derived for `salt` and `iterations`, under a
 * fresh IV.
 * @param {BufferSource} buffer
 * @param {CryptoKey} key
 * @param {{salt:Uint8Array, iterations:number}} derivedWith
 * @returns {Promise<{data:Uint8Array, iv:Uint8Array, salt:Uint8Array, iterations:number}>}
 */
export async function encryptBufferWithKey(buffer, key, { salt, iterations }) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, buffer)
  );
  return { data, iv, salt, iterations };
}

/**
 * @param {BufferSource} buffer
 * @param {string} pwd
 * @returns {Promise<{data:Uint8Array, iv:Uint8Array, salt:Uint8Array, iterations:number}>}
 */
export async function encryptBuffer(buffer, pwd) {
  const derivedWith = newKeySalt();
  return encryptBufferWithKey(buffer, await deriveVaultKey(pwd, derivedWith.salt, derivedWith.iterations), derivedWith);
}

/**
 * @param {{data:Uint8Array, iv:Uint8Array, salt:Uint8Array, iterations?:number}} encryptInfo
 * @param {string} pwd
 */
export async function decryptBuffer(encryptInfo, pwd) {
  const key = await deriveVaultKey(pwd, encryptInfo.salt, encryptInfo?.iterations);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: encryptInfo.iv }, key, encryptInfo.data);
}

// The phrase's bytes, wiped once `fn` is done with them.
async function withPhraseBytes(bytes, fn) {
  try {
    return await fn(bytes);
  } finally {
    try {
      bytes.fill(0);
    } catch {
      // ignore
    }
  }
}

/**
 * @param {string} mnemonic
 * @param {string} pwd
 */
export async function encryptMnemonic(mnemonic, pwd) {
  return withPhraseBytes(utf8ToBytes(mnemonic), (bytes) => encryptBuffer(bytes, pwd));
}

/**
 * `mnemonic` sealed with a key derived for `salt` and `iterations`
 * (deriveVaultKey), under a fresh IV.
 * @param {string} mnemonic
 * @param {CryptoKey} key
 * @param {{salt:Uint8Array, iterations:number}} derivedWith
 */
export async function encryptMnemonicWithKey(mnemonic, key, derivedWith) {
  return withPhraseBytes(utf8ToBytes(mnemonic), (bytes) => encryptBufferWithKey(bytes, key, derivedWith));
}

/**
 * @param {{data:Uint8Array, iv:Uint8Array, salt:Uint8Array}} encryptInfo
 * @param {string} pwd
 */
export async function decryptMnemonic(encryptInfo, pwd) {
  return withPhraseBytes(new Uint8Array(await decryptBuffer(encryptInfo, pwd)), bytesToUtf8);
}

/**
 * The phrase `encryptInfo` holds, opened with the key derived for its salt.
 * @param {{data:Uint8Array, iv:Uint8Array}} encryptInfo
 * @param {CryptoKey} key
 */
export async function decryptMnemonicWithKey(encryptInfo, key) {
  const buffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv: encryptInfo.iv }, key, encryptInfo.data);
  return withPhraseBytes(new Uint8Array(buffer), bytesToUtf8);
}

/**
 * Convert encryptInfo to a JSON-serializable object
 */
export function serializeEncryptInfo(info) {
  return {
    data: bytesToBase64(info.data),
    iv: bytesToBase64(info.iv),
    salt: bytesToBase64(info.salt),
    iterations: Number(info.iterations) || DEFAULT_PBKDF2_ITERATIONS,
  };
}

/**
 * Convert serialized encryptInfo back to Uint8Arrays
 */
export function deserializeEncryptInfo(serialized) {
  return {
    data: base64ToBytes(serialized.data),
    iv: base64ToBytes(serialized.iv),
    salt: base64ToBytes(serialized.salt),
    iterations: serialized?.iterations,
  };
}
