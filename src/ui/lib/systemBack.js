// A phone's Back button, as one step back inside the wallet.
//
// Firefox's add-on page and the app's WebView take Back to the page's history,
// and with none to go back to they close the wallet, with whatever was typed.
// So each step into the wallet a press takes (a screen with a way back, a
// dialog, a menu) puts one history entry of the wallet's above the page's
// own, and Back takes one away: the wallet takes that step back instead
// (`backStep`: the screen's ← Back, a dialog's Cancel, a menu closing). The
// page's own Back takes its entry away with it. On a first screen there's
// none, and Back leaves the wallet as it always did; but in the app, which
// Back would close, unlocked wallet and all, one stands there too (`onFirst`).
//
// An entry goes up only as a press goes: WebViews skip, on Back, the history
// a page adds while no one presses anything, and close the page instead. So
// after Back, the next entry waits for the next press.

const BACK_CONTROL = "[data-back], .subnav-back";

/**
 * @param {object} opts
 * @param {() => (null | (() => void))} opts.backStep - what Back does on the
 *   screen shown now, or null
 * @param {() => string} opts.screenKey - which screen, dialog and menu show:
 *   a change is a step in or out
 * @param {() => Promise<boolean>} [opts.onFirst] - what Back does on a first
 *   screen instead of leaving (the app goes to the background, kept as it
 *   is); false from it, and Back there is the browser's from then on
 * @param {Window} [opts.win]
 * @returns {{ sync: () => void }} `sync` after a screen, a dialog or a menu
 *   changes, and after a press
 */
export function installSystemBack({ backStep, screenKey, onFirst, win = globalThis.window }) {
  const history = win?.history;
  if (typeof history?.pushState !== "function") return { sync() {} };
  const doc = win.document ?? globalThis.document;
  // The wallet's entries above the page's own.
  let entries = 0;
  // Our own steps back through them: their popstate isn't the person's.
  let leaving = 0;
  // A first screen's Back that couldn't do what `onFirst` does.
  let firstFailed = false;
  // Since the person's last Back, no press yet: nothing goes up.
  let afterBack = false;
  // The last press was a way back (← Back, Cancel, Done, Escape): its step takes an entry.
  let pressedBack = false;
  let shown = screenKey();

  const first = () => Boolean(onFirst) && !firstFailed;
  // The entries the screen shown now stands on: one with a way back, or on
  // a first screen with `onFirst`; none on a first screen without.
  const needed = () => (backStep() || first() ? 1 : 0);
  // Whether a press allows an entry now.
  const pressing = () => !afterBack && (win.navigator?.userActivation ? win.navigator.userActivation.isActive : true);
  const push = () => {
    history.pushState({ duskBack: true }, "");
    entries++;
  };
  const drop = (n) => {
    if (n <= 0) return;
    entries -= n;
    leaving++;
    history.go(-n);
  };

  const sync = () => {
    const key = screenKey();
    const changed = key !== shown;
    shown = key;
    const need = needed();
    if (changed && pressedBack) {
      // The page's own way back took a step: one entry goes with it.
      pressedBack = false;
      drop(Math.min(1, entries - need));
    } else if (changed && backStep() && pressing()) {
      // A step in: one more.
      push();
      return;
    }
    // A first screen keeps only what it stands on.
    if (!backStep() && entries > need) drop(entries - need);
    else if (entries < need && pressing()) push();
  };

  win.addEventListener("popstate", () => {
    if (leaving) {
      leaving--;
      return;
    }
    // The person's Back: the browser took an entry away.
    entries = Math.max(0, entries - 1);
    afterBack = true;
    pressedBack = false;
    const step = backStep();
    // A screen the step draws syncs as it's drawn; a menu or a dialog it
    // closes, a moment on. Without one, Back went where the browser takes it.
    if (step) {
      step();
      setTimeout(sync, 0);
    } else if (first()) {
      onFirst()
        .then((done) => {
          firstFailed = !done;
        })
        .catch(() => {
          firstFailed = true;
        })
        .finally(sync);
    } else sync();
  });

  // A press: entries may go up again; one on a way back takes its step's entry.
  const pressed = (back) => {
    afterBack = false;
    pressedBack = back;
    setTimeout(sync, 0);
  };
  doc?.addEventListener?.("click", (event) => pressed(Boolean(event?.target?.closest?.(BACK_CONTROL))), true);
  doc?.addEventListener?.(
    "keydown",
    (event) => {
      if (event?.key === "Enter" || event?.key === "Escape") pressed(event.key === "Escape");
    },
    true
  );

  return { sync };
}
