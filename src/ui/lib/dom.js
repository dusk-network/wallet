export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);

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
    if (v !== undefined) {
      el.setAttribute(k, v);
    }
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
