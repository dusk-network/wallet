import "./GasEditor.js";

export default {
  title: "Components/GasEditor",
};

function wrap(child) {
  const host = document.createElement("div");
  host.style.width = "360px";
  host.appendChild(child);
  return host;
}

export const Auto = () => {
  const el = document.createElement("dusk-gas-editor");
  el.amountLux = "1000000000"; // 1 DUSK
  el.helpText = "Auto gas (node defaults).";
  el.setGas(null);
  return wrap(el);
};

export const Manual = () => {
  const el = document.createElement("dusk-gas-editor");
  el.amountLux = "2500000000"; // 2.5 DUSK
  el.helpText = "Manual gas override.";
  el.setGas({ limit: "250000", price: "2000" });
  return wrap(el);
};

