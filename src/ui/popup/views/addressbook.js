import { ProfileGenerator } from "@dusk/w3sper";
import { h } from "../../lib/dom.js";
import { subnav } from "../../components/Subnav.js";
import { identiconEl } from "../../components/Identicon.js";
import { truncateMiddle } from "../../lib/strings.js";

import {
  clearAddressBook,
  listAddressBook,
  removeAddressBookEntry,
  upsertAddressBookEntry,
} from "../../../shared/addressBook.js";
import { parseDuskQrPayload } from "../../components/QrScanModal.js";

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
    editId: null,
    editName: "",
    editAddress: "",
  });

  const backRoute = ab.fromRoute || (ab.mode === "pick" ? ab.pickReturnRoute : null) || "home";

  const goBack = () => {
    ab.view = "list";
    ab.error = null;
    state.route = backRoute;
    actions?.render?.().catch(() => {});
  };

  const ensureLoaded = () => {
    if (ab.loaded || ab.loading) return;
    ab.loading = true;
    listAddressBook()
      .then((items) => {
        ab.items = items;
        ab.loaded = true;
        ab.loading = false;
        ab.error = null;
        actions?.render?.().catch(() => {});
      })
      .catch((e) => {
        ab.loading = false;
        ab.error = e?.message ?? String(e);
        actions?.render?.().catch(() => {});
      });
  };

  ensureLoaded();

  const startEdit = async (entry = null) => {
    ab.view = "edit";
    ab.error = null;
    ab.editId = entry?.id ?? null;
    ab.editName = entry?.name ?? "";
    ab.editAddress = entry?.address ?? normalizeRecipient(ab.prefillAddress ?? "");
    actions?.render?.().catch(() => {});
  };

  const renderList = () => {
    const q = String(ab.query ?? "").trim();
    const ql = q.toLowerCase();

    const items = Array.isArray(ab.items) ? ab.items : [];
    const filtered = q
      ? items.filter((e) => {
          const name = String(e?.name ?? "").toLowerCase();
          const addr = String(e?.address ?? "").toLowerCase();
          return name.includes(ql) || addr.includes(ql);
        })
      : items;

    const title = ab.mode === "pick" ? "Select contact" : "Contacts";

    const search = h("input", {
      placeholder: "Search name or address…",
      value: String(ab.query ?? ""),
      oninput: (e) => {
        ab.query = String(e?.target?.value ?? "");
        actions?.render?.().catch(() => {});
      },
    });

    const addBtn = h("button", {
      class: "btn-primary",
      text: "New contact",
      onclick: () => startEdit(null),
    });

    const clearBtn = ab.mode === "manage"
      ? h("button", {
          class: "btn-outline",
          text: "Clear",
          onclick: async () => {
            const ok = confirm("Clear all saved contacts?");
            if (!ok) return;
            try {
              await clearAddressBook();
              ab.loaded = false;
              ab.items = null;
              ab.query = "";
              actions?.showToast?.("Cleared contacts");
              actions?.render?.().catch(() => {});
            } catch (e) {
              actions?.showToast?.(e?.message ?? String(e), 2500);
            }
          },
        })
      : null;

    const topRow = h("div", { class: "row" }, [
      h("label", { text: "Contacts" }),
      search,
      h("div", { class: "btnrow" }, [clearBtn, addBtn].filter(Boolean)),
    ]);

    const list = h("div", { class: "activity-list" });

    // In pick mode, show recent recipients (from Activity) with a quick Save action.
    try {
      if (ab.mode === "pick") {
        const saved = new Set();
        for (const e of items) {
          const addr = String(e?.address ?? "").trim();
          if (addr) saved.add(addr.toLowerCase());
        }

        const recent = [];
        const txs = Array.isArray(ov?.txs) ? ov.txs : [];
        for (const t of txs) {
          if (recent.length >= 6) break;
          if (String(t?.kind ?? "") !== "transfer") continue;
          const addr = String(t?.to ?? "").trim();
          if (!addr) continue;
          const key = addr.toLowerCase();
          if (saved.has(key)) continue;
          if (recent.some((r) => r.key === key)) continue;
          const typ = ProfileGenerator.typeOf(addr) || "unknown";
          recent.push({ key, addr, typ });
        }

        if (recent.length) {
          list.appendChild(h("div", { class: "muted", text: "Recent" }));
          for (const r of recent) {
            const pill = h("span", { class: "meta-pill", text: typeLabel(r.typ) });
            const saveBtn = h("button", {
              class: "icon-btn icon-only",
              type: "button",
              text: "＋",
              title: "Save to Contacts",
              onclick: (e) => {
                try {
                  e?.stopPropagation?.();
                  ab.prefillAddress = r.addr;
                  ab.view = "edit";
                  ab.error = null;
                  ab.editId = null;
                  ab.editName = "";
                  ab.editAddress = r.addr;
                  actions?.render?.().catch(() => {});
                } catch {
                  // ignore
                }
              },
            });

            const row = h(
              "div",
              {
                class: "activity-item",
                role: "button",
                tabindex: "0",
                onclick: () => {
                  // Pick and return.
                  state.draft = {
                    ...(state.draft || {}),
                    to: r.addr,
                  };
                  state.route = ab.pickReturnRoute || backRoute || "send";
                  actions?.render?.().catch(() => {});
                },
              },
              [
                h("div", { class: "activity-ico" }, [identiconEl(r.addr || "dusk")]),
                h("div", { class: "activity-main" }, [
                  h("div", { class: "activity-title" }, [
                    h("span", { text: truncateMiddle(r.addr, 10, 8) }),
                  ]),
                  h("div", { class: "activity-sub", text: "Recent recipient" }),
                ]),
                h("div", { class: "activity-right" }, [pill, saveBtn]),
              ]
            );
            list.appendChild(row);
          }
          list.appendChild(h("div", { class: "divider" }));
        }
      }
    } catch {
      // ignore
    }

    if (ab.loading && !ab.loaded) {
      list.appendChild(h("div", { class: "muted", text: "Loading…" }));
    } else if (ab.error) {
      list.appendChild(h("div", { class: "err", text: ab.error }));
    } else if (!filtered.length) {
      list.appendChild(
        h("div", { class: "muted", text: q ? "No matches" : "No contacts yet" })
      );
    } else {
      for (const entry of filtered) {
        const addr = String(entry?.address ?? "");
        const t = entry?.type || ProfileGenerator.typeOf(addr) || "unknown";

        const pill = h("span", { class: "meta-pill", text: typeLabel(t) });
        const chevron = h("span", { class: "activity-chevron", text: "›" });

        const btn = h(
          "button",
          {
            class: "activity-item",
            type: "button",
            onclick: async () => {
              if (ab.mode === "pick") {
                // Fill recipient and go back.
                state.draft = {
                  ...(state.draft || {}),
                  to: addr,
                };
                state.route = ab.pickReturnRoute || backRoute || "send";
                actions?.render?.().catch(() => {});
                return;
              }
              await startEdit(entry);
            },
          },
          [
            h("div", { class: "activity-ico" }, [identiconEl(addr || "dusk")]),
            h("div", { class: "activity-main" }, [
              h("div", { class: "activity-title" }, [
                h("span", { text: String(entry?.name ?? "") || "(Unnamed)" }),
              ]),
              h("div", {
                class: "activity-sub",
                text: addr ? truncateMiddle(addr, 10, 8) : "—",
              }),
            ]),
            h("div", { class: "activity-right" }, [pill, chevron]),
          ]
        );

        list.appendChild(btn);
      }
    }

    return [
      subnav({
        title,
        onBack: goBack,
      }),
      topRow,
      h("div", { class: "row" }, [list]),
    ];
  };

  const renderEdit = () => {
    const isNew = !ab.editId;

    const nameInput = h("input", {
      placeholder: "Name (e.g. Alice)",
      value: String(ab.editName ?? ""),
      oninput: (e) => {
        ab.editName = String(e?.target?.value ?? "");
      },
    });

    const addrInput = h("input", {
      placeholder: "Address (public account or shielded)",
      value: String(ab.editAddress ?? ""),
      oninput: (e) => {
        ab.editAddress = String(e?.target?.value ?? "");
        // Re-render to update detection pill.
        actions?.render?.().catch(() => {});
      },
    });

    const addrRaw = normalizeRecipient(ab.editAddress);
    const t = addrRaw ? ProfileGenerator.typeOf(addrRaw) : null;

    const detectPill = addrRaw
      ? h("span", {
          class: "meta-pill",
          text: t === "address" ? "Shielded address" : t === "account" ? "Public account" : "Unknown format",
        })
      : null;

    const errBox = h("div", { class: "err", style: "display:none" });
    const setErr = (msg) => {
      if (!msg) {
        errBox.style.display = "none";
        errBox.textContent = "";
        return;
      }
      errBox.style.display = "block";
      errBox.textContent = String(msg);
    };

    const saveBtn = h("button", {
      class: "btn-primary",
      text: "Save",
      onclick: async () => {
        try {
          setErr("");
          const name = String(nameInput.value ?? "").trim();
          const addr0 = normalizeRecipient(addrInput.value);
          const addr = String(addr0 ?? "").trim();

          if (!name) throw new Error("Name is required");
          if (!addr) throw new Error("Address is required");

          // If the user pasted a dusk: request, store only the recipient.
          if (/^dusk:/i.test(String(addrInput.value || "").trim()) && addr !== String(addrInput.value || "").trim()) {
            actions?.showToast?.("Stored recipient from request link", 1800);
          }

          const typ = ProfileGenerator.typeOf(addr);
          if (typ !== "account" && typ !== "address") {
            throw new Error("Address must be a valid public account or shielded address");
          }

          const saved = await upsertAddressBookEntry({
            id: ab.editId || undefined,
            name,
            address: addr,
            type: typ,
          });

          // Refresh cache.
          try {
            ab.items = await listAddressBook();
            ab.loaded = true;
            ab.loading = false;
            ab.error = null;
          } catch {
            // If refresh fails, leave the cache as-is.
          }

          // In pick mode: after creating/editing, immediately select and return.
          if (ab.mode === "pick") {
            state.draft = {
              ...(state.draft || {}),
              to: saved.address,
            };
            state.route = ab.pickReturnRoute || backRoute || "send";
            ab.view = "list";
            actions?.render?.().catch(() => {});
            return;
          }

          actions?.showToast?.("Saved contact", 1600);
          ab.view = "list";
          actions?.render?.().catch(() => {});
        } catch (e) {
          setErr(e?.message ?? String(e));
        }
      },
    });

    const cancelBtn = h("button", {
      class: "btn-outline",
      text: "Cancel",
      onclick: () => {
        ab.view = "list";
        actions?.render?.().catch(() => {});
      },
    });

    const deleteBtn = !isNew
      ? h("button", {
          class: "btn-destructive",
          text: "Delete",
          onclick: async () => {
            const ok = confirm("Delete this contact?");
            if (!ok) return;
            try {
              await removeAddressBookEntry(ab.editId);
              try {
                ab.items = await listAddressBook();
                ab.loaded = true;
                ab.loading = false;
                ab.error = null;
              } catch {
                ab.loaded = false;
                ab.items = null;
              }
              actions?.showToast?.("Deleted contact", 1600);
              ab.view = "list";
              actions?.render?.().catch(() => {});
            } catch (e) {
              setErr(e?.message ?? String(e));
            }
          },
        })
      : null;

    return [
      subnav({
        title: isNew ? "New contact" : "Edit contact",
        onBack: () => {
          ab.view = "list";
          actions?.render?.().catch(() => {});
        },
      }),
      h("div", { class: "row" }, [
        h("label", { text: "Name" }),
        nameInput,
        h("label", { text: "Address" }),
        addrInput,
        detectPill,
        errBox,
        h("div", { class: "btnrow" }, [cancelBtn, deleteBtn, saveBtn].filter(Boolean)),
      ]),
    ];
  };

  return (ab.view === "edit" ? renderEdit() : renderList()).filter(Boolean);
}
