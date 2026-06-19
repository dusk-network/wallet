import { ProfileGenerator } from "@dusk/w3sper";
import { UI_DISPLAY_DECIMALS, formatLuxShort, safeBigInt } from "../../../shared/amount.js";
import { explorerAccountUrl } from "../../../shared/explorer.js";
import { openUrl } from "../../../platform/index.js";
import { h } from "../../lib/dom.js";
import { subnav } from "../../components/Subnav.js";
import { identiconEl } from "../../components/Identicon.js";
import { truncateMiddle } from "../../lib/strings.js";
import { searchInput, textInput } from "../../components/FormControls.js";
import { TX_KIND } from "../../../shared/constants.js";

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

function sameAddress(a, b) {
  const aa = String(a ?? "").trim().toLowerCase();
  const bb = String(b ?? "").trim().toLowerCase();
  return !!aa && !!bb && aa === bb;
}

function txAddresses(tx) {
  const asset = tx?.asset && typeof tx.asset === "object" ? tx.asset : null;
  return [
    tx?.to,
    tx?.from,
    asset?.to,
    asset?.from,
    asset?.spender,
  ].filter((v) => typeof v === "string" && v.trim());
}

function contactTxs(txs, address) {
  const addr = String(address ?? "").trim();
  if (!addr) return [];
  return (Array.isArray(txs) ? txs : []).filter((tx) =>
    txAddresses(tx).some((candidate) => sameAddress(candidate, addr))
  );
}

