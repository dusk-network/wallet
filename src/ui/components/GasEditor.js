import { UI_DISPLAY_DECIMALS, formatDuskExact, formatFee, groupThousands, safeBigInt } from "../../shared/amount.js";
import { h, setChildren } from "../lib/dom.js";
import { fieldLabel, integerInput } from "./FormControls.js";

// The one fee editor, on every Review and in the approval windows: the
// network fee and the total, then "Custom fee" for a gas limit and price of
// your own. By default a Review sets the network's gas price and a limit that
// suits the transaction (NetworkGas.js); a limit under the transaction's
// minimum, or a price of 0, says so while it's typed, and the fee it comes to
// shows in DUSK under the fields. While the gas won't do, `error` says why
// and a "dusk-gas-validity" event tells the page (submitOnGasEnter keeps its
// button off). A "dusk-gas-fee" event gives the most the gas comes to as it
// changes, `detail.feeLux`, null while the gas won't do or isn't set, for a
// page that shows it elsewhere too.

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

const PRICE_ZERO_TEXT = "The gas price must be at least 1 LUX.";

const showError = (input, line, text) => {
  line.textContent = text;
  line.hidden = !text;
  if (text) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
};

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
  #priceError = null;
  #maxLine = null;
  #lastError = "";
  #lastFee = undefined;
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

  // A price of 0 LUX: the network takes none.
  #priceZero() {
    const { price } = this.getGasInputs();
    return /^\d+$/.test(price) && BigInt(price) === 0n;
  }

  /** Why the gas typed won't do, or "" when it will: a limit under the minimum, or a price of 0. */
  get error() {
    if (this.#underMinimum()) return this.#minimumText();
    if (this.#priceZero()) return PRICE_ZERO_TEXT;
    return "";
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
    const priceErrorId = `gas-price-error-${editorSeq}`;
    this.#priceError = h("div", { class: "field-error", id: priceErrorId, role: "alert", hidden: true });
    this.#priceInput.setAttribute("aria-describedby", priceErrorId);
    // What the limit and price come to, at most.
    this.#maxLine = h("div", { class: "gas-max", "aria-live": "polite", hidden: true });

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
        this.#priceError,
        this.#maxLine,
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

    // A limit under the transaction's minimum, or a price of 0, says so under its field.
    showError(this.#limitInput, this.#limitError, this.#underMinimum() ? this.#minimumText() : "");
    showError(this.#priceInput, this.#priceError, this.#priceZero() ? PRICE_ZERO_TEXT : "");
    const error = this.error;
    if (error !== this.#lastError) {
      this.#lastError = error;
      this.dispatchEvent(new CustomEvent("dusk-gas-validity", { bubbles: true, detail: { error } }));
    }
    const fee = error ? null : feeLux;
    if (fee !== this.#lastFee) {
      this.#lastFee = fee;
      this.dispatchEvent(new CustomEvent("dusk-gas-fee", { bubbles: true, detail: { feeLux: fee } }));
    }

    // Back to the network's price, once the gas is your own.
    if (this.#resetBtn) this.#resetBtn.hidden = !this.#networkGas || sameGas({ limit, price }, this.#networkGas);

    // What it comes to, exactly, under the fields.
    this.#maxLine.textContent = feeLux !== null && !error ? `At most ${formatDuskExact(feeLux)} DUSK` : "";
    this.#maxLine.hidden = !this.#maxLine.textContent;

    // Gas that won't do has no fee or total to show.
    if (error) {
      this.#feeValue.textContent = "—";
      this.#feeValue.title = "";
      this.#totalValue.textContent = "—";
      this.#totalValue.title = "";
      return;
    }

    if (feeLux === null) {
      this.#feeValue.textContent = "Set by the network";
      this.#feeValue.title = "";
      this.#totalValue.textContent = "—";
      this.#totalValue.title = "";
      return;
    }

    this.#feeValue.textContent = `up to ${formatFee(feeLux, { max: true })} DUSK`;
    this.#feeValue.title = `Gas limit ${groupThousands(limit)} × gas price ${groupThousands(price)} LUX`;

    let totalLux = this.#amountLux + feeLux;
    for (const x of this.#extraLux) totalLux += x;

    // A maximum too, so it rounds up as the fee does.
    this.#totalValue.textContent = `up to ${formatFee(totalLux, { max: true })} DUSK`;
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
    if (gl !== undefined && this.error) throw new Error(this.error);

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
    // Never under the transaction's minimum, nor at a price of 0: the approval stays open to fix it.
    if (limit !== "" && this.error) throw new Error(this.error);

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
