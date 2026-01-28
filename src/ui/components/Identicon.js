import { h } from "../lib/dom.js";
import { fnv1a32 } from "../../shared/chain.js";

// Identicon (no deps)
// A tiny deterministic "blockies"-style identicon so accounts feel like MetaMask.
// TODO: Consider using a tiny library or online API.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function hsl(h, s, l) {
  return `hsl(${h}, ${s}%, ${l}%)`;
}

export function identiconSvg(seedStr, grid = 8) {
  const seed = fnv1a32(seedStr || "dusk");
  const rng = mulberry32(seed);

  // Colors: keep them vibrant but readable on dark background
  const hue = randInt(rng, 0, 359);
  const color = hsl(hue, randInt(rng, 55, 75), randInt(rng, 50, 62));
  const spot = hsl(
    (hue + randInt(rng, 40, 140)) % 360,
    randInt(rng, 55, 80),
    randInt(rng, 45, 58)
  );
  const bg = hsl((hue + 200) % 360, randInt(rng, 10, 18), randInt(rng, 12, 18));

  // Build symmetrical pattern (like blockies)
  const data = [];
  const half = Math.ceil(grid / 2);
  for (let y = 0; y < grid; y++) {
    const row = [];
    for (let x = 0; x < half; x++) {
      // 0 background, 1 primary, 2 spot
      row.push(randInt(rng, 0, 2));
    }
    const mirrored = row.slice(0, grid - half).reverse();
    data.push(...row, ...mirrored);
  }

  let rects = "";
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v === 0) continue;
    const x = i % grid;
    const y = Math.floor(i / grid);
    rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${v === 1 ? color : spot}"/>`;
  }

  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${grid} ${grid}" shape-rendering="crispEdges" aria-hidden="true">
  <rect width="100%" height="100%" fill="${bg}"/>
  ${rects}
</svg>`.trim();
}

export function identiconEl(seedStr) {
  const wrap = h("div", { class: "identicon" });
  wrap.innerHTML = identiconSvg(seedStr);
  return wrap;
}
