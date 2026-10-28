import { h } from "../lib/dom.js";

const ICON_PATHS = {
  create: [
    '<circle cx="12" cy="12" r="7.5"/>',
    '<path d="M12 8.5v7"/>',
    '<path d="M8.5 12h7"/>',
  ],
  import: [
    '<path d="M4 13v4.5A2.5 2.5 0 0 0 6.5 20h11A2.5 2.5 0 0 0 20 17.5V13"/>',
    '<path d="M12 4v10"/>',
    '<path d="m7.5 9.5 4.5 4.5 4.5-4.5"/>',
  ],
  receive: [
    '<path d="M4 13v4.5A2.5 2.5 0 0 0 6.5 20h11A2.5 2.5 0 0 0 20 17.5V13"/>',
    '<path d="M12 4v10"/>',
    '<path d="m7.5 9.5 4.5 4.5 4.5-4.5"/>',
  ],
  send: [
    '<path d="m5 12 14-7-5 14-2.8-5.2Z"/>',
    '<path d="m11.2 13.8 3.2 5.2"/>',
  ],
  shield: [
    '<path d="M3.7 12s3-5 8.3-5 8.3 5 8.3 5-3 5-8.3 5-8.3-5-8.3-5Z"/>',
    '<circle cx="12" cy="12" r="2.4"/>',
    '<path d="M19.5 4.5 4.5 19.5"/>',
  ],
  stake: [
    '<path d="M12 3.5 20 8l-8 4.5L4 8Z"/>',
    '<path d="m4 12 8 4.5 8-4.5"/>',
    '<path d="m4 16 8 4.5 8-4.5"/>',
  ],
  info: [
    '<circle cx="12" cy="12" r="9"/>',
    '<path d="M12 12v4"/>',
    '<path d="M12 8h.01"/>',
  ],
  copy: [
    '<rect x="9" y="9" width="11" height="11" rx="2"/>',
    '<path d="M9 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v3"/>',
  ],
  refresh: [
    '<path d="M20 12a8 8 0 1 1-2.34-5.66"/>',
    '<path d="M17.66 2.34v4h-4"/>',
  ],
  // Balances shown, and hidden. The hidden eye has no pupil under its slash,
  // so it stays clear at the balance title's 13px.
  eye: [
    '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5-9.5-6.5-9.5-6.5Z"/>',
    '<circle cx="12" cy="12" r="3"/>',
  ],
  "eye-off": [
    '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5-9.5-6.5-9.5-6.5Z"/>',
    '<path d="M4.5 4.5l15 15"/>',
  ],
  expand: [
    '<path d="M14 4h6v6"/>',
    '<path d="M20 4l-6 6"/>',
    '<path d="M10 20H4v-6"/>',
    '<path d="M4 20l6-6"/>',
  ],
  settings: [
    '<path d="M9.9 5.53L10.13 3.2L13.87 3.2L14.1 5.53A6.8 6.8 0 0 1 16.55 6.95L18.69 5.98L20.56 9.22' +
      "L18.65 10.59A6.8 6.8 0 0 1 18.65 13.41L20.56 14.78L18.69 18.02L16.55 17.05A6.8 6.8 0 0 1 14.1 18.47" +
      "L13.87 20.8L10.13 20.8L9.9 18.47A6.8 6.8 0 0 1 7.45 17.05L5.31 18.02L3.44 14.78L5.35 13.41" +
      'A6.8 6.8 0 0 1 5.35 10.59L3.44 9.22L5.31 5.98L7.45 6.95A6.8 6.8 0 0 1 9.9 5.53Z"/>',
    '<circle cx="12" cy="12" r="2.6"/>',
  ],
  qr: [
    '<rect x="4" y="4" width="6" height="6" rx="1"/>',
    '<rect x="14" y="4" width="6" height="6" rx="1"/>',
    '<rect x="4" y="14" width="6" height="6" rx="1"/>',
    '<path d="M14 14h2v2h-2z"/>',
    '<path d="M20 14h.01M14 20h.01M20 20h.01"/>',
  ],
  // An address book: a cover with binder rings along its left edge, and a
  // person on it. The rings keep it from reading as a profile picture.
  contacts: [
    '<rect x="5" y="2.5" width="15.5" height="19" rx="2"/>',
    '<path d="M3 7h4"/>',
    '<path d="M3 12h4"/>',
    '<path d="M3 17h4"/>',
    '<circle cx="13" cy="8.75" r="2.25"/>',
    '<path d="M9.5 17.5a3.5 3.5 0 0 1 7 0"/>',
  ],
  close: [
    '<path d="M6 6l12 12"/>',
    '<path d="M18 6L6 18"/>',
  ],
  plus: [
    '<path d="M12 5v14"/>',
    '<path d="M5 12h14"/>',
  ],
  nft: [
    '<path d="M12 3.5l7.36 4.25v8.5L12 20.5l-7.36-4.25v-8.5Z"/>',
  ],
  check: ['<path d="M5 12.5l4.5 4.5L19 7.5"/>'],
  alert: [
    '<circle cx="12" cy="12" r="9"/>',
    '<path d="M12 7.5v5"/>',
    '<path d="M12 16.2h.01"/>',
  ],
  "chev-r": ['<path d="M9.5 6l6 6-6 6"/>'],
  // Activity's direction icons: sent, received, a bridge transfer, a contract call.
  "arr-out": ['<path d="M7 17 17 7"/>', '<path d="M9 7h8v8"/>'],
  "arr-in": ['<path d="M17 7 7 17"/>', '<path d="M15 17H7V9"/>'],
  bridge: [
    '<path d="M3 9.5h18"/>',
    '<path d="M5 9.5v10"/>',
    '<path d="M19 9.5v10"/>',
    '<path d="M8 19.5V16a4 4 0 0 1 8 0v3.5"/>',
  ],
  call: ['<path d="m8.5 7.5-4.5 4.5 4.5 4.5"/>', '<path d="m15.5 7.5 4.5 4.5-4.5 4.5"/>'],
  // Opens a page outside the wallet.
  ext: ['<path d="M8 6h10v10"/>', '<path d="M18 6 6 18"/>'],
  // A node: two stacked server units.
  server: [
    '<rect x="4" y="4" width="16" height="7" rx="2"/>',
    '<rect x="4" y="13" width="16" height="7" rx="2"/>',
    '<path d="M8 7.5h.01"/>',
    '<path d="M8 16.5h.01"/>',
  ],
  // Liquid staking.
  drop: ['<path d="M12 3.5c3.5 4.2 6 7.5 6 10.5a6 6 0 0 1-12 0c0-3 2.5-6.3 6-10.5Z"/>'],
  clock: ['<circle cx="12" cy="12" r="8.5"/>', '<path d="M12 7.5V12l3 2"/>'],
  lock: [
    '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/>',
    '<path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  ],
  // The network fee: a fuel pump.
  fee: [
    '<path d="M5 20V6.5A2.5 2.5 0 0 1 7.5 4h5A2.5 2.5 0 0 1 15 6.5V20"/>',
    '<path d="M4 20h12"/>',
    '<path d="M7.5 9h5"/>',
    '<path d="M15 9.5h1.5a2 2 0 0 1 2 2V16a1.5 1.5 0 0 0 3 0V8.5L19 6"/>',
  ],
};

/**
 * An icon as inline SVG markup, drawn in the current colour by the CSS where
 * it shows, so it looks the same whatever fonts the system has.
 * @param {string} name - one of ICON_PATHS
 * @returns {string}
 */
export function iconSvg(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name]?.join("") ?? ""}</svg>`;
}

export function actionIcon(name, { className = "action-btn-ico" } = {}) {
  return h("div", {
    class: className,
    html: iconSvg(name),
  });
}
