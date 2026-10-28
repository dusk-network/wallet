import { h } from "../../lib/dom.js";
import { passwordInput } from "../../components/FormControls.js";

export function lockedView({ state, actions } = {}) {
  const pwd = passwordInput({
    id: "unlock-password",
    autocomplete: "current-password",
    placeholder: "Password",
    onEnter: () => btn.click(),
  });

  // A wrong password says so under the field, where the eyes are.
  const errLine = h("div", { id: "unlock-error", class: "field-error", role: "alert", hidden: true });
  const showError = (text) => {
    errLine.textContent = text || "";
    errLine.hidden = !text;
    if (text) {
      pwd.setAttribute("aria-invalid", "true");
      pwd.setAttribute("aria-describedby", "unlock-error");
    } else {
      pwd.removeAttribute("aria-invalid");
      pwd.removeAttribute("aria-describedby");
    }
  };
  pwd.addEventListener("input", () => showError(""));

  // The button says "Unlocking…" meanwhile.
  const busyCallout = h("p", { class: "auth-note", style: "display:none", text: "This can take a moment." });

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
      showError("");

      try {
        const res = await actions?.send?.({ type: "DUSK_UI_UNLOCK", password: pwd.value });
        if (res?.error) throw new Error(res.error.message ?? "Unlock failed");
        state.needsRefresh = true;
        // Refresh even a replacement unlock form, but leave other views alone.
        if (!document.getElementById("unlock-password")) return;
        pwd.value = "";
        await actions?.render?.({ forceRefresh: true });
      } catch (err) {
        if (pwd.isConnected) showError(err?.message ?? String(err));
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
    h("div", { class: "auth-page" }, [
      h("h1", { class: "auth-title", text: "Unlock your wallet" }),
      h("div", { class: "row" }, [h("label", { for: "unlock-password", text: "Password" }), pwd, errLine]),
      btn,
      busyCallout,
    ]),
  ];
}
