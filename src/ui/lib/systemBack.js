// A phone's Back button, as one step back inside the wallet.
//
// Firefox's add-on page and the app's WebView take Back to the page's history,
// and with none to go back to they close the wallet, with whatever was typed.
// So while a screen has a way back (`backStep`: its ← Back, a dialog's Cancel,
// an open menu), one history entry of the wallet's stands above the page's
// own; Back takes it away, and the wallet takes that step instead. On a first
// screen there's none, and Back leaves the wallet as it always did.
//
// Pushed only after the person has pressed something in the page: browsers
// skip, on Back, history a page added before anyone used it.

/**
 * @param {{ backStep: () => (null | (() => void)), win?: Window }} opts -
 *   `backStep` gives what Back does on the screen shown now, or null
 * @returns {{ sync: () => void }} `sync` after a screen, a dialog or a menu
 *   changes: the entry is put up or taken away to match
 */
export function installSystemBack({ backStep, win = globalThis.window }) {
  const history = win?.history;
  if (typeof history?.pushState !== "function") return { sync() {} };
  // Whether the wallet's entry is the one shown now.
  let above = false;
  // Our own Back, taking the entry away: its popstate isn't the person's.
  let leaving = 0;

  const sync = () => {
    const wanted = Boolean(backStep());
    if (wanted && !above) {
      history.pushState({ duskBack: true }, "");
      above = true;
    } else if (!wanted && above) {
      above = false;
      leaving++;
      history.back();
    }
  };

  win.addEventListener("popstate", () => {
    if (leaving) {
      leaving--;
      return;
    }
    above = false;
    const step = backStep();
    // A screen the step draws syncs again as it's drawn; a menu or a dialog
    // it closes, a moment on. Without one, Back went where the browser takes it.
    if (step) {
      step();
      setTimeout(sync, 0);
    } else sync();
  });

  return { sync };
}
