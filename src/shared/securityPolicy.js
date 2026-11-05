function parseUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function isLocalHttpHostname(hostname) {
  const normalized = String(hostname ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");

  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function isAllowedSecureOrLocalHttpUrl(value) {
  const url = parseUrl(value);
  if (!url || url.username || url.password) return false;

  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return isLocalHttpHostname(url.hostname);

  return false;
}

export function isAllowedDappOrigin(origin) {
  return isAllowedSecureOrLocalHttpUrl(origin);
}

export function isAllowedDappEndpoint(value) {
  return isAllowedSecureOrLocalHttpUrl(value);
}

/**
 * What's wrong with an address given for the wallet's node, prover or
 * archiver, in plain words, or "": a URL, https or plain http on this
 * computer only, as a site's switch of network takes them.
 * @param {string} value
 * @param {"node" | "prover" | "archiver"} what
 * @returns {string}
 */
export function endpointProblem(value, what) {
  const url = parseUrl(value);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return `Invalid ${what} URL format`;
  return isAllowedSecureOrLocalHttpUrl(value) ? "" : `The ${what} URL must start with https://, unless it's on this computer.`;
}
