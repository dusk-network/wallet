import { UI_DISPLAY_DECIMALS, formatDusk, formatFee, groupThousands, safeBigInt } from "../../shared/amount.js";
import { h, setChildren } from "../lib/dom.js";
import { fieldLabel, integerInput } from "./FormControls.js";

// The one fee editor, on every Review and in the approval windows: the
// network fee and the total, then "Custom fee" for a gas limit and price of
// your own. By default a Review sets the network's gas price and a limit that
// suits the transaction (NetworkGas.js); a limit under the transaction's
// minimum says so while it's typed.

function maxFeeFromGasStrings(limitStr, priceStr) {
  const l = String(limitStr ?? "").trim();
  const p = String(priceStr ?? "").trim();
  if (!l && !p) return null;
  if (!/^\d+$/.test(l) || !/^\d+$/.test(p)) return null;
  try {
    return BigInt(l) * BigInt(p);
  } catch {
    return null;
  }
}

let editorSeq = 0;

export const sameGas = (a, b) =>
  Boolean(a && b) && String(a.limit ?? "") === String(b.limit ?? "") && String(a.price ?? "") === String(b.price ?? "");

export class DuskGasEditor extends HTMLElement {
  #initialized = false;

  #amountLux = 0n;
  #extraLux = [];
  #maxDecimals = UI_DISPLAY_DECIMALS;
  #helpText = "Max fee = gas limit × gas price. Clear both to use the wallet's defaults.";
  #minLimit = null;
  #networkGas = null;

  // Allows setGas() before the element is connected/rendered.
  #pendingGas = null;

