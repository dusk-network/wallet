import { ProfileGenerator } from "@dusk/w3sper";
import { explorerAccountUrl } from "../../../shared/explorer.js";
import {
  duskNameErrorText,
  duskNameRecipient,
  duskNamesNetwork,
  isDuskName,
  lookupDuskName,
} from "../../../shared/duskNames.js";
import { openUrl } from "../../../platform/index.js";
import { h } from "../../lib/dom.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { shortAddress } from "../../lib/strings.js";
import { subnav } from "../../components/Subnav.js";
import { iconSvg } from "../../components/ActionIcon.js";
import { balancesHidden } from "../../components/Balance.js";
import { fieldLabel, searchInput, textInput } from "../../components/FormControls.js";
import { nameAddressChoice } from "../../components/NameAddressChoice.js";
import { parseDuskQrPayload } from "../../components/QrScanModal.js";
import { activityRows } from "../activity.js";
import { blockTimes, contactNames, describeTx, recentText, txRowEl, whenText } from "./txRow.js";

import {
  listAddressBook,
  markAddressBookNameChecked,
  removeAddressBookEntry,
  upsertAddressBookEntry,
} from "../../../shared/addressBook.js";

// Contacts: a list of names with the address each sends to, a contact's
// page with its activity, and a form that takes an address or a .dusk name.
// A contact saved from a .dusk name keeps the name, and its page checks the
// name again once it's an hour old: a name that points elsewhere now says so.

/** How long a contact's .dusk name stays checked before its page looks it up again. */
export const NAME_RECHECK_MS = 60 * 60_000;

// Lookups that say a saved name no longer reaches anyone.
const STALE_NAME_REASONS = new Set(["expired", "not_registered", "no_account"]);

function typeLabel(t) {
  if (t === "address") return "Shielded";
  if (t === "account") return "Public";
  return "Unknown";
}

function normalizeRecipient(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (!/^dusk:/i.test(s)) return s;
  const req = parseDuskQrPayload(s);
  if (req?.to) return String(req.to).trim();
  return s;
}

const lower = (v) => String(v ?? "").trim().toLowerCase();

/**
 * A contact's picture: the first letter of its name, as Assets shows a
 * token's; a person icon for one known by its address alone.
 * @param {string} name
 * @param {string} [className]
 */
export function contactAvatar(name, className = "row-icon contact-letter") {
  const letter = Array.from(String(name ?? "").trim())[0]?.toUpperCase() ?? "";
  return letter
    ? h("span", { class: className, "aria-hidden": "true", text: letter })
    : h("span", { class: className, "aria-hidden": "true", html: iconSvg("contacts") });
}

function ownAddresses(ov) {
  const idx = Math.max(0, Math.floor(Number(ov?.selectedAccountIndex) || 0));
  return {
    account: String(ov?.accounts?.[idx] ?? ""),
    address: String(ov?.addresses?.[idx] ?? ""),
  };
}

// "That's this wallet's own account." for this profile's account or address.
function ownText(ov, recipient) {
  const own = ownAddresses(ov);
  if (recipient && recipient === own.account) return "That's this profile's own account.";
  if (recipient && recipient === own.address) return "That's this profile's own shielded address.";
  return "";
}

const fieldError = (id) => h("div", { class: "field-error", id, role: "alert", hidden: true });
const setFieldError = (input, error, text) => {
  error.textContent = text || "";
  error.hidden = !text;
  if (text) {
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", error.id);
  } else {
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-describedby");
  }
};

let formSeq = 0;

