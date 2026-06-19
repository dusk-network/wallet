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
};

export function actionIcon(name, { className = "action-btn-ico" } = {}) {
  return h("div", {
    class: className,
    html: `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name]?.join("") ?? ""}</svg>`,
  });
}
