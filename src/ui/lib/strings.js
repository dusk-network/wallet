import { formatContractId, formatEvmAddress, shortAccount } from "@dusk-network/networks/format";

/**
 * A Dusk account, address, contract ID or hash as every Dusk app shortens it
 * (@dusk-network/networks/format): its first and last six characters around
 * "…". Short input comes back as it is.
 * @param {string} address
 * @returns {string}
 */
export function shortAddress(address) {
  return shortAccount(String(address ?? ""));
}

/**
 * An EVM address as every Dusk app shortens it: 0x and four characters, "…"
 * and the last four, with its EIP-55 checksum ("0xAB84…C86F"). Anything else
 * as shortAddress cuts it.
 * @param {string} address
 * @returns {string}
 */
export function shortEvmAddress(address) {
  const text = String(address ?? "").trim();
  try {
    return formatEvmAddress(text, { short: true });
  } catch {
    return shortAddress(text);
  }
}

/**
 * An EVM transaction's hash, cut as an EVM address is: "0x029e…d61b".
 * @param {string} hash
 * @returns {string}
 */
export function shortEvmHash(hash) {
  const text = String(hash ?? "").trim();
  return /^0x[0-9a-fA-F]{64}$/.test(text) ? `${text.slice(0, 6)}…${text.slice(-4)}` : shortAddress(text);
}

export function normalizeMnemonic(m) {
  return String(m ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .join(" ");
}

/**
 * A site as the wallet names it, in approvals and the popup alike: its host
 * with any port, or for a local http:// site its whole origin, so the scheme
 * shows too.
 * @param {string} origin
 * @returns {string}
 */
export function siteName(origin) {
  try {
    const url = new URL(String(origin ?? ""));
    return url.protocol === "https:" ? url.host : url.origin;
  } catch {
    return String(origin ?? "");
  }
}

/**
 * A yearly rate as the wallet says it: "23%".
 * @param {number} rate - a fraction
 */
export const ratePercent = (rate) => new Intl.NumberFormat("en", { maximumFractionDigits: 0, style: "percent" }).format(rate);

/**
 * A Dusk contract ID as every Dusk app writes it (@dusk-network/networks):
 * lower-case hex without 0x, or with `short` 6 characters at each end.
 * Anything that isn't one, as it is.
 * @param {unknown} id
 * @param {{ short?: boolean }} [opts]
 */
export function contractIdText(id, { short = false } = {}) {
  const text = String(id ?? "");
  try {
    return formatContractId(text, { short });
  } catch {
    return short ? shortAddress(text) : text;
  }
}
