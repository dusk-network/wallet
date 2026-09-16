import { h } from "../../lib/dom.js";
import { passwordInput } from "../../components/FormControls.js";

export function lockedView({ state, actions } = {}) {
  const pwd = passwordInput({
    id: "unlock-password",
    autocomplete: "current-password",
    placeholder: "Password",
    onEnter: () => btn.click(),
  });

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
      if (busy || !pwd.isConnected) return;
      busy = true;
      btn.disabled = true;
      pwd.disabled = true;
      btn.textContent = "Unlocking…";
      busyCallout.style.display = "block";

      try {
        const res = await actions?.send?.({ type: "DUSK_UI_UNLOCK", password: pwd.value });
        if (res?.error) throw new Error(res.error.message ?? "Unlock failed");
        state.needsRefresh = true;
        // Navigation may have discarded this form while unlocking.
        if (!pwd.isConnected) return;
        pwd.value = "";
        await actions?.render?.({ forceRefresh: true });
      } catch (err) {
        if (pwd.isConnected) actions?.showToast?.(err?.message ?? String(err), 2500);
      } finally {
        pwd.value = "";
        busy = false;
        btn.disabled = false;
        pwd.disabled = false;
        btn.textContent = "Unlock";
        busyCallout.style.display = "none";
      }
    },
  });
  return [
    h("div", { class: "muted", text: "Wallet is locked." }),
    h("div", { class: "row" }, [h("label", { for: "unlock-password", text: "Password" }), pwd]),
    busyCallout,
    h("div", { class: "btnrow" }, [btn]),
  ].filter(Boolean);
}
