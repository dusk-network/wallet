import qrcode from "qrcode-generator";
import { h } from "../lib/dom.js";

const _cache = new Map();

function buildQrSvg(text, { ecc = "M", margin = 2 } = {}) {
  const key = `${ecc}|${margin}|${text}`;
  const cached = _cache.get(key);
  if (cached) return cached;

  // typeNumber 0 => auto
  const qr = qrcode(0, ecc);
  qr.addData(text);
  qr.make();

  const n = qr.getModuleCount();
  const size = n + margin * 2;

  // Build a single path for all dark modules (smaller DOM than many <rect>s).
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      const x = c + margin;
      const y = r + margin;
      d += `M${x} ${y}h1v1h-1z`;
    }
  }

  const svg = `
<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 ${size} ${size}"
  shape-rendering="crispEdges"
  class="qr-svg"
  role="img"
  aria-label="QR code"
>
  <rect width="100%" height="100%" fill="#fff" />
  <path d="${d}" fill="#000" />
</svg>
  `.trim();

  _cache.set(key, svg);
  return svg;
}

/**
 * Returns a DOM element containing an SVG QR code.
 *
 * The QR code is rendered as an SVG inside a `.qr-inner` wrapper.
 */
export function qrCodeEl(value, { ecc = "M", margin = 2 } = {}) {
  const text = (value ?? "").toString().trim();
  if (!text) return h("div", { class: "qr-empty muted", text: "(none)" });

  const svg = buildQrSvg(text, { ecc, margin });
  return h("div", { class: "qr-inner", html: svg });
}
