// A small stand-in for the browser DOM, for testing views built with h() in
// Node. Elements keep their attributes, children, inline styles and
// listeners, events bubble up to the document, and focus is tracked. There is
// no layout. Selectors support tags, #ids, .classes and [attr] / [attr="v"],
// combined, in comma lists and with the descendant and child (>) combinators.
//
// Importing it also defines `HTMLElement` and `customElements`, so a module
// that defines a custom element can load when it is imported after this one:
// createElement then builds the tag from its class, and connectedCallback runs
// when the element joins the document.
//
// Test-only: nothing in the extension imports this.

import { vi } from "vitest";

// Custom elements defined through the fake `customElements`, by tag. As in a
// page, a definition lasts as long as the module.
const definedElements = new Map();

// Runs connectedCallback on `node` and the elements in it once they are in the
// document, as the browser does for custom elements.
function connected(node) {
  if (node.nodeType !== 1 || !node.isConnected) return;
  for (const el of [node, ...node.querySelectorAll("*")]) el.connectedCallback?.();
}

const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function styleObject() {
  const custom = new Map();
  return {
    setProperty(name, value) {
      if (name.startsWith("--")) custom.set(name, String(value));
      else this[camel(name)] = String(value);
    },
    removeProperty(name) {
      if (name.startsWith("--")) custom.delete(name);
      else delete this[camel(name)];
    },
    getPropertyValue(name) {
      return (name.startsWith("--") ? custom.get(name) : this[camel(name)]) ?? "";
    },
  };
}

// Splits on `sep` (a character or whitespace) outside [...] and quotes.
function splitOutside(text, sep) {
  const parts = [];
  let depth = 0;
  let quote = "";
  let part = "";
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
    } else if (depth === 0 && (sep === " " ? /\s/.test(ch) : ch === sep)) {
      parts.push(part);
      part = "";
      continue;
    }
    part += ch;
  }
  parts.push(part);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function parseCompound(text) {
  const out = { tag: "", ids: [], classes: [], attrs: [] };
  let i = 0;
  const ident = () => {
    const m = /^[\w-]+/.exec(text.slice(i));
    if (!m) throw new Error(`Unsupported selector: ${text}`);
    i += m[0].length;
    return m[0];
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === ".") {
      i++;
      out.classes.push(ident());
    } else if (ch === "#") {
      i++;
      out.ids.push(ident());
    } else if (ch === "[") {
      const end = text.indexOf("]", i);
      const body = text.slice(i + 1, end);
      i = end + 1;
      const eq = body.indexOf("=");
      out.attrs.push(
        eq < 0
          ? [body.trim(), null]
          : [body.slice(0, eq).trim(), body.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2")]
      );
    } else if (ch === "*") {
      i++;
    } else {
      out.tag = ident().toLowerCase();
    }
  }
  return out;
}

function matchesCompound(el, text) {
  if (el?.nodeType !== 1) return false;
  const { tag, ids, classes, attrs } = parseCompound(text);
  if (tag && el.localName !== tag) return false;
  if (ids.some((id) => el.id !== id)) return false;
  if (classes.some((c) => !el.classList.contains(c))) return false;
  return attrs.every(([name, value]) =>
    value === null ? el.hasAttribute(name) : el.getAttribute(name) === value
  );
}

// Matches parts[i] at `el`, and the parts before it through their combinators.
function matchesFrom(el, parts, i) {
  if (!matchesCompound(el, parts[i].compound)) return false;
  if (i === 0) return true;
  if (parts[i - 1].child) return matchesFrom(el.parentNode, parts, i - 1);
  for (let n = el.parentNode; n?.nodeType === 1; n = n.parentNode) {
    if (matchesFrom(n, parts, i - 1)) return true;
  }
  return false;
}

