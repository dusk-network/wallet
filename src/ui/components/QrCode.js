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
  width="${size}"
  height="${size}"
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

export function qrSvgString(value, { ecc = "M", margin = 2 } = {}) {
  const text = (value ?? "").toString().trim();
  if (!text) return "";
  return buildQrSvg(text, { ecc, margin });
}

function svgModuleSize(svg) {
  const m = String(svg ?? "").match(/viewBox="0 0 ([0-9.]+) ([0-9.]+)"/);
  const w = Number(m?.[1] ?? 0);
  const h = Number(m?.[2] ?? 0);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0
    ? { w, h }
    : { w: 256, h: 256 };
}

// `text` cut to fit `width` on the canvas, with "…" where it was cut.
function fitted(ctx, text, width) {
  if (ctx.measureText(text).width <= width) return text;
  const chars = Array.from(text);
  while (chars.length > 1 && ctx.measureText(`${chars.join("")}…`).width > width) chars.pop();
  return `${chars.join("")}…`;
}

/**
 * The QR as a PNG, with `caption`'s lines written under it in the picture, for
 * whoever gets the picture alone: what a request asks.
 * @param {string} value
 * @param {{ ecc?: string, margin?: number, scale?: number, caption?: Array<{ size: number, text: string, weight?: number }> }} [opts]
 */
export async function qrPngBlob(value, { ecc = "M", margin = 2, scale = 10, caption = [] } = {}) {
  const svg = qrSvgString(value, { ecc, margin });
  if (!svg) throw new Error("No QR value to export");
  if (typeof document === "undefined") throw new Error("PNG export is unavailable");

  const { w, h } = svgModuleSize(svg);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(w * scale));
  const qrHeight = Math.max(1, Math.ceil(h * scale));
  const lines = (caption ?? []).filter((line) => line?.text);
  canvas.height = qrHeight + (lines.length ? lines.reduce((sum, { size }) => sum + size * 1.5, 0) + 24 : 0);

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("PNG export is unavailable");

  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  try {
    const img = new Image();
    img.decoding = "sync";
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("Failed to render QR"));
      img.src = url;
    });

    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, qrHeight);

    // What it asks, centred under the code, each line in the width there is.
    if (lines.length) {
      const font = globalThis.getComputedStyle?.(document.body)?.fontFamily || "sans-serif";
      ctx.fillStyle = "#101010";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      let top = qrHeight;
      for (const { size, text, weight = 400 } of lines) {
        ctx.font = `${weight} ${size}px ${font}`;
        ctx.fillText(fitted(ctx, String(text), canvas.width - 32), canvas.width / 2, top);
        top += size * 1.5;
      }
    }

    return await new Promise((resolve, reject) => {
      canvas.toBlob((png) => {
        if (png) resolve(png);
        else reject(new Error("Failed to export QR PNG"));
      }, "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function downloadQrPng(value, filename = "dusk-qr.png", opts = {}) {
  const png = await qrPngBlob(value, opts);
  const url = URL.createObjectURL(png);

  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Returns a DOM element containing an SVG QR code.
 *
 * The QR code is rendered as an SVG inside a `.qr-inner` wrapper.
 */
export function qrCodeEl(value, { ecc = "M", margin = 2 } = {}) {
  const text = (value ?? "").toString().trim();
  if (!text) return h("div", { class: "qr-empty muted", text: "(none)" });

  const svg = qrSvgString(text, { ecc, margin });
  return h("div", { class: "qr-inner", html: svg });
}