  #limitInput = null;
  #priceInput = null;
  #limitError = null;
  #feeValue = null;
  #totalValue = null;
  #details = null;
  #helpNode = null;
  #resetBtn = null;
  #editContent = [];
  #editSlot = null;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    this.style.display = "block";
    this.render();
  }

  set amountLux(v) {
    this.#amountLux = safeBigInt(v, 0n);
    this.updatePreview();
  }
  get amountLux() {
    return this.#amountLux;
  }

  set extraLux(arr) {
    if (Array.isArray(arr)) {
      this.#extraLux = arr.map((v) => safeBigInt(v, 0n));
    } else if (arr == null) {
      this.#extraLux = [];
    } else {
      this.#extraLux = [safeBigInt(arr, 0n)];
    }
    this.updatePreview();
  }
  get extraLux() {
    return this.#extraLux;
  }

  set maxDecimals(v) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) {
      this.#maxDecimals = n;
    }
    this.updatePreview();
  }
  get maxDecimals() {
    return this.#maxDecimals;
  }

  set helpText(v) {
    this.#helpText = v == null ? "" : String(v);
    if (this.#helpNode) this.#helpNode.textContent = this.#helpText;
  }
  get helpText() {
    return this.#helpText;
  }

  /** The lowest gas limit this transaction takes: a limit under it says so while it's typed. */
  set minLimit(v) {
    const s = String(v ?? "").trim();
    this.#minLimit = /^\d+$/.test(s) ? BigInt(s) : null;
    this.updatePreview();
  }
  get minLimit() {
    return this.#minLimit;
  }

  /** The network's gas price and the limit that suits the transaction: what "Use the network's price" sets. */
  set networkGas(gas) {
    this.#networkGas = gas?.limit != null && gas?.price != null ? { limit: String(gas.limit), price: String(gas.price) } : null;
    this.updatePreview();
  }
  get networkGas() {
    return this.#networkGas;
  }

  /**
   * Shows `nodes` in the Custom fee panel, above the gas limit and price.
   * @param {Node|Node[]} nodes
   */
  setEditContent(nodes) {
    this.#editContent = [nodes].flat().filter(Boolean);
    if (this.#editSlot) setChildren(this.#editSlot, this.#editContent);
  }

  /**
   * Programmatically set the input values.
   * @param {{limit?:string|null, price?:string|null}|null|undefined} gas
   */
  setGas(gas) {
    this.#pendingGas = gas ?? null;

    if (this.#limitInput) {
      this.#limitInput.value =
        gas?.limit !== undefined && gas?.limit !== null ? String(gas.limit) : "";
    }
    if (this.#priceInput) {
      this.#priceInput.value =
        gas?.price !== undefined && gas?.price !== null ? String(gas.price) : "";
    }

    this.updatePreview();
  }

  getGasInputs() {
    if (!this.#limitInput) {
      const g = this.#pendingGas;
      return {
        limit: g?.limit != null ? String(g.limit).trim() : "",
        price: g?.price != null ? String(g.price).trim() : "",
      };
    }
    return {
      limit: String(this.#limitInput?.value ?? "").trim(),
      price: String(this.#priceInput?.value ?? "").trim(),
    };
  }

  // The limit typed, when it is under the transaction's minimum.
  #underMinimum() {
    const { limit } = this.getGasInputs();
    if (this.#minLimit === null || !/^\d+$/.test(limit)) return false;
    return BigInt(limit) < this.#minLimit;
  }

  #minimumText() {
    return `The gas limit can't be under ${groupThousands(this.#minLimit.toString())} for this transaction.`;
  }

  render() {
    // Build DOM only once, keep references.
    this.innerHTML = "";

    this.#limitInput = integerInput({
      placeholder: "Gas limit",
      onEnter: () => this.#priceInput?.focus?.(),
    });
    this.#priceInput = integerInput({
      placeholder: "Gas price",
      onEnter: () => {
        this.dispatchEvent(new CustomEvent("dusk-gas-enter", { bubbles: true }));
      },
    });
    const errorId = `gas-limit-error-${++editorSeq}`;
    this.#limitError = h("div", { class: "field-error", id: errorId, role: "alert", hidden: true });
    this.#limitInput.setAttribute("aria-describedby", errorId);

    this.#feeValue = h("span", { class: "kv-value gas-fee-value", text: "—" });
    this.#totalValue = h("span", { class: "kv-value gas-total-value", text: "—" });

    this.#helpNode = h("div", { class: "muted gas-help", text: this.#helpText || "" });
    this.#editSlot = h("div", { class: "gas-edit-extra" }, this.#editContent);
    this.#resetBtn = h("button", {
      class: "text-btn text-btn--inline gas-reset",
      type: "button",
      text: "Use the network's price",
      hidden: true,
      onclick: () => {
        if (this.#networkGas) this.setGas(this.#networkGas);
      },
    });

    this.#details = h("details", { class: "advanced gas-custom" }, [
      h("summary", { text: "Custom fee" }),
      h("div", { class: "advanced-body" }, [
        this.#editSlot,
        fieldLabel(this.#limitInput, "Gas limit"),
        this.#limitInput,
        this.#limitError,
        fieldLabel(this.#priceInput, "Gas price (LUX)"),
        this.#priceInput,
        this.#helpNode,
        this.#resetBtn,
      ]),
    ]);

    const group = h("div", { class: "group gas-fee" }, [
      h("div", { class: "kv" }, [h("span", { class: "kv-label", text: "Network fee" }), this.#feeValue]),
      h("div", { class: "kv" }, [h("span", { class: "kv-label", text: "Total" }), this.#totalValue]),
    ]);

    this.appendChild(group);
    this.appendChild(this.#details);

    // Live preview
    this.#limitInput.addEventListener("input", () => this.updatePreview());
    this.#priceInput.addEventListener("input", () => this.updatePreview());

    // Apply initial values (in priority order)
    if (this.#pendingGas) {
      this.setGas(this.#pendingGas);
    } else {
      // Attribute fallback (mostly for debugging)
      if (this.hasAttribute("limit")) {
        this.#limitInput.value = this.getAttribute("limit") ?? "";
      }
      if (this.hasAttribute("price")) {
        this.#priceInput.value = this.getAttribute("price") ?? "";
      }
    }

    this.updatePreview();
  }

  updatePreview() {
    if (!this.#feeValue || !this.#totalValue) return;

    const { limit, price } = this.getGasInputs();
    const feeLux = maxFeeFromGasStrings(limit, price);

    // A limit under the transaction's minimum says so under the field.
    const under = this.#underMinimum();
    this.#limitError.textContent = under ? this.#minimumText() : "";
    this.#limitError.hidden = !under;
    if (under) this.#limitInput.setAttribute("aria-invalid", "true");
    else this.#limitInput.removeAttribute("aria-invalid");

    // Back to the network's price, once the gas is your own.
    if (this.#resetBtn) this.#resetBtn.hidden = !this.#networkGas || sameGas({ limit, price }, this.#networkGas);

    if (feeLux === null) {
      this.#feeValue.textContent = "Set by the network";
      this.#feeValue.title = "";
      this.#totalValue.textContent = "—";
      this.#totalValue.title = "";
      return;
    }

    this.#feeValue.textContent = `up to ${formatFee(feeLux)} DUSK`;
    this.#feeValue.title = `Gas limit ${groupThousands(limit)} × gas price ${groupThousands(price)} LUX`;

    let totalLux = this.#amountLux + feeLux;
    for (const x of this.#extraLux) totalLux += x;

    this.#totalValue.textContent = `up to ${formatDusk(totalLux.toString(), this.#maxDecimals)} DUSK`;
    this.#totalValue.title = "";
  }

  /**
   * Read a gas object suitable for direct tx sending.
   * Returns `undefined` for auto.
   */
  readFinalGas() {
    const { limit, price } = this.getGasInputs();

    const parseU64Opt = (label, v) => {
      const s = String(v ?? "").trim();
      if (!s) return undefined;
      if (!/^\d+$/.test(s)) throw new Error(`${label} must be a whole number`);
      return s;
    };

    const gas = {};
    const gl = parseU64Opt("Gas limit", limit);
    const gp = parseU64Opt("Gas price", price);

    // Require both or none.
    if ((gl === undefined) !== (gp === undefined)) {
      throw new Error("Enter both the gas limit and the gas price, or clear both.");
    }
    if (gl !== undefined && this.#underMinimum()) throw new Error(this.#minimumText());

    if (gl !== undefined) gas.limit = gl;
    if (gp !== undefined) gas.price = gp;

    return Object.keys(gas).length ? gas : undefined;
  }

  /**
   * Read a minimal override object relative to a base gas.
   * Returns `null` if unchanged.
   * @param {{limit?:any, price?:any}|null|undefined} baseGas
   */
  readOverrideGas(baseGas) {
    const baseLimit =
      baseGas?.limit !== undefined && baseGas?.limit !== null ? String(baseGas.limit) : null;
    const basePrice =
      baseGas?.price !== undefined && baseGas?.price !== null ? String(baseGas.price) : null;

    const { limit, price } = this.getGasInputs();

    // Require both or none.
    if ((limit === "") !== (price === "")) {
      throw new Error("Enter both the gas limit and the gas price, or clear both.");
    }

    const gas = {};
    let changed = false;

    const applyField = (key, baseVal, currentVal) => {
      if (currentVal === "") {
        if (baseVal !== null) {
          gas[key] = null; // explicit clear
          changed = true;
        }
        return;
      }
      if (!/^\d+$/.test(currentVal)) {
        throw new Error(`Gas ${key} must be a whole number`);
      }
      if (baseVal === null || currentVal !== baseVal) {
        gas[key] = currentVal;
        changed = true;
      }
    };

    applyField("limit", baseLimit, limit);
    applyField("price", basePrice, price);

    if (!changed) return null;
    return { gas };
  }
}

customElements.define("dusk-gas-editor", DuskGasEditor);
