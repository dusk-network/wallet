import { NAME_HIDES, nameHides } from "@dusk-network/app-core/names";
import { searchKey } from "@dusk-network/app-core/text";
import { isAccount } from "@dusk-network/networks/account";
import { ProfileGenerator } from "@dusk/w3sper";
import { isDuskName } from "@duskdomains/sdk/names";
import { explorerAccountUrl } from "../../../shared/explorer.js";
import { duskNameErrorText, duskNameRecipient, duskNamesNetwork, lookupDuskName } from "../../../shared/duskNames.js";
import { nameCheckNote } from "../../../shared/nodeNetwork.js";
import { openUrl } from "../../../platform/index.js";
import { h } from "../../lib/dom.js";
import { joinedAddress, passesForDuskName } from "../../lib/recipient.js";
import { waiting } from "../../components/Waiting.js";
import { shortAddress } from "../../lib/strings.js";
import { subnav } from "../../components/Subnav.js";
import { iconSvg } from "../../components/ActionIcon.js";
import { copyButton } from "../../components/CopyButton.js";
import { balancesHidden } from "../../components/Balance.js";
import { fieldLabel, searchInput, textInput } from "../../components/FormControls.js";
import { nameAddressChoice } from "../../components/NameAddressChoice.js";
import { nameCheckNoteEl } from "../../components/NameCheckNote.js";
import { ownProfileName } from "../../components/ProfileName.js";
import { HIDDEN_NAME_NOTE, HIDDEN_NAME_ROW, contactAlikeText, contactNameClash, contactNameStartsText, contactNameText } from "../../lib/contactNames.js";
import { parseDuskQrPayload } from "../../components/QrScanModal.js";
import { activityRows } from "../activity.js";
import { contactNames, describeTx, recentText, txRowEl, whenText } from "./txRow.js";

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

// A request link, `dusk:` or https: the recipient it asks to be paid.
const requestRecipient = (text) => {
  const req = parseDuskQrPayload(text);
  return req && req.form !== "raw" ? String(req.to).trim() : "";
};

function normalizeRecipient(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  return requestRecipient(s) || (/^dusk:/i.test(s) ? s : joinedAddress(s));
}

const lower = (v) => String(v ?? "").trim().toLowerCase();

/**
 * A contact's picture: the first letter of its name, as Assets shows a
 * token's; a person icon for one known by its address alone.
 * @param {string} name
 * @param {string} [className]
 */
