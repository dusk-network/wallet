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
//
// Where the wallet stands is the browser's own word: each entry of the
// wallet's says how deep it is (`duskDepth`), so a Back that skipped an
// entry, or a step of the wallet's own the browser didn't take, never leaves
// it counting entries that aren't there, and the person's next Back taken for
// the wallet's own. The wallet takes one step of its own at a time.
//
// A screen whose way back asks first, as Import does with words typed
// (`asks`), stands on one entry more, put up as they're typed: the question's
// own Back, its Cancel, keeps them, rather than closing the wallet with them
// (Firefox for Android honours an entry put up as the person types).

const BACK_CONTROL = "[data-back], .subnav-back";
// A step of the wallet's own that the browser said nothing of: where it
// stands is read again.
const STEP_SETTLES_MS = 1000;

const depthOf = (state) => (state && Number.isInteger(state.duskDepth) && state.duskDepth > 0 ? state.duskDepth : 0);

/**
 * @param {object} opts
 * @param {() => (null | (() => void))} opts.backStep - what Back does on the
 *   screen shown now, or null
 * @param {() => string} opts.screenKey - which screen, dialog and menu show:
 *   a change is a step in or out
 * @param {() => Promise<boolean>} [opts.onFirst] - what Back does on a first
 *   screen instead of leaving (the app goes to the background, kept as it
 *   is); false from it, and Back there is the browser's from then on
 * @param {() => boolean} [opts.asks] - whether the screen's way back asks
 *   first, with what's typed on it
 * @param {Window} [opts.win]
 * @returns {{ sync: () => void }} `sync` after a screen, a dialog or a menu
 *   changes, and after a press
 */
export function installSystemBack({ backStep, screenKey, onFirst, asks = () => false, win = globalThis.window }) {
  const history = win?.history;
  if (typeof history?.pushState !== "function") return { sync() {} };
  const doc = win.document ?? globalThis.document;
  // The wallet's entries above the page's own: where the browser is.
  let entries = depthOf(history.state);
  // A step back of the wallet's own under way, to this many entries: its
  // popstate isn't the person's.
  let target = null;
  let settleTimer = null;
  // A first screen's Back that couldn't do what `onFirst` does.
  let firstFailed = false;
  // Since the person's last Back, no press yet: nothing goes up.
  let afterBack = false;
  // The last press was a way back (← Back, Cancel, Done, Escape): its step takes an entry.
  let pressedBack = false;
  // Back's own step under way: the click it makes on ← Back isn't a press.
  let stepping = false;
  let shown = screenKey();

  const first = () => Boolean(onFirst) && !firstFailed;
  // The entries the screen shown now stands on: one with a way back, two
  // where it asks first; on a first screen with `onFirst` one, without none.
  const needed = () => (backStep() ? (asks() ? 2 : 1) : first() ? 1 : 0);
  // Whether a press allows an entry now.
  const pressing = () => !afterBack && (win.navigator?.userActivation ? win.navigator.userActivation.isActive : true);
  const push = () => {
    history.pushState({ duskBack: true, duskDepth: entries + 1 }, "");
    entries++;
  };
  // A step of the wallet's own done, or never taken: where the browser
  // stands, read from it, and what's due then.
  const settle = () => {
    clearTimeout(settleTimer);
    settleTimer = null;
    target = null;
    entries = depthOf(history.state);
    sync();
  };
  const drop = (n) => {
    if (n <= 0) return;
    target = entries - n;
    entries = target;
    history.go(-n);
    settleTimer = setTimeout(settle, STEP_SETTLES_MS);
  };

  function sync() {
    // One step of the wallet's own at a time: the next once it's done.
    if (target !== null) return;
    const key = screenKey();
    const changed = key !== shown;
    shown = key;
    const need = needed();
    // What a way back pressed takes, and what a first screen has above it, in one step.
    let leave = 0;
    if (changed && pressedBack) {
      // The page's own way back took a step: one entry goes with it.
      pressedBack = false;
      leave = Math.min(1, entries - need);
    } else if (changed && backStep() && pressing()) {
      // A step in: one more.
      push();
      return;
    }
    // A first screen keeps only what it stands on.
    if (!backStep() && entries - leave > need) leave = entries - need;
    if (leave > 0) drop(leave);
    else if (entries < need && pressing()) push();
  }

  win.addEventListener("popstate", (event) => {
    const now = depthOf(event?.state ?? history.state);
    // The wallet's own step back, done.
    if (target !== null && now === target) {
      clearTimeout(settleTimer);
      settleTimer = null;
      target = null;
      entries = now;
      setTimeout(sync, 0);
      return;
    }
    clearTimeout(settleTimer);
    settleTimer = null;
    target = null;
    const before = entries;
    entries = now;
    // Not a step back: what's due is due from here.
    if (now >= before) {
      setTimeout(sync, 0);
      return;
    }
    // The person's Back, one step inside the wallet, whatever the browser skipped.
    afterBack = true;
    pressedBack = false;
    const step = backStep();
    // A screen the step draws syncs as it's drawn; a menu or a dialog it
    // closes, a moment on. Without one, Back went where the browser takes it.
    if (step) {
      stepping = true;
      try {
        step();
      } finally {
        stepping = false;
      }
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
    if (stepping) return;
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
  // Typing, and a paste, as a press: a screen whose way back asks gets its
  // second entry as it's typed in.
  const typedIn = () => pressed(false);
  doc?.addEventListener?.("input", typedIn, true);
  doc?.addEventListener?.("paste", () => setTimeout(typedIn, 0), true);

  return { sync };
}