function matchesSelector(el, selector) {
  return splitOutside(selector, ",").some((complex) => {
    // "a > b c": compounds with the child (>) or descendant combinator between them.
    const parts = [];
    for (const token of splitOutside(complex, " ")) {
      if (token === ">") parts.at(-1).child = true;
      else parts.push({ compound: token, child: false });
    }
    return matchesFrom(el, parts, parts.length - 1);
  });
}

/**
 * A DOM-like event; listeners may preventDefault() or stopPropagation().
 * @param {string} type
 * @param {object} [props] - e.g. { key: "ArrowDown" }
 */
export function fakeEvent(type, props = {}) {
  return {
    type,
    bubbles: true,
    target: null,
    currentTarget: null,
    defaultPrevented: false,
    cancelBubble: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.cancelBubble = true;
    },
    ...props,
  };
}

function addListener(node, type, fn) {
  node._listeners.push({ type, fn });
}

function removeListener(node, type, fn) {
  node._listeners = node._listeners.filter((l) => l.type !== type || l.fn !== fn);
}

function dispatch(start, given) {
  // A real Event (a component's CustomEvent) keeps its target read-only: a
  // plain copy goes round instead.
  const event =
    typeof Event !== "undefined" && given instanceof Event
      ? fakeEvent(given.type, { bubbles: given.bubbles, detail: given.detail })
      : given;
  if (!event.target) event.target = start;
  for (let node = start; node; node = node.parentNode) {
    event.currentTarget = node;
    for (const { type, fn } of [...(node._listeners ?? [])]) {
      if (type === event.type) fn.call(node, event);
    }
    const handler = node[`on${event.type}`];
    if (typeof handler === "function") handler.call(node, event);
    if (!event.bubbles || event.cancelBubble) break;
  }
  return !event.defaultPrevented;
}

class FakeText {
  constructor(text, doc) {
    this.nodeType = 3;
    this.data = String(text);
    this.parentNode = null;
    this.ownerDocument = doc;
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = String(value ?? "");
  }

  remove() {
    this.parentNode?.removeChild(this);
  }
}