export function contactAvatar(name, className = "row-icon contact-letter") {
  // A name with hidden characters, saved before they were refused, has none: its first may be one.
  const letter = nameHides(name) ? "" : (Array.from(String(name ?? "").trim())[0]?.toUpperCase() ?? "");
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
  // The wallet whose contacts these are, as drawn: a change is for it alone.
  const shown = { walletId: ov?.isUnlocked ? String(ov.accounts?.[0] ?? "") : "" };
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

  const startEdit = (entry = null, returnView = "list", shielded = false) => {
    ab.view = "edit";
    ab.error = null;
    ab.editId = entry?.id ?? null;
    ab.editReturnView = returnView;
    ab.editName = entry?.name ?? String(ab.prefillName ?? "");
    // A contact saved from a .dusk name is edited by its name.
    ab.editAddress = entry ? entry.duskName || entry.address || "" : normalizeRecipient(ab.prefillAddress ?? "");
    ab.editShielded = entry?.duskName ? entry.type === "address" : shielded;
    rerender();
  };

  // Picks a recipient for the screen Contacts was opened from, and goes back.
  // Another recipient than a link or a QR code filled in, as one typed: what
  // that request said of it, its network and "Filled in from…", goes.
  const pick = (address) => {
    const before = state.draft || {};
    const other = String(before.to ?? "") !== address;
    state.draft = { ...before, to: address, ...(other ? { requestChainId: undefined, refusedChainId: undefined, refusedProblem: undefined, filledFrom: undefined } : {}) };
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
    // In any case, and with or without accents (app-core's searchKey).
    const q = searchKey(ab.query);
    const items = Array.isArray(ab.items) ? ab.items : [];
    const filtered = q
      ? items.filter((e) => [e?.name, e?.address, e?.duskName].some((v) => searchKey(v).includes(q)))
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

    // In pick mode, the recent recipients of this profile's sends, with Save:
    // with a search, those it finds, as it finds contacts.
    const recentGroup = (() => {
      if (ab.mode !== "pick") return null;
      const saved = new Set(items.map((e) => lower(e?.address)));
      const own = ownAddresses(ov);
      const names = contactNames(state, actions, ov);
      const recent = [];
      for (const tx of activityRows(ov, state)) {
        if (recent.length >= 5) break;
        const d = describeTx(tx, { contactName: names, nodeUrl: ov?.nodeUrl });
        if (d.category !== "sent" || !d.address) continue;
        const key = lower(d.address);
        if (saved.has(key) || d.address === own.account || d.address === own.address) continue;
        if (recent.some((r) => lower(r.address) === key)) continue;
        if (q && ![d.name, d.address].some((v) => searchKey(v).includes(q))) continue;
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
                  // Named after a .dusk name, it's saved from that name.
                  const fromName = !d.isAddress && isDuskName(d.name);
                  ab.prefillAddress = fromName ? d.name : d.address;
                  ab.prefillName = d.isAddress ? "" : d.name;
                  startEdit(null, "list", fromName && ProfileGenerator.typeOf(d.address) === "address");
                },
              }),
            ])
          )
        ),
      ]);
    })();

    let listBody;
    if (ab.loading && !ab.loaded) listBody = waiting("Loading…", { tag: "p", className: "contacts-empty" });
    else if (ab.error) listBody = h("div", { class: "err", text: ab.error });
    else if (!filtered.length) listBody = h("p", { class: "contacts-empty", text: q ? "No matches." : "No contacts yet." });
    else {
      listBody = h(
        "div",
        { class: "group" },
        filtered.map((entry) => {
          const addr = String(entry?.address ?? "");
          // One whose name looks like another's shows its address, not its .dusk name, and says so;
          // one saved with hidden characters in its name shows them as codes, and says so too.
          const alike = contactAlikeText(ov, entry, items);
          const hides = nameHides(entry?.name);
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
                h("span", { class: "row-title", text: contactNameText(entry?.name) || "(No name)" }),
                h("span", { class: entry?.duskName && !alike ? "row-sub" : "row-sub mono", text: alike ? rowLine({ ...entry, duskName: null }) : rowLine(entry) }),
                alike ? h("span", { class: "row-sub contact-alike", text: alike }) : null,
                hides ? h("span", { class: "row-sub contact-alike", text: HIDDEN_NAME_ROW }) : null,
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
    const nodeSays = (text) => [text, nameCheckNote(nodeUrl)].filter(Boolean).join(" ");
    if (entry.duskName && duskNamesNetwork(nodeUrl) && Date.now() - Number(entry.checkedAt || 0) > NAME_RECHECK_MS) {
      const { result, promise } = lookupDuskName(entry.duskName, { nodeUrl });
      Promise.resolve(result ?? promise)
        .then(async (res) => {
          if (!res?.ok) {
            if (STALE_NAME_REASONS.has(res?.reason)) {
              nameCheck.textContent = nodeSays(`${duskNameErrorText({ name: entry.duskName, reason: res.reason })} Edit the contact before you send to it.`);
              nameCheck.hidden = false;
            }
            return;
          }
          const now = duskNameRecipient(res, { shielded: typ === "address" });
          if (now === addr) {
            // On the contact as saved now: one edited or deleted meanwhile stays so.
            // A node the wallet doesn't know vouches for nothing, so it stays due.
            if (!nameCheckNote(nodeUrl) && (await markAddressBookNameChecked(entry, Date.now(), shown))) await refreshItems();
          } else {
            nameCheck.textContent = nodeSays(`${entry.duskName} now points to another address. Edit the contact before you send to it.`);
            nameCheck.hidden = false;
          }
        })
        .catch(() => {});
    }

    const copyBtn = copyButton({ value: addr, label: "Copy address", failText: "Couldn't copy the address", onFail: actions?.showToast });
    // Saved with hidden characters in its name, before they were refused: shown as codes, and said.
    const hiddenName = nameHides(entry?.name) ? h("p", { class: "field-error contact-hidden-name", role: "note", text: HIDDEN_NAME_NOTE }) : null;

    const hero = h("div", { class: "tx-hero contact-hero" }, [
      contactAvatar(String(entry?.name ?? ""), "row-icon tx-hero-icon contact-letter"),
      h("h2", { class: "tx-hero-name", text: contactNameText(entry?.name) || "(No name)" }),
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
    const names = contactNames(state, actions, ov);
    const now = Date.now();
    // A token's counterparties too: whom it went to or came from, and whom an approval lets spend it.
    const rows = activityRows(ov, state).filter(({ counterparty, sent }) =>
      [counterparty, sent?.to, sent?.asset?.to, sent?.asset?.from, sent?.asset?.spender].some(
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
                when: (row) => whenText(row, (ms) => recentText(ms, now)),
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
      h("div", { class: "row contact-detail" }, [hero, hiddenName, nameCheck, actionsRow, activity, explorer].filter(Boolean)),
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
        updateName();
      },
    });
    const nameError = fieldError(`contact-name-error-${n}`);
    // A name in use, or one that looks like it in other letters: only the
    // address would tell the two apart in a payment. It can be saved. One
    // that is, or looks like, a profile's would read as that profile on
    // Review: it can't be, for anyone else's address.
    const nameNote = h("div", { class: "send-self-note contact-note", role: "status", hidden: true });
    const profileClashText = (clash) =>
      clash.same ? `That's the name of your profile ${clash.entry.name}. Choose another name.` : `That looks like the name of your profile ${clash.entry.name}. Choose another name.`;
    const clashNow = () =>
      contactNameClash(ov, nameInput.value, { address: normalizeRecipient(addrInput.value), contacts: Array.isArray(ab.items) ? ab.items : [], except: ab.editId ?? undefined });
    const updateName = () => {
      const typed = String(nameInput.value ?? "").trim();
      // What can't be seen can make it read as another name: refused, before any other check.
      if (nameHides(typed)) {
        setFieldError(nameInput, nameError, NAME_HIDES);
        nameNote.textContent = "";
        nameNote.hidden = true;
        return;
      }
      const clash = typed ? clashNow() : null;
      const at = (e) => `${contactNameText(e.name)}, at ${shortAddress(String(e.address ?? ""))}`;
      setFieldError(nameInput, nameError, clash?.kind === "profile" ? profileClashText(clash) : "");
      // A profile's name it starts with, or that starts it, is asked about: it can be saved.
      const starts = typed && !clash ? contactNameStartsText(ov, typed, { address: normalizeRecipient(addrInput.value) }) : "";
      nameNote.textContent =
        clash?.kind !== "contact" ? starts : clash.same ? `You already have a contact called ${at(clash.entry)}.` : `This looks like your contact ${at(clash.entry)}, but uses different letters.`;
      nameNote.hidden = !nameNote.textContent;
    };

    const addrInput = textInput({
      placeholder: duskNamesNetwork(ov?.nodeUrl) ? "Account, shielded address or .dusk name" : "Account or shielded address",
      value: String(ab.editAddress ?? ""),
      onEnter: () => saveBtn.click(),
      oninput: (e) => {
        ab.editAddress = String(e?.target?.value ?? "");
        setFieldError(addrInput, addrError, "");
        updateAddress();
        // A profile's name is its own address's to take.
        updateName();
      },
    });
    const addrError = fieldError(`contact-address-error-${n}`);
    // What the field holds: the kind of address, or the addresses a .dusk name points to.
    const addrBox = h("div", { class: "contact-address-box" });
    // Another profile's own address, here or in another wallet: it can be saved, and it's said.
    const addrNote = h("div", { class: "send-self-note contact-note", role: "status", hidden: true });
    const noteOwn = (addresses) => {
      const shown = addresses.filter(Boolean);
      const own = shown.find((a) => ownText(ov, a));
      const profile = own ? "" : shown.map((a) => ownProfileName(ov, a)).find(Boolean);
      // This profile's own says so as an error: it can't be saved.
      if (own) setFieldError(addrInput, addrError, ownText(ov, own));
      addrNote.textContent = profile ? `That's your own profile: ${profile}.` : "";
      addrNote.hidden = !profile;
    };

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
      addrBox.replaceChildren(...[choice.el, nameCheckNoteEl(ov?.nodeUrl)].filter(Boolean));
      noteOwn([result.account, result.address]);
    };

    const updateAddress = () => {
      const text = normalizeRecipient(addrInput.value);
      resolved = null;
      lookupFor = "";
      noteOwn([]);
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
      if (t === "account" && !isAccount(text)) {
        addrBox.replaceChildren();
        setFieldError(addrInput, addrError, "Not a valid address. Check it and try again.");
        return;
      }
      addrBox.replaceChildren(
        t === "account" || t === "address" ? h("span", { class: "tag", text: t === "address" ? "Shielded address" : "Public account" }) : ""
      );
      noteOwn([text]);
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
        // A node the wallet doesn't know vouches for nothing: on a network's own node, it's looked up at once.
        return { address, duskName: result.name, checkedAt: nameCheckNote(String(ov?.nodeUrl ?? "")) ? 0 : Date.now() };
      }
      const t = ProfileGenerator.typeOf(text);
      if (t === "account" && !isAccount(text)) return { error: "Not a valid address. Check it and try again." };
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
        if (nameHides(name)) {
          setFieldError(nameInput, nameError, NAME_HIDES);
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
          if (passesForDuskName(name, t.duskName)) {
            setFieldError(nameInput, nameError, "That looks like a .dusk name. Enter it as the address below, or choose another name.");
            nameInput.focus();
            return;
          }
          const own = ownText(ov, t.address);
          if (own) {
            setFieldError(addrInput, addrError, own);
            addrInput.focus();
            return;
          }
          const clash = contactNameClash(ov, name, { address: t.address, contacts: Array.isArray(ab.items) ? ab.items : [], except: ab.editId ?? undefined });
          if (clash?.kind === "profile") {
            setFieldError(nameInput, nameError, profileClashText(clash));
            nameInput.focus();
            return;
          }
          const other = (Array.isArray(ab.items) ? ab.items : []).find((e) => e?.address === t.address && e?.id !== ab.editId);
          if (other) {
            setFieldError(addrInput, addrError, `This address is already saved as ${contactNameText(other.name)}.`);
            addrInput.focus();
            return;
          }
          if (requestRecipient(String(addrInput.value || "").trim())) {
            actions?.showToast?.("Saved the recipient from the request link", 1800);
          }
          const saved = await upsertAddressBookEntry({
            id: ab.editId || undefined,
            name,
            address: t.address,
            type: ProfileGenerator.typeOf(t.address),
            duskName: t.duskName ?? null,
            checkedAt: t.checkedAt ?? null,
          }, shown);
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
              await removeAddressBookEntry(ab.editId, shown);
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

    updateName();
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
        nameNote,
        fieldLabel(addrInput, "Address"),
        addrInput,
        addrError,
        addrNote,
        addrBox,
        h("div", { class: "btnrow" }, [saveBtn]),
        deleteBtn,
      ].filter(Boolean)),
    ];
  };

  return (ab.view === "edit" ? renderEdit() : ab.view === "detail" ? renderDetail() : renderList()).filter(Boolean);
}
