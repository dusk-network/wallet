// The motion tokens in ui.css (--motion-*), for what JavaScript times: how
// long a toast takes to fade out before it goes, and how long a view rises.
// Keep the numbers as ui.css has them. Reduced motion is CSS's alone: it
// stops the movement and keeps these times.
export const MOTION = Object.freeze({
  /** Feedback, and every exit, in ms. */
  fast: 120,
  /** Anything that arrives or opens, in ms. */
  base: 200,
});
