// What Firefox's password manager makes of a page's fields, for tests in the
// fake DOM: the fields it reads as passwords, the username it pairs with each,
// and whether it offers a generated password of its own on one. After
// Firefox's toolkit/components/passwordmgr: LoginFormFactory (a field's form,
// or every field outside a form, read as one), LoginManager.shared.sys.mjs
// (Logic.isUsernameFieldType, Logic.isProbablyANewPasswordField) and the
// new-password model in NewPasswordModel.sys.mjs, with the features a page of
// the wallet's can carry and their weights. Firefox offers its own password
// where the model's score is 0.75 or more (signon.generation.confidenceThreshold).
//
// Test-only: nothing in the extension imports this.

import { isShown } from "./fakeDom.js";

const NEW = /new|erstellen|create|choose|設定|신규|Créer|Nouveau|baru|nouă|nieuw/i;
const NEW_ATTR = /new/i;
const CONFIRM =
  /wiederholen|wiederholung|confirm|repeat|confirmation|verify|retype|repite|確認|の確認|تکرار|re-enter|확인|bevestigen|confirme|Повторите|tassyklamak|再次输入|ještě jednou|gentag|re-type|confirmar|Répéter|conferma|Repetaţi|again|reenter|再入力|재입력|Ulangi|Bekræft/i;
const CONFIRM_ATTR = /confirm|retype/i;
const CURRENT = /current|old|aktuelles|derzeitiges|当前|Atual|actuel|curentă|sekarang/i;

const BIAS = -1.3525885343551636;
const WEIGHTS = {
  hasNewLabel: 2.9195094108581543,
  hasConfirmLabel: 2.1672143936157227,
  hasCurrentLabel: -2.1813206672668457,
  closestLabelMatchesNew: 2.965045213699341,
  closestLabelMatchesConfirm: 2.698647975921631,
  closestLabelMatchesCurrent: -2.147423505783081,
  hasNewAriaLabel: 2.8312134742736816,
  hasConfirmAriaLabel: 1.5153108835220337,
  hasCurrentAriaLabel: -4.368860244750977,
  hasNewPlaceholder: 1.4374250173568726,
  hasConfirmPlaceholder: 1.717592477798462,
  hasCurrentPlaceholder: -1.9401700496673584,
  elementAttrsMatchNew: 2.8492355346679688,
  elementAttrsMatchConfirm: 1.9043376445770264,
  elementAttrsMatchCurrent: -2.056903839111328,
  formHasMultipleVisibleInput: 2.81270694732666,
  nextInputIsConfirmy: 2.5344431400299072,
};
const THRESHOLD = 0.75;

// The kinds of field the model counts beside a password.
const COUNTED = new Set(["email", "password", "text", "tel"]);
// The fields Firefox takes for a username, and the autocomplete values it takes them with.
const USERNAME_TYPES = new Set(["text", "email", "url", "tel", "number", "search"]);
const USERNAME_AUTOCOMPLETE = new Set(["", "on", "off", "username", "webauthn", "email", "tel", "tel-national"]);

const typeOf = (el) => String(el.getAttribute("type") ?? "text").toLowerCase();
const isInput = (el) => el?.localName === "input";
const isPassword = (el) => isInput(el) && typeOf(el) === "password";

