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

const DEFAULT_PBKDF2_ITERATIONS = 100_000;

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
 * @param {BufferSource} buffer
 * @param {string} pwd
 * @returns {Promise<{data:Uint8Array, iv:Uint8Array, salt:Uint8Array, iterations:number}>}
 */
export async function encryptBuffer(buffer, pwd) {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await getDerivedKey(pwd, salt, DEFAULT_PBKDF2_ITERATIONS);
  const data = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, buffer)
  );
  return { data, iv, salt, iterations: DEFAULT_PBKDF2_ITERATIONS };
}

/**
 * @param {{data:Uint8Array, iv:Uint8Array, salt:Uint8Array, iterations?:number}} encryptInfo
 * @param {string} pwd
 */
export async function decryptBuffer(encryptInfo, pwd) {
  const { data, iv, salt } = encryptInfo;
  const iterRaw = Number(encryptInfo?.iterations);
  if (!Number.isFinite(iterRaw) || iterRaw < DEFAULT_PBKDF2_ITERATIONS) {
    throw new Error("Vault format not supported");
  }
  const key = await getDerivedKey(pwd, salt, iterRaw);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
}

/**
 * @param {string} mnemonic
 * @param {string} pwd
 */
export async function encryptMnemonic(mnemonic, pwd) {
  const bytes = utf8ToBytes(mnemonic);
  try {
    return await encryptBuffer(bytes, pwd);
  } finally {
    try {
      bytes.fill(0);
    } catch {
      // ignore
    }
  }
}

/**
 * @param {{data:Uint8Array, iv:Uint8Array, salt:Uint8Array}} encryptInfo
 * @param {string} pwd
 */
export async function decryptMnemonic(encryptInfo, pwd) {
  const buffer = await decryptBuffer(encryptInfo, pwd);
  const bytes = new Uint8Array(buffer);
  try {
    return bytesToUtf8(bytes);
  } finally {
    try {
      bytes.fill(0);
    } catch {
      // ignore
    }
  }
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