function timeAgo(ts) {
  const t = Number(ts || 0);
  if (!t) return "";
  const ms = Date.now() - t;
  if (ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${Math.max(1, s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const hhr = Math.floor(m / 60);
  if (hhr < 24) return `${hhr}h`;
  return `${Math.floor(hhr / 24)}d`;
}

function formatTokenUnits(units, decimals, { maxFrac = 6 } = {}) {
  const u = safeBigInt(units, 0n);
  let d = Number(decimals ?? 0);
  if (!Number.isFinite(d) || d < 0) d = 0;
  d = Math.min(64, Math.floor(d));

  const s = u.toString();
  if (d === 0) return s;

  const pad = s.length <= d ? "0".repeat(d - s.length + 1) + s : s;
  const intPart = pad.slice(0, -d) || "0";
  let frac = pad.slice(-d).replace(/0+$/, "");
  if (typeof maxFrac === "number" && maxFrac >= 0 && frac.length > maxFrac) {
    frac = frac.slice(0, maxFrac).replace(/0+$/, "");
  }
  return frac ? `${intPart}.${frac}` : intPart;
}

function describeContactTx(tx, address) {
  const kind = String(tx?.kind ?? "").toLowerCase();
  const asset = tx?.asset && typeof tx.asset === "object" ? tx.asset : null;
  const symbol = String(asset?.symbol ?? "").trim();
  const assetOp = String(asset?.op ?? "").toLowerCase();

  if (asset && String(asset?.type ?? "") === "DRC20" && assetOp === "transfer") {
    const amt = formatTokenUnits(asset?.valueUnits ?? asset?.value ?? "0", asset?.decimals ?? 0);
    return {
      title: sameAddress(asset?.to, address) ? `Sent ${symbol || "token"}` : `${symbol || "Token"} transfer`,
      sub: "Token transfer",
      amount: amt ? `-${amt} ${symbol || "units"}` : "—",
    };
  }

  if (kind === TX_KIND.TRANSFER) {
    const amt = tx?.amount != null ? formatLuxShort(tx.amount, UI_DISPLAY_DECIMALS) : "";
    const outgoing = sameAddress(tx?.to, address);
    const incoming = sameAddress(tx?.from, address);
    return {
      title: outgoing ? "Sent DUSK" : incoming ? "Received DUSK" : "Transfer",
      sub: String(tx?.privacy ?? "").toLowerCase() === "shielded" ? "Shielded" : "Public",
      amount: amt ? `${outgoing ? "-" : incoming ? "+" : ""}${amt} DUSK` : "—",
    };
  }

  const deposit = safeBigInt(tx?.deposit, 0n);
  const dep = deposit > 0n ? formatLuxShort(deposit, UI_DISPLAY_DECIMALS) : "";
  return {
    title: tx?.fnName ? `Call ${String(tx.fnName)}` : "Transaction",
    sub: String(tx?.kind ?? ""),
    amount: dep ? `-${dep} DUSK` : "—",
  };
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
    detailId: null,
    editId: null,
    editReturnView: "list",
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

  const startEdit = async (entry = null, returnView = "list") => {
    ab.view = "edit";
    ab.error = null;
    ab.editId = entry?.id ?? null;
    ab.editReturnView = returnView;
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

    const search = searchInput({
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
          if (String(t?.kind ?? "") !== TX_KIND.TRANSFER) continue;
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
              ab.detailId = entry?.id ?? null;
              ab.view = "detail";
              actions?.render?.().catch(() => {});
            },
          },
          [
            h("div", { class: "activity-ico" }, [identiconEl(addr || "dusk")]),
            h("div", { class: "activity-main" }, [
              h("div", { class: "activity-title" }, [
                h("span", { text: String(entry?.name ?? "") || "(Unnamed)" }),
              ]),
              h("div", {
                class: "activity-sub contact-address-line",
                text: addr || "—",
                title: addr || "",
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

  const renderDetail = () => {
    const items = Array.isArray(ab.items) ? ab.items : [];
    const entry = items.find((e) => String(e?.id ?? "") === String(ab.detailId ?? "")) || null;

    if (!entry) {
      return [
        subnav({
          title: "Contact",
          onBack: () => {
            ab.view = "list";
            actions?.render?.().catch(() => {});
          },
        }),
        h("div", { class: "row" }, [
          h("div", { class: "muted", text: "Contact not found." }),
        ]),
      ];
    }

    const addr = String(entry?.address ?? "").trim();
    const typ = entry?.type || ProfileGenerator.typeOf(addr) || "unknown";
    const txs = contactTxs(ov?.txs, addr);
    const nodeUrl = String(ov?.nodeUrl ?? "");

    const editBtn = h("button", {
      class: "btn-outline",
      text: "Edit",
      onclick: () => startEdit(entry, "detail"),
    });

    const sendBtn = h("button", {
      class: "btn-primary",
      text: "Send",
      onclick: () => {
        state.draft = {
          ...(state.draft || {}),
          to: addr,
        };
        state.route = "send";
        actions?.render?.().catch(() => {});
      },
    });

    const historyBtn = typ === "account"
      ? h("button", {
          class: "btn-outline",
          text: "History ↗",
          onclick: async () => {
            const ok = await openUrl(explorerAccountUrl(nodeUrl, addr));
            if (!ok) actions?.showToast?.("Explorer unavailable");
          },
        })
      : null;

    const txRow = (tx) => {
      const { title, sub, amount } = describeContactTx(tx, addr);
      const hash = String(tx?.hash ?? "");
      const openDetails = () => {
        if (!hash) return;
        state.txDetailHash = hash;
        state.txDetailFrom = "contacts";
        state.route = "tx";
        actions?.render?.().catch(() => {});
      };

      return h(
        "button",
        {
          class: "activity-item contact-activity-item",
          type: "button",
          disabled: !hash,
          onclick: openDetails,
        },
        [
          h("div", { class: "activity-main" }, [
            h("div", { class: "activity-title" }, [h("span", { text: title })]),
            h("div", { class: "activity-sub", text: sub || (hash ? truncateMiddle(hash, 10, 8) : "") }),
          ]),
          h("div", { class: "activity-right" }, [
            h("div", { class: "contact-activity-tail" }, [
              h("div", { class: "activity-amount", text: amount }),
              h("div", { class: "activity-time", text: tx?.submittedAt ? timeAgo(tx.submittedAt) : "" }),
            ]),
            hash ? h("span", { class: "activity-chevron", text: "›" }) : null,
          ].filter(Boolean)),
        ]
      );
    };

    return [
      subnav({
        title: "Contact",
        onBack: () => {
          ab.view = "list";
          actions?.render?.().catch(() => {});
        },
      }),
      h("div", { class: "row contact-detail" }, [
        h("div", { class: "contact-detail-head" }, [
          h("div", { class: "activity-ico contact-detail-icon" }, [identiconEl(addr || "dusk")]),
          h("div", { class: "contact-detail-main" }, [
            h("div", { class: "contact-detail-name", text: String(entry?.name ?? "") || "(Unnamed)" }),
            h("span", { class: "meta-pill", text: typeLabel(typ) }),
          ]),
        ]),
        h("label", { text: "Address" }),
        h("div", { class: "box contact-detail-address" }, [h("code", { text: addr || "—" })]),
        h("div", { class: "btnrow" }, [editBtn, historyBtn, sendBtn].filter(Boolean)),
      ]),
      h("div", { class: "row contact-activity" }, [
        h("label", { text: "Activity" }),
        txs.length
          ? h("div", { class: "activity-list" }, txs.map((tx) => txRow(tx)))
          : h("div", { class: "muted", text: "No local wallet activity for this contact." }),
      ]),
    ];
  };

  const renderEdit = () => {
    const isNew = !ab.editId;

    const nameInput = textInput({
      placeholder: "Name (e.g. Alice)",
      value: String(ab.editName ?? ""),
      onEnter: () => addrInput.focus(),
      oninput: (e) => {
        ab.editName = String(e?.target?.value ?? "");
      },
    });

    const addrInput = textInput({
      placeholder: "Address (public account or shielded)",
      value: String(ab.editAddress ?? ""),
      onEnter: () => saveBtn.click(),
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
          class: "meta-pill contact-detect-pill",
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
          if (!isNew && ab.editReturnView === "detail") {
            ab.detailId = saved.id;
            ab.view = "detail";
          } else {
            ab.view = "list";
          }
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
        ab.view = ab.editReturnView === "detail" ? "detail" : "list";
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
          ab.view = ab.editReturnView === "detail" ? "detail" : "list";
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

  return (ab.view === "edit" ? renderEdit() : ab.view === "detail" ? renderDetail() : renderList()).filter(Boolean);
}
