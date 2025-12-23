import { formatLuxShort, safeBigInt } from "../../shared/amount.js";
import { h } from "../lib/dom.js";

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

export class DuskGasEditor extends HTMLElement {
  #initialized = false;

  #amountLux = 0n;
  #extraLux = [];
  #maxDecimals = 6;
  #helpText = "";

  // Allows setGas() before the element is connected/rendered.
  #pendingGas = null;

  #limitInput = null;
  #priceInput = null;
  #feeCode = null;
  #totalCode = null;
  #detailsWrap = null;
  #editBtn = null;
  #helpNode = null;

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
    return {
      limit: String(this.#limitInput?.value ?? "").trim(),
      price: String(this.#priceInput?.value ?? "").trim(),
    };
  }

  render() {
    // Build DOM only once, keep references.
    this.innerHTML = "";

    this.#limitInput = h("input", {
      placeholder: "Gas limit (optional)",
      inputmode: "numeric",
    });
    this.#priceInput = h("input", {
      placeholder: "Gas price (optional)",
      inputmode: "numeric",
    });

    this.#feeCode = h("code", { text: "Auto" });
    this.#totalCode = h("code", { text: "—" });

    this.#helpNode = h("div", { class: "muted", text: this.#helpText || "" });

    this.#detailsWrap = h("div", { class: "row", style: "display:none" }, [
      h("div", { class: "row" }, [
        h("label", { text: "Gas limit" }),
        this.#limitInput,
        h("label", { text: "Gas price" }),
        this.#priceInput,
      ]),
      this.#helpNode,
    ]);

    this.#editBtn = h("button", {
      class: "link-btn",
      text: "Edit",
      onclick: () => {
        const open = this.#detailsWrap.style.display !== "none";
        this.#detailsWrap.style.display = open ? "none" : "block";
        this.#editBtn.textContent = open ? "Edit" : "Hide";
      },
    });

    const feeRow = h("div", { class: "hrow" }, [
      h("div", { class: "muted", text: "Network fee (max)" }),
      h("div", { class: "hrow-right" }, [this.#feeCode, this.#editBtn]),
    ]);

    const totalRow = h("div", { class: "hrow" }, [
      h("div", { class: "muted", text: "Total (max)" }),
      this.#totalCode,
    ]);

    const box = h("div", { class: "box" }, [feeRow, totalRow]);

    // When embedded, callers want the same layout as before:
    // box first, then details.
    this.appendChild(box);
    this.appendChild(this.#detailsWrap);

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
    if (!this.#feeCode || !this.#totalCode) return;

    const { limit, price } = this.getGasInputs();
    const feeLux = maxFeeFromGasStrings(limit, price);

    if (feeLux === null) {
      this.#feeCode.textContent = "Auto";
      this.#feeCode.title = "Gas not specified";
      this.#totalCode.textContent = "—";
      this.#totalCode.title = "";
      return;
    }

    const feeDusk = `${formatLuxShort(feeLux.toString(), this.#maxDecimals)} DUSK`;
    this.#feeCode.textContent = feeDusk;
    this.#feeCode.title = `Gas limit: ${limit} · Gas price: ${price}`;

    let totalLux = this.#amountLux + feeLux;
    for (const x of this.#extraLux) totalLux += x;

    this.#totalCode.textContent = `${formatLuxShort(totalLux.toString(), this.#maxDecimals)} DUSK`;
    // Keep tooltip minimal (deposit/extra amounts can be shown elsewhere)
    this.#totalCode.title = `Amount: ${this.#amountLux.toString()} Lux · Max fee: ${feeLux.toString()} Lux`;
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
      if (!/^\d+$/.test(s)) throw new Error(`${label} must be an integer`);
      return s;
    };

    const gas = {};
    const gl = parseU64Opt("Gas limit", limit);
    const gp = parseU64Opt("Gas price", price);

    // Require both or none.
    if ((gl === undefined) !== (gp === undefined)) {
      throw new Error(
        "Provide both gas limit and gas price (or clear both to use node defaults)."
      );
    }

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
      throw new Error(
        "Provide both gas limit and gas price (or clear both to use node defaults)."
      );
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
        throw new Error(`Gas ${key} must be an integer`);
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
