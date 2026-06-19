const DECIMAL_SEP = ".";

export function sanitizeIntegerInput(value) {
  return String(value ?? "").replace(/\D/g, "");
}

export function sanitizeDecimalInput(value) {
  const raw = String(value ?? "");
  let out = "";
  let seenSep = false;

  for (const ch of raw) {
    if (ch >= "0" && ch <= "9") {
      out += ch;
      continue;
    }
    if (ch === DECIMAL_SEP && !seenSep) {
      out += ch;
      seenSep = true;
    }
  }

  return out;
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
  const sanitizer = mode === "integer" ? sanitizeIntegerInput : sanitizeDecimalInput;

  input.setAttribute("inputmode", mode === "integer" ? "numeric" : "decimal");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");

  input.addEventListener("beforeinput", (e) => {
    if (e.inputType !== "insertText") return;
    const data = String(e.data ?? "");
    if (!data) return;

    if (mode === "integer") {
      if (!/^\d+$/.test(data)) e.preventDefault();
      return;
    }

    const start = Number(input.selectionStart ?? input.value.length);
    const end = Number(input.selectionEnd ?? start);
    const next = `${input.value.slice(0, start)}${data}${input.value.slice(end)}`;
    if (sanitizeDecimalInput(next) !== next) e.preventDefault();
  });

  input.addEventListener("input", () => sanitizeWithCaret(input, sanitizer), { capture: true });
  sanitizeWithCaret(input, sanitizer);
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
