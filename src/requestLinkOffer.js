// On the web wallet, opened from a request link: an offer to pay it with this
// extension instead. No extension can catch the click on an https link, and no
// browser lets one register dusk:, so the link opens the web wallet for everyone.
// Here, for someone with a wallet in this extension, Open Send opens the
// extension's own Send, filled in. It only offers: the page stays as it is.
//
// NOTE: MV3 content scripts run as classic scripts, not modules, and share one
// scope with the extension's other content script: no static `import` statements,
// and nothing declared outside the function below, or neither runs.

(() => {
  const ext = typeof globalThis !== "undefined" ? globalThis.browser ?? globalThis.chrome ?? null : null;

  // The link stays with this tab until it's answered: the web wallet, with no wallet
  // open, goes on to its unlock or setup page as a new page.
  const KEPT = "dusk-wallet-request-link";

  function requestLink() {
    const { href = "", pathname = "", search = "" } = globalThis.location ?? {};
    try {
      if (/\/dashboard\/send\/?$/.test(pathname) && new URLSearchParams(search).get("to")) sessionStorage.setItem(KEPT, href);
      return sessionStorage.getItem(KEPT);
    } catch {
      return /\/dashboard\/send\/?$/.test(pathname) && new URLSearchParams(search).get("to") ? href : null;
    }
  }

  function answered() {
    try {
      sessionStorage.removeItem(KEPT);
    } catch {
      // Nothing kept.
    }
  }

  const styled = (el, css) => {
    // Styles set from here are no inline <style> for the page's CSP to refuse.
    el.style.cssText = css;
    return el;
  };

  const BUTTON = "font:inherit;font-weight:500;padding:8px 14px;border-radius:999px;cursor:pointer;border:1px solid rgba(242,240,235,0.16);";

  function button(text, css, onPress) {
    const el = styled(document.createElement("button"), BUTTON + css);
    el.type = "button";
    el.textContent = text;
    el.addEventListener("click", (event) => {
      // A person's press: nothing the page itself fires.
      if (event.isTrusted !== false) onPress();
    });
    return el;
  }

  function showOffer(link) {
    // A web wallet that offers the extension itself (dusk_openPaymentLink) says so in its head: no second offer.
    if (document.querySelector('meta[name="dusk-wallet-request-handoff"]')) return;
    const host = document.createElement("dusk-wallet-offer");
    // Closed: the page can neither restyle it nor press its buttons.
    const root = host.attachShadow({ mode: "closed" });
    const card = styled(
      document.createElement("div"),
      "position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:320px;padding:16px;display:flex;flex-direction:column;gap:12px;" +
        "background:#18181B;color:#F2F0EB;border:1px solid rgba(242,240,235,0.16);border-radius:12px;font:14px/1.4 system-ui,sans-serif;"
    );
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Dusk Wallet");
    const title = styled(document.createElement("div"), "font-weight:500;");
    title.textContent = "Pay this with your Dusk Wallet extension?";
    const actions = styled(document.createElement("div"), "display:flex;justify-content:flex-end;gap:8px;");
    actions.append(
      button("Not now", "background:transparent;color:#F2F0EB;", () => {
        answered();
        host.remove();
      }),
      button("Open Send", "background:#F2F0EB;color:#141416;", () => {
        ext.runtime.sendMessage({ type: "DUSK_REQUEST_LINK_OPEN", link }).catch(() => {});
        answered();
        host.remove();
      })
    );
    card.append(title, actions);
    root.append(card);
    (document.body ?? document.documentElement).append(host);
  }

  function whenPageIsThere(run) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
    else run();
  }

  const link = requestLink();

  // The wallet says whether this is such a link, and whether it has a wallet to pay with.
  if (link) {
    Promise.resolve(ext?.runtime?.sendMessage?.({ type: "DUSK_REQUEST_LINK_OFFER", link }))
      .then((answer) => {
        if (answer?.offer) whenPageIsThere(() => showOffer(link));
      })
      .catch(() => {});
  }
})();
