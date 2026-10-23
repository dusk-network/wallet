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
