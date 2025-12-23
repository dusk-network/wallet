import { h } from "../../lib/dom.js";
import { bannerView } from "../../components/Banner.js";

export function lockedView({ state, actions } = {}) {
  const pwd = h("input", { type: "password", placeholder: "Password" });

  const busyTitle = h("div", { class: "callout-title", text: "Unlocking…" });
  const busyBody = h("div", {
    class: "muted",
    text: "Decrypting your vault. This can take a moment on some devices.",
  });
  const busyCallout = h("div", { class: "callout", style: "display:none" }, [busyTitle, busyBody]);

  let busy = false;
  const btn = h("button", {
    class: "btn-primary btn-full",
    text: "Unlock",
    onclick: async () => {
      if (busy) return;
      busy = true;
      btn.disabled = true;
      pwd.disabled = true;
      btn.textContent = "Unlocking…";
      busyCallout.style.display = "block";

      const res = await actions?.send?.({ type: "DUSK_UI_UNLOCK", password: pwd.value });
      if (res?.error) {
        // Re-enable UI and show error banner.
        busy = false;
        btn.disabled = false;
        pwd.disabled = false;
        btn.textContent = "Unlock";
        busyCallout.style.display = "none";

        state.banner = { kind: "error", text: res.error.message };
        await actions?.render?.();
        return;
      }

      state.banner = null;
      state.needsRefresh = true;
      await actions?.render?.({ forceRefresh: true });
    },
  });

  return [
    bannerView(state.banner),
    h("div", { class: "muted", text: "Wallet is locked." }),
    h("div", { class: "row" }, [h("label", { text: "Password" }), pwd]),
    busyCallout,
    h("div", { class: "btnrow" }, [btn]),
  ].filter(Boolean);
}
