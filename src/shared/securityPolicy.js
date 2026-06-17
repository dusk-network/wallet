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
  if (!url) return false;

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
