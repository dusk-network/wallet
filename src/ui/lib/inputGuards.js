export function sanitizeIntegerInput(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function sanitizeWithCaret(input, sanitizer) {
  if (!input) return;
  const before = String(input.value ?? "");
  const after = sanitizer(before);
  if (after === before) return;

  const start = Number(input.selectionStart ?? before.length);
  const sanitizedBefore = sanitizer(before.slice(0, Math.max(0, start)));

  input.value = after;

  try {
    const pos = Math.min(sanitizedBefore.length, after.length);
    input.setSelectionRange(pos, pos);
  } catch {
    // These guards target text inputs, but tolerate platform selection quirks.
  }
}

export function installNumericInputGuard(input, { mode = "decimal" } = {}) {
  if (!input) return input;

  input.setAttribute("inputmode", mode === "integer" ? "numeric" : "decimal");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");

  // A decimal field keeps what's typed, and what reads it says if it's no
  // amount: taking out a comma would turn 0,1 into 1.
  if (mode !== "integer") return input;

  input.addEventListener("beforeinput", (e) => {
    if (e.inputType !== "insertText") return;
    const data = String(e.data ?? "");
    if (data && !/^\d+$/.test(data)) e.preventDefault();
  });

  input.addEventListener("input", () => sanitizeWithCaret(input, sanitizeIntegerInput), { capture: true });
  sanitizeWithCaret(input, sanitizeIntegerInput);
  return input;
}

export function installPrimaryEnter(input, action) {
  if (!input || typeof action !== "function") return input;
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    action(e);
  });
  return input;
}
