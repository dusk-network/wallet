export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);

  // HTML boolean attributes must be present (no value) to be truthy.
  // Setting disabled="false" still disables an element.
  const BOOL_ATTRS = new Set([
    "disabled",
    "checked",
    "selected",
    "readonly",
    "multiple",
    "required",
    "autofocus",
    "hidden",
    "open",
    "controls",
    "loop",
    "muted",
    "playsinline",
  ]);

  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") {
      el.className = v || "";
      continue;
    }
    if (k === "text") {
      el.textContent = v == null ? "" : String(v);
      continue;
    }
    if (k === "html") {
      el.innerHTML = v == null ? "" : String(v);
      continue;
    }
    if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.substring(2), v);
      continue;
    }
    if (v === undefined || v === null) continue;

    if (BOOL_ATTRS.has(k)) {
      if (v) el.setAttribute(k, "");
      continue;
    }

    // For non-boolean attributes, keep booleans as explicit string values
    el.setAttribute(k, typeof v === "boolean" ? String(v) : v);
  }

  const arr = Array.isArray(children) ? children : [children];
  for (const c of arr) {
    if (c == null) continue;
    el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }

  return el;
}

export function setChildren(host, children = []) {
  if (!host) return;
  host.innerHTML = "";
  const arr = Array.isArray(children) ? children : [children];
  for (const child of arr) {
    if (child == null) continue;
    host.appendChild(child);
  }
}