class FakeElement {
  constructor(tagName, doc) {
    this.nodeType = 1;
    this.localName = String(tagName).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
    this.dataset = {};
    this.style = styleObject();
    this.offsetWidth = 0;
    this.offsetHeight = 0;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this._attrs = new Map();
    this._listeners = [];
    this._value = null;
    this._html = "";
  }

  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.ownerDocument;
  }

  appendChild(child) {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    connected(child);
    return child;
  }

  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, child);
    connected(child);
    return child;
  }

  removeChild(child) {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(this.#node(node));
  }

  prepend(...nodes) {
    for (const node of nodes.reverse()) this.insertBefore(this.#node(node), this.firstChild);
  }

  replaceChildren(...nodes) {
    this.#clear();
    this.append(...nodes);
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  #node(node) {
    return typeof node === "string" ? this.ownerDocument.createTextNode(node) : node;
  }

  #clear() {
    for (const child of [...this.childNodes]) this.removeChild(child);
    this._html = "";
  }

  setAttribute(name, value) {
    const text = String(value);
    this._attrs.set(name, text);
    if (name === "style") {
      for (const decl of text.split(";")) {
        const colon = decl.indexOf(":");
        if (colon > 0) this.style.setProperty(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim());
      }
    }
  }

  getAttribute(name) {
    return this._attrs.has(name) ? this._attrs.get(name) : null;
  }

  hasAttribute(name) {
    return this._attrs.has(name);
  }

  removeAttribute(name) {
    this._attrs.delete(name);
  }

  get id() {
    return this.getAttribute("id") ?? "";
  }

  set id(value) {
    this.setAttribute("id", value);
  }

  get className() {
    return this.getAttribute("class") ?? "";
  }

  set className(value) {
    this.setAttribute("class", value);
  }

  get title() {
    return this.getAttribute("title") ?? "";
  }

  set title(value) {
    this.setAttribute("title", value);
  }

  get classList() {
    const el = this;
    const list = () => el.className.split(/\s+/).filter(Boolean);
    const set = (names) => {
      el.className = names.join(" ");
    };
    return {
      contains: (name) => list().includes(name),
      add: (...names) => set([...new Set([...list(), ...names])]),
      remove: (...names) => set(list().filter((n) => !names.includes(n))),
      toggle(name, force) {
        const on = force === undefined ? !list().includes(name) : Boolean(force);
        if (on) this.add(name);
        else this.remove(name);
        return on;
      },
    };
  }

  get value() {
    return this._value ?? this.getAttribute("value") ?? "";
  }

  set value(value) {
    this._value = String(value ?? "");
  }

  get textContent() {
    return this.childNodes.map((n) => n.textContent).join("");
  }

  set textContent(value) {
    this.#clear();
    const text = String(value ?? "");
    if (text) this.appendChild(this.ownerDocument.createTextNode(text));
  }

  get innerHTML() {
    return this._html;
  }

  // Markup is kept as is, not parsed: views only set SVG icons this way.
  set innerHTML(value) {
    this.#clear();
    this._html = String(value ?? "");
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  closest(selector) {
    for (let n = this; n?.nodeType === 1; n = n.parentNode) if (n.matches(selector)) return n;
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  addEventListener(type, fn) {
    addListener(this, type, fn);
  }

  removeEventListener(type, fn) {
    removeListener(this, type, fn);
  }

  dispatchEvent(event) {
    return dispatch(this, event);
  }

  click() {
    if (this.disabled) return;
    this.dispatchEvent(fakeEvent("click"));
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  }

  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}

for (const prop of ["hidden", "disabled", "checked", "open"]) {
  Object.defineProperty(FakeElement.prototype, prop, {
    get() {
      return this.hasAttribute(prop);
    },
    set(on) {
      if (on) this.setAttribute(prop, "");
      else this.removeAttribute(prop);
    },
  });
}

// The fake `HTMLElement`, for custom elements to extend: an instance is a fake
// element of the tag its class was defined for, in the current document.
class FakeHTMLElement extends FakeElement {
  constructor() {
    const tag = [...definedElements].find(([, cls]) => cls === new.target)?.[0];
    super(tag ?? "div", globalThis.document);
  }
}

globalThis.HTMLElement ??= FakeHTMLElement;
globalThis.customElements ??= {
  define(tag, cls) {
    definedElements.set(String(tag).toLowerCase(), cls);
  },
  get(tag) {
    return definedElements.get(String(tag).toLowerCase());
  },
};

class FakeDocument {
  constructor({ elements = {} } = {}) {
    this._listeners = [];
    this._elements = elements;
    this.documentElement = this.createElement("html");
    this.body = this.createElement("body");
    this.documentElement.appendChild(this.body);
    // Events bubble from the page up to the document.
    this.documentElement.parentNode = this;
    this.activeElement = this.body;
  }

  /** A defined custom tag is built from its class; `elements` upgrades other custom tags. */
  createElement(tagName) {
    const Defined = definedElements.get(String(tagName).toLowerCase());
    const el = Defined ? new Defined() : new FakeElement(tagName, this);
    this._elements[el.localName]?.(el);
    return el;
  }

  createTextNode(text) {
    return new FakeText(text, this);
  }

  getElementById(id) {
    return this.documentElement.querySelectorAll("[id]").find((el) => el.id === id) ?? null;
  }

  querySelector(selector) {
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }

  addEventListener(type, fn) {
    addListener(this, type, fn);
  }

  removeEventListener(type, fn) {
    removeListener(this, type, fn);
  }
}

/**
 * Installs a fresh fake `document` and `window` (plus `location`,
 * `requestAnimationFrame` and a clipboard) as globals; undo it with
 * vi.unstubAllGlobals().
 *
 * @param {object} [opts]
 * @param {Record<string, (el: object) => void>} [opts.elements] - custom tags to upgrade
 * @param {string} [opts.pathname] - the page's path, as env.js reads it
 * @param {string} [opts.language] - the browser's language, which times follow:
 *   British English by default, with its 24-hour clock
 * @returns {{ document: FakeDocument, window: object, clipboard: { writeText: Function } }}
 */
export function installFakeDom({ elements, pathname = "/index.html", language = "en-GB" } = {}) {
  const document = new FakeDocument({ elements });
  const window = {
    innerWidth: 400,
    innerHeight: 600,
    _listeners: [],
    addEventListener(type, fn) {
      addListener(this, type, fn);
    },
    removeEventListener(type, fn) {
      removeListener(this, type, fn);
    },
  };
  const clipboard = { writeText: vi.fn(async () => {}) };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("location", { pathname, search: "" });
  vi.stubGlobal("navigator", { clipboard, language });
  vi.stubGlobal("requestAnimationFrame", (fn) => setTimeout(() => fn(Date.now()), 0));
  vi.stubGlobal("alert", vi.fn());
  return { document, window, clipboard };
}

/** Whether `el` and every element around it are shown (not hidden, no display:none). */
export function isShown(el) {
  for (let n = el; n?.nodeType === 1; n = n.parentNode) {
    if (n.hidden || n.style.display === "none") return false;
  }
  return true;
}

// The text under `node`, leaving out hidden elements and those `skip` picks.
function textWithout(node, skip) {
  if (node.nodeType === 3) return node.data;
  if (node.hidden || node.style.display === "none" || skip(node)) return "";
  return node.childNodes.map((child) => textWithout(child, skip)).join("");
}

/** The text `el` shows: without hidden parts and the screen-reader-only (.sr-only) ones. */
export const visibleText = (el) => textWithout(el, (n) => n.classList.contains("sr-only"));

/** The text screen readers get from `el`: without hidden and aria-hidden parts. */
export const screenReaderText = (el) => textWithout(el, (n) => n.getAttribute("aria-hidden") === "true");

/**
 * The name screen readers give `el`, looked for in the order browsers look:
 * the elements aria-labelledby names, aria-label, the <label>s tied to it (by
 * `for`, or around it), its title, and last its placeholder.
 * @param {object} el
 * @returns {string}
 */
export function accessibleName(el) {
  const doc = el.ownerDocument;
  const clean = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
  const labelledBy = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
  if (labelledBy.length) {
    return clean(labelledBy.map((id) => doc.getElementById(id)?.textContent ?? "").join(" "));
  }
  const ariaLabel = clean(el.getAttribute("aria-label"));
  if (ariaLabel) return ariaLabel;
  const labels = doc
    .querySelectorAll("label")
    .filter((label) => (el.id && label.getAttribute("for") === el.id) || label.contains(el));
  // A label around the field names it by its own text, not the field's.
  const labelText = clean(
    labels.map((label) => textWithout(label, (n) => n === el || ["select", "textarea"].includes(n.localName))).join(" ")
  );
  if (labelText) return labelText;
  return clean(el.getAttribute("title")) || clean(el.getAttribute("placeholder"));
}

/** The accessible names of the form fields shown under `root`, in order. */
export const fieldNames = (root) =>
  root
    .querySelectorAll("input, select, textarea")
    .filter((field) => field.getAttribute("type") !== "file" && isShown(field))
    .map(accessibleName);

/** Types `value` into an input the way the browser reports it: value, then an input event. */
export function typeInto(input, value) {
  input.value = value;
  input.dispatchEvent(fakeEvent("input"));
}

/** Presses `key` on `el` (a keydown that bubbles). */
export function press(el, key) {
  return el.dispatchEvent(fakeEvent("keydown", { key }));
}

/** Lets queued promise jobs and timers run, as they do before the next paint. */
export const settle = () => new Promise((resolve) => setTimeout(resolve));