// Every element under `root` (a document: under its root element), in document order.
function inOrder(root) {
  if (root?.documentElement) return [root.documentElement, ...inOrder(root.documentElement)];
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes ?? []) {
      if (child.nodeType !== 1) continue;
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

const formOf = (el) => el.parentNode?.closest?.("form") ?? null;

// The fields Firefox reads together with `field`: its form's, or every field
// outside a form on the page.
function formLike(doc, field) {
  const form = formOf(field);
  return form ? inOrder(form).filter(isInput) : inOrder(doc).filter((el) => isInput(el) && !formOf(el));
}

/**
 * The username Firefox pairs with a password field: the field before it, in
 * what it reads with it, that can be one. Null for none.
 * @param {object} doc - the fake document
 * @param {object} password - an <input type=password>
 */
export function usernameFor(doc, password) {
  const fields = formLike(doc, password);
  for (let i = fields.indexOf(password) - 1; i >= 0; i--) {
    const el = fields[i];
    if (isPassword(el) || !USERNAME_TYPES.has(typeOf(el))) continue;
    if (!USERNAME_AUTOCOMPLETE.has(String(el.getAttribute("autocomplete") ?? "").trim().toLowerCase())) continue;
    return el;
  }
  return null;
}

const text = (el) => String(el?.textContent ?? "");

// The label the model reads for `el`: its first <label>, else what aria-labelledby names.
function labelText(doc, el) {
  const label = doc.querySelectorAll("label").find((l) => (el.id && l.getAttribute("for") === el.id) || l.contains(el));
  if (label) return text(label);
  const ids = String(el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
  return ids.map((id) => text(doc.getElementById(id))).join(" ");
}

// The <label> beside `el`, before or after it, else any in its form.
function closestLabels(el) {
  const siblings = el.parentNode?.children ?? [];
  const at = siblings.indexOf(el);
  const near = [siblings[at - 1], siblings[at + 1]].filter((n) => n?.localName === "label");
  if (near.length) return near.slice(0, 1).map(text);
  const form = formOf(el);
  return form ? form.querySelectorAll("label").map(text) : [];
}

const attrsMatch = (el, regex) => [el.id, el.getAttribute("name"), el.className].some((v) => regex.test(String(v ?? "")));

// Three or more fields a person types in shown in the field's form, it among
// them; outside a form, under the element it shares with the field before it.
function formHasMultipleVisibleInput(doc, el) {
  let scope = formOf(el);
  if (!scope) {
    const all = inOrder(doc).filter((n) => isInput(n) && COUNTED.has(typeOf(n)));
    const before = all.slice(0, all.indexOf(el)).at(-1);
    if (!before) return false;
    scope = before.parentNode;
    while (scope && !scope.contains?.(el)) scope = scope.parentNode;
    if (!scope) return false;
  }
  return inOrder(scope).filter((n) => isInput(n) && COUNTED.has(typeOf(n)) && (n === el || isShown(n))).length >= 3;
}

function nextInputIsConfirmy(el) {
  const form = formOf(el);
  if (!form) return false;
  const fields = inOrder(form).filter(isInput);
  const next = fields[fields.indexOf(el) + 1];
  return Boolean(next) && isPassword(next) && !next.disabled && attrsMatch(next, CONFIRM_ATTR);
}

/**
 * The new-password model's score for a password field: 0.75 or more, and
 * Firefox offers a password of its own over it.
 * @param {object} doc - the fake document
 * @param {object} field - an <input type=password>
 * @returns {number}
 */
export function newPasswordScore(doc, field) {
  const label = labelText(doc, field);
  const closest = closestLabels(field);
  const aria = String(field.getAttribute("aria-label") ?? "");
  const placeholder = String(field.getAttribute("placeholder") ?? "");
  const features = {
    hasNewLabel: NEW.test(label),
    hasConfirmLabel: CONFIRM.test(label),
    hasCurrentLabel: CURRENT.test(label),
    closestLabelMatchesNew: closest.some((t) => NEW.test(t)),
    closestLabelMatchesConfirm: closest.some((t) => CONFIRM.test(t)),
    closestLabelMatchesCurrent: closest.some((t) => CURRENT.test(t)),
    hasNewAriaLabel: NEW.test(aria),
    hasConfirmAriaLabel: CONFIRM.test(aria),
    hasCurrentAriaLabel: CURRENT.test(aria),
    hasNewPlaceholder: NEW.test(placeholder),
    hasConfirmPlaceholder: CONFIRM.test(placeholder),
    hasCurrentPlaceholder: CURRENT.test(placeholder),
    elementAttrsMatchNew: attrsMatch(field, NEW_ATTR),
    elementAttrsMatchConfirm: attrsMatch(field, CONFIRM_ATTR),
    elementAttrsMatchCurrent: attrsMatch(field, CURRENT),
    formHasMultipleVisibleInput: formHasMultipleVisibleInput(doc, field),
    nextInputIsConfirmy: nextInputIsConfirmy(field),
  };
  const sum = Object.entries(features).reduce((acc, [name, on]) => acc + (on ? WEIGHTS[name] : 0), BIAS);
  return 1 / (1 + Math.exp(-sum));
}

/**
 * The page as Firefox's password manager reads it: each password field, with
 * the username it pairs with it and whether it offers a password of its own.
 * @param {object} doc - the fake document
 * @returns {Array<{ field: object, username: object | null, offersPassword: boolean }>}
 */
export function passwordManagerView(doc) {
  return inOrder(doc)
    .filter(isPassword)
    .map((field) => ({ field, username: usernameFor(doc, field), offersPassword: newPasswordScore(doc, field) >= THRESHOLD }));
}