export function addressBookView(ov, { state, actions } = {}) {
  const ab = (state.addressBook ??= {
    mode: "manage",
    fromRoute: null,
    pickReturnRoute: null,
    prefillAddress: "",
    view: "list",
    query: "",
    loaded: false,
    loading: false,
    error: null,
    items: null,
    detailId: null,
    editId: null,
    editReturnView: "list",
    editName: "",
    editAddress: "",
  });

  const backRoute = ab.fromRoute || (ab.mode === "pick" ? ab.pickReturnRoute : null) || "home";
  const rerender = () => actions?.render?.()?.catch?.(() => {});

  const goBack = () => {
    ab.view = "list";
    ab.error = null;
    state.route = backRoute;
    rerender();
  };

  // One read per visit: one that failed says why rather than asking again on
  // every redraw, and a wallet that locked meanwhile shows its unlock form.
  const ensureLoaded = () => {
    if (ab.loaded || ab.loading || ab.error) return;
    ab.loading = true;
    listAddressBook()
      .then((items) => {
        ab.items = items;
        ab.loaded = true;
        ab.loading = false;
        ab.error = null;
        rerender();
      })
      .catch((e) => {
        ab.loading = false;
        ab.error = e?.message ?? String(e);
        if (/wallet locked/i.test(ab.error)) actions?.render?.({ forceRefresh: true })?.catch?.(() => {});
        else rerender();
      });
  };

  ensureLoaded();

  const refreshItems = async () => {
    try {
      ab.items = await listAddressBook();
      ab.loaded = true;
      ab.loading = false;
      ab.error = null;
    } catch {
      ab.loaded = false;
      ab.items = null;
    }
  };

  const startEdit = (entry = null, returnView = "list") => {
    ab.view = "edit";
    ab.error = null;
    ab.editId = entry?.id ?? null;
    ab.editReturnView = returnView;
    ab.editName = entry?.name ?? String(ab.prefillName ?? "");
    // A contact saved from a .dusk name is edited by its name.
    ab.editAddress = entry ? entry.duskName || entry.address || "" : normalizeRecipient(ab.prefillAddress ?? "");
    ab.editShielded = entry?.duskName ? entry.type === "address" : false;
    rerender();
  };

  // Picks a recipient for the screen Contacts was opened from, and goes back.
  const pick = (address) => {
    state.draft = { ...(state.draft || {}), to: address };
    state.route = ab.pickReturnRoute || backRoute || "send";
    ab.view = "list";
    rerender();
  };

  const rowLine = (entry) => {
    const addr = String(entry?.address ?? "");
    const t = entry?.type || ProfileGenerator.typeOf(addr) || "unknown";
    return [entry?.duskName || shortAddress(addr), typeLabel(t)].filter(Boolean).join(" · ");
  };

  const renderList = () => {
    const q = lower(ab.query);
    const items = Array.isArray(ab.items) ? ab.items : [];
    const filtered = q
      ? items.filter((e) => [e?.name, e?.address, e?.duskName].some((v) => lower(v).includes(q)))
      : items;

    // The title names the list, so the search has no label of its own.
    const search = searchInput({
      placeholder: "Search name or address…",
      "aria-label": "Search contacts",
      value: String(ab.query ?? ""),
      oninput: (e) => {
        ab.query = String(e?.target?.value ?? "");
        rerender();
      },
    });

    const addBtn = h("button", {
      class: "btn-primary",
      type: "button",
      text: "New contact",
      onclick: () => startEdit(null),
    });

    // In pick mode, the recent recipients of this profile's sends, with Save.
    const recentGroup = (() => {
      if (ab.mode !== "pick") return null;
      const saved = new Set(items.map((e) => lower(e?.address)));
      const own = ownAddresses(ov);
      const names = contactNames(state, actions);
      const recent = [];
      for (const tx of activityRows(ov, state)) {
        if (recent.length >= 5) break;
        const d = describeTx(tx, { contactName: names, nodeUrl: ov?.nodeUrl });
        if (d.category !== "sent" || !d.address) continue;
        const key = lower(d.address);
        if (saved.has(key) || d.address === own.account || d.address === own.address) continue;
        if (recent.some((r) => lower(r.address) === key)) continue;
        recent.push(d);
      }
      if (!recent.length) return null;
      return h("section", { class: "contacts-section" }, [
        h("h2", { class: "contacts-section-title", text: "Recent" }),
        h(
          "div",
          { class: "group" },
          recent.map((d) =>
            h("div", { class: "list-row contact-row" }, [
              contactAvatar(d.isAddress ? "" : d.name),
              h("button", { class: "contact-row__main", type: "button", onclick: () => pick(d.address) }, [
                h("span", { class: d.isAddress ? "row-title mono" : "row-title", text: d.name }),
                h("span", { class: "row-sub", text: typeLabel(ProfileGenerator.typeOf(d.address)) }),
              ]),
              h("button", {
                class: "mini-btn",
                type: "button",
                text: "Save",
                "aria-label": `Save ${d.name} to Contacts`,
                onclick: () => {
                  ab.prefillAddress = d.address;
                  ab.prefillName = d.isAddress ? "" : d.name;
                  startEdit(null);
                },
              }),
            ])
          )
        ),
      ]);
    })();

    let listBody;
    if (ab.loading && !ab.loaded) listBody = h("p", { class: "contacts-empty", text: "Loading…" });
    else if (ab.error) listBody = h("div", { class: "err", text: ab.error });
    else if (!filtered.length) listBody = h("p", { class: "contacts-empty", text: q ? "No matches." : "No contacts yet." });
    else {
      listBody = h(
        "div",
        { class: "group" },
        filtered.map((entry) => {
          const addr = String(entry?.address ?? "");
          return h(
            "button",
            {
              class: "list-row contact-row",
              type: "button",
              onclick: () => {
                if (ab.mode === "pick") return pick(addr);
                ab.detailId = entry?.id ?? null;
                ab.view = "detail";
                rerender();
              },
            },
            [
              contactAvatar(String(entry?.name ?? "")),
              h("span", { class: "row-main" }, [
                h("span", { class: "row-title", text: String(entry?.name ?? "") || "(No name)" }),
                h("span", { class: entry?.duskName ? "row-sub" : "row-sub mono", text: rowLine(entry) }),
              ]),
              h("span", { class: "row-chev", "aria-hidden": "true", html: iconSvg("chev-r") }),
            ]
          );
        })
      );
    }

    return [
      subnav({ title: ab.mode === "pick" ? "Select contact" : "Contacts", onBack: goBack }),
      h("div", { class: "row contacts" }, [
        h("div", { class: "contacts-top" }, [search, addBtn]),
        recentGroup,
        recentGroup ? h("h2", { class: "contacts-section-title", text: "Contacts" }) : null,
        listBody,
      ].filter(Boolean)),
    ];
  };

  const renderDetail = () => {
    const items = Array.isArray(ab.items) ? ab.items : [];
    const entry = items.find((e) => String(e?.id ?? "") === String(ab.detailId ?? "")) || null;
    const back = () => {
      ab.view = "list";
      rerender();
    };

    if (!entry) {
      return [subnav({ title: "Contact", onBack: back }), h("p", { class: "contacts-empty", text: "This contact isn't saved any more." })];
    }

    const addr = String(entry?.address ?? "").trim();
    const typ = entry?.type || ProfileGenerator.typeOf(addr) || "unknown";
    const nodeUrl = String(ov?.nodeUrl ?? "");

    // A name an hour old is looked up again: one that points elsewhere now, or
    // nowhere (expired, released, without an address), says so. A lookup that
    // failed says nothing: the name may be fine.
    const nameCheck = h("p", { class: "field-error contact-name-check", role: "alert", hidden: true });
    if (entry.duskName && duskNamesNetwork(nodeUrl) && Date.now() - Number(entry.checkedAt || 0) > NAME_RECHECK_MS) {
      const { result, promise } = lookupDuskName(entry.duskName, { nodeUrl });
      Promise.resolve(result ?? promise)
        .then(async (res) => {
          if (!res?.ok) {
            if (STALE_NAME_REASONS.has(res?.reason)) {
              nameCheck.textContent = `${duskNameErrorText({ name: entry.duskName, reason: res.reason })} Edit the contact before you send to it.`;
              nameCheck.hidden = false;
            }
            return;
          }
          const now = duskNameRecipient(res, { shielded: typ === "address" });
          if (now === addr) {
            // On the contact as saved now: one edited or deleted meanwhile stays so.
            if (await markAddressBookNameChecked(entry)) await refreshItems();
          } else {
            nameCheck.textContent = `${entry.duskName} now points to another address. Edit the contact before you send to it.`;
            nameCheck.hidden = false;
          }
        })
        .catch(() => {});
    }

    const copyBtn = h("button", {
      class: "copy-ico",
      type: "button",
      title: "Copy address",
      "aria-label": "Copy address",
      html: iconSvg("copy"),
      onclick: async () => {
        const ok = await copyToClipboard(addr);
        actions?.showToast?.(ok ? "Address copied" : "Couldn't copy the address");
      },
    });

    const hero = h("div", { class: "tx-hero contact-hero" }, [
      contactAvatar(String(entry?.name ?? ""), "row-icon tx-hero-icon contact-letter"),
      h("h2", { class: "tx-hero-name", text: String(entry?.name ?? "") || "(No name)" }),
      entry.duskName ? h("div", { class: "tx-hero-lead", text: entry.duskName }) : null,
      h("div", { class: "tx-hero-addr" }, [h("span", { class: "mono", title: addr, text: shortAddress(addr) }), copyBtn]),
      h("span", { class: "tag", text: typeLabel(typ) }),
    ].filter(Boolean));

    const actionsRow = h("div", { class: "contact-actions" }, [
      h("button", {
        class: "btn-primary",
        type: "button",
        text: "Send",
        onclick: () => {
          state.draft = { ...(state.draft || {}), to: addr };
          state.route = "send";
          rerender();
        },
      }),
      h("button", { class: "btn-outline", type: "button", text: "Edit", onclick: () => startEdit(entry, "detail") }),
    ]);

    // This contact's transactions, as Activity shows them.
    const hidden = balancesHidden(ov);
    const names = contactNames(state, actions);
    const now = Date.now();
    const all = activityRows(ov, state);
    const times = blockTimes(all);
    // A token's counterparties too: whom it went to or came from, and whom an approval lets spend it.
    const rows = all.filter((tx) =>
      [tx?.to, tx?.from, tx?.counterparty, tx?.asset?.to, tx?.asset?.from, tx?.asset?.spender].some(
        (a) => typeof a === "string" && a && lower(a) === lower(addr)
      )
    );
    const activity = h("section", { class: "contacts-section" }, [
      h("h2", { class: "contacts-section-title", text: "Activity" }),
      rows.length
        ? h(
            "ul",
            { class: "group tx-list" },
            rows.slice(0, 20).map((tx) =>
              txRowEl(tx, {
                state,
                actions,
                hidden,
                nodeUrl,
                contactName: names,
                when: (t) => whenText(t, { times, format: (ms) => recentText(ms, now) }),
              })
            )
          )
        : h("p", { class: "contacts-empty", text: "No activity with this contact yet." }),
    ]);

    const explorerUrl = typ === "account" ? explorerAccountUrl(nodeUrl, addr) : null;
    const explorer = explorerUrl
      ? h(
          "button",
          {
            class: "text-btn tx-explorer chain-link",
            type: "button",
            onclick: async () => {
              const ok = await openUrl(explorerUrl);
              if (!ok) actions?.showToast?.("Couldn't open the explorer");
            },
          },
          [h("span", { text: "View in Dusk explorer" }), h("span", { class: "btn-ico", "aria-hidden": "true", html: iconSvg("ext") })]
        )
      : null;

    return [
      subnav({ title: "Contact", onBack: back }),
      h("div", { class: "row contact-detail" }, [hero, nameCheck, actionsRow, activity, explorer].filter(Boolean)),
    ];
  };

  const renderEdit = () => {
    const isNew = !ab.editId;
    const n = ++formSeq;

    const nameInput = textInput({
      placeholder: "e.g. Alice",
      value: String(ab.editName ?? ""),
      onEnter: () => addrInput.focus(),
      oninput: (e) => {
        ab.editName = String(e?.target?.value ?? "");
        setFieldError(nameInput, nameError, "");
      },
    });
    const nameError = fieldError(`contact-name-error-${n}`);

    const addrInput = textInput({
      placeholder: duskNamesNetwork(ov?.nodeUrl) ? "Account, shielded address or .dusk name" : "Account or shielded address",
      value: String(ab.editAddress ?? ""),
      onEnter: () => saveBtn.click(),
      oninput: (e) => {
        ab.editAddress = String(e?.target?.value ?? "");
        setFieldError(addrInput, addrError, "");
        updateAddress();
      },
    });
    const addrError = fieldError(`contact-address-error-${n}`);
    // What the field holds: the kind of address, or the addresses a .dusk name points to.
    const addrBox = h("div", { class: "contact-address-box" });

    // The latest name lookup's answer, for the text the field holds.
    let lookupFor = "";
    let resolved = null;
    let lookups = 0;

    const showResolved = (text, result) => {
      if (String(addrInput.value ?? "").trim() !== text) return;
      resolved = result;
      if (!result?.ok || (!result.account && !result.address)) {
        addrBox.replaceChildren();
        const failed = result?.ok ? { name: result.name, reason: "no_account" } : result;
        setFieldError(addrInput, addrError, duskNameErrorText(failed ?? { name: text }));
        return;
      }
      const choice = nameAddressChoice({
        name: result.name,
        account: result.account,
        address: result.address,
        shielded: Boolean(ab.editShielded) && Boolean(result.address),
        onChoose: (shielded) => {
          ab.editShielded = shielded;
          choice.set(shielded);
        },
      });
      addrBox.replaceChildren(choice.el);
    };

    const updateAddress = () => {
      const text = normalizeRecipient(addrInput.value);
      resolved = null;
      lookupFor = "";
      if (!text) {
        addrBox.replaceChildren();
        return;
      }
      if (isDuskName(text)) {
        const k = ++lookups;
        lookupFor = text;
        const { result, promise } = lookupDuskName(text, { nodeUrl: ov?.nodeUrl });
        if (result) return showResolved(text, result);
        addrBox.replaceChildren(h("p", { class: "contacts-empty", text: `Looking up ${text}…` }));
        promise.then((res) => {
          if (k === lookups) showResolved(text, res);
        });
        return;
      }
      const t = ProfileGenerator.typeOf(text);
      addrBox.replaceChildren(
        t === "account" || t === "address" ? h("span", { class: "tag", text: t === "address" ? "Shielded address" : "Public account" }) : ""
      );
    };

    // What gets saved: the address, with the .dusk name it came from.
    const target = async () => {
      const text = normalizeRecipient(addrInput.value);
      if (!text) return { error: "Enter an account, a shielded address or a .dusk name." };
      if (isDuskName(text)) {
        let result = lookupFor === text ? resolved : null;
        if (!result) {
          const { result: now, promise } = lookupDuskName(text, { nodeUrl: ov?.nodeUrl });
          result = now ?? (await promise);
        }
        if (!result?.ok || (!result.account && !result.address)) {
          const failed = result?.ok ? { name: result.name, reason: "no_account" } : result;
          return { error: duskNameErrorText(failed ?? { name: text }) };
        }
        const address = duskNameRecipient(result, { shielded: Boolean(ab.editShielded) && Boolean(result.address) });
        return { address, duskName: result.name, checkedAt: Date.now() };
      }
      const t = ProfileGenerator.typeOf(text);
      if (t !== "account" && t !== "address") return { error: "That isn't an account, a shielded address or a .dusk name." };
      return { address: text };
    };

    const saveBtn = h("button", {
      class: "btn-primary",
      type: "button",
      text: "Save",
      onclick: async () => {
        const name = String(nameInput.value ?? "").trim();
        if (!name) {
          setFieldError(nameInput, nameError, "Enter a name.");
          nameInput.focus();
          return;
        }
        saveBtn.disabled = true;
        try {
          const t = await target();
          if (t.error) {
            setFieldError(addrInput, addrError, t.error);
            addrInput.focus();
            return;
          }
          const own = ownText(ov, t.address);
          if (own) {
            setFieldError(addrInput, addrError, own);
            addrInput.focus();
            return;
          }
          if (/^dusk:/i.test(String(addrInput.value || "").trim())) {
            actions?.showToast?.("Saved the recipient from the request link", 1800);
          }
          const saved = await upsertAddressBookEntry({
            id: ab.editId || undefined,
            name,
            address: t.address,
            type: ProfileGenerator.typeOf(t.address),
            duskName: t.duskName ?? null,
            checkedAt: t.checkedAt ?? null,
          });
          await refreshItems();
          ab.prefillName = "";

          // In pick mode: after creating or editing, select it and go back.
          if (ab.mode === "pick") return pick(saved.address);

          actions?.showToast?.("Saved contact", 1600);
          if (!isNew && ab.editReturnView === "detail") {
            ab.detailId = saved.id;
            ab.view = "detail";
          } else {
            ab.view = "list";
          }
          rerender();
        } catch (e) {
          setFieldError(addrInput, addrError, e?.message ?? String(e));
        } finally {
          saveBtn.disabled = false;
        }
      },
    });

    // Back leaves without saving, so the form has no Cancel.
    const deleteBtn = !isNew
      ? h("button", {
          class: "text-btn contacts-delete",
          type: "button",
          text: "Delete contact",
          onclick: async () => {
            if (!confirm("Delete this contact?")) return;
            try {
              await removeAddressBookEntry(ab.editId);
              await refreshItems();
              actions?.showToast?.("Deleted contact", 1600);
              ab.view = "list";
              rerender();
            } catch (e) {
              actions?.showToast?.(e?.message ?? String(e), 2500);
            }
          },
        })
      : null;

    updateAddress();

    return [
      subnav({
        title: isNew ? "New contact" : "Edit contact",
        onBack: () => {
          ab.view = ab.editReturnView === "detail" ? "detail" : "list";
          rerender();
        },
      }),
      h("div", { class: "row contact-form" }, [
        fieldLabel(nameInput, "Name"),
        nameInput,
        nameError,
        fieldLabel(addrInput, "Address"),
        addrInput,
        addrError,
        addrBox,
        h("div", { class: "btnrow" }, [saveBtn]),
        deleteBtn,
      ].filter(Boolean)),
    ];
  };

  return (ab.view === "edit" ? renderEdit() : ab.view === "detail" ? renderDetail() : renderList()).filter(Boolean);
}
