import { UI_DISPLAY_DECIMALS, safeBigInt } from "../../../shared/amount.js";
import { TX_KIND } from "../../../shared/constants.js";
import { reviewGas } from "../../components/NetworkGas.js";
import { h } from "../../lib/dom.js";
import { shortAddress } from "../../lib/strings.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { subnav } from "../../components/Subnav.js";
import { iconSvg } from "../../components/ActionIcon.js";
import { balance, balancesHidden } from "../../components/Balance.js";
import { bracketTitle } from "../../components/BracketTitle.js";
import { fieldLabel, integerInput, submitOnGasEnter, textInput } from "../../components/FormControls.js";
import "../../components/GasEditor.js";
import { sendFromReview } from "./sent.js";

const MAX_U64 = 18446744073709551615n;

function normalizeContractIdInput(s) {
  const raw = String(s ?? "").trim();
  if (!raw) throw new Error("Enter a contract ID.");
  if (/^0x[0-9a-f]{64}$/i.test(raw)) return raw.toLowerCase();
  if (/^[0-9a-f]{64}$/i.test(raw)) return `0x${raw.toLowerCase()}`;
  throw new Error("That isn't a contract ID: it has 64 hex characters, after 0x.");
}

function contractIdsEqual(a, b) {
  try {
    return normalizeContractIdInput(a) === normalizeContractIdInput(b);
  } catch {
    return String(a ?? "") === String(b ?? "");
  }
}

function parseU64(s, { name = "value" } = {}) {
  const raw = String(s ?? "").trim();
  if (!raw) throw new Error(`Enter a ${name}.`);
  let n;
  try {
    n = BigInt(raw);
  } catch {
    throw new Error(`Enter the ${name} as a whole number.`);
  }
  if (n < 0n || n > MAX_U64) throw new Error(`That ${name} is too large.`);
  return n.toString();
}

function parseDrcAccount(s, { name = "account" } = {}) {
  const raw = String(s ?? "").trim();
  if (!raw) throw new Error(`Enter a ${name}.`);
  if (/^0x[0-9a-f]{64}$/i.test(raw)) return { Contract: raw.toLowerCase() };
  return { External: raw };
}

function accountEnumToString(a) {
  if (!a) return "";
  if (typeof a === "string") return a;
  if (typeof a === "object") {
    if (typeof a.External === "string") return a.External;
    if (typeof a.Contract === "string") return a.Contract;
  }
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
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
  let frac = pad.slice(-d);

  frac = frac.replace(/0+$/, "");
  if (typeof maxFrac === "number" && maxFrac >= 0 && frac.length > maxFrac) {
    frac = frac.slice(0, maxFrac).replace(/0+$/, "");
  }

  return frac ? `${intPart}.${frac}` : intPart;
}

function parseTokenAmountHuman(raw, decimals) {
  const s = String(raw ?? "").trim();
  if (!s) throw new Error("Enter an amount.");
  if (s.startsWith("-")) throw new Error("Enter an amount of 0 or more.");

  let d = Number(decimals ?? 0);
  if (!Number.isFinite(d) || d < 0) d = 0;
  d = Math.min(64, Math.floor(d));

  if (!s.includes(".")) {
    // Integer amount in human units.
    if (!/^[0-9]+$/.test(s)) throw new Error("Enter an amount such as 1 or 0.5.");
    const n = BigInt(s);
    const out = n * 10n ** BigInt(d);
    if (out > MAX_U64) throw new Error("That amount is too large.");
    return out.toString();
  }

  const [intRaw, fracRaw = ""] = s.split(".");
  if (intRaw && !/^[0-9]+$/.test(intRaw)) throw new Error("Enter an amount such as 1 or 0.5.");
  if (fracRaw && !/^[0-9]+$/.test(fracRaw)) throw new Error("Enter an amount such as 1 or 0.5.");

  const intPart = intRaw ? BigInt(intRaw) : 0n;
  const fracDigits = fracRaw;
  if (fracDigits.length > d) throw new Error(d ? `This token has at most ${d} decimals.` : "This token has no decimals.");

  const fracPadded = fracDigits.padEnd(d, "0");
  const combined = `${intPart.toString()}${fracPadded}`;
  const out = BigInt(combined);
  if (out > MAX_U64) throw new Error("That amount is too large.");
  return out.toString();
}

function ensureAssetsLoaded(ov, { state, actions } = {}) {
  const st = (state.assets ??= {
    loaded: false,
    loading: false,
    error: null,
    updatedAt: 0,
    networkKey: null,
    profileIndex: null,
    tokens: [],
    nfts: [],
    balances: {}, // { [contractId]: u64 string }
    balancesAt: {}, // { [contractId]: number }
  });

  const net = String(ov?.nodeUrl ?? "").trim();
  const idx = Number(ov?.selectedAccountIndex ?? 0) || 0;

  const stale =
    !st.loaded ||
    st.networkKey !== net ||
    st.profileIndex !== idx ||
    Date.now() - Number(st.updatedAt || 0) > 30_000;

  if (!stale || st.loading) return st;

  st.loading = true;
  st.error = null;

  actions
    ?.send?.({ type: "DUSK_UI_ASSETS_GET", profileIndex: idx })
    .then((resp) => {
      if (resp?.error) throw new Error(resp.error.message ?? "Failed to load watched assets");
      const out = resp?.result ?? resp ?? {};
      st.tokens = Array.isArray(out?.tokens) ? out.tokens : [];
      st.nfts = Array.isArray(out?.nfts) ? out.nfts : [];
      st.networkKey = net;
      st.profileIndex = idx;
      st.loaded = true;
      st.loading = false;
      st.updatedAt = Date.now();
      actions?.render?.().catch(() => {});
    })
    .catch((e) => {
      st.loading = false;
      st.loaded = false;
      st.error = e?.message ?? String(e);
      actions?.render?.().catch(() => {});
    });

  return st;
}

function ensureTokenBalancesLoaded(ov, { state, actions } = {}) {
  const st = ensureAssetsLoaded(ov, { state, actions });
  const idx = Number(ov?.selectedAccountIndex ?? 0) || 0;
  if (!st.loaded || st.loading) return st;

  const tokens = Array.isArray(st.tokens) ? st.tokens : [];
  if (!tokens.length) return st;

  const now = Date.now();
  const STALE_MS = 25_000;

  for (const t of tokens) {
    const cid = String(t?.contractId ?? "").trim();
    if (!cid) continue;
    const last = Number(st.balancesAt?.[cid] ?? 0) || 0;
    if (st.balances?.[cid] !== undefined && now - last < STALE_MS) continue;

    // Mark as "requested" to avoid spamming during rapid renders.
    st.balancesAt[cid] = now;

    actions
      ?.send?.({
        type: "DUSK_UI_DRC20_GET_BALANCE",
        contractId: cid,
        profileIndex: idx,
        driver: t?.driver,
      })
      .then((resp) => {
        if (resp?.error) throw new Error(resp.error.message ?? "Failed to fetch token balance");
        const v = String(resp?.result ?? resp ?? "0");
        st.balances[cid] = v;
        st.balancesAt[cid] = Date.now();
        actions?.render?.().catch(() => {});
      })
      .catch(() => {
        // Keep previous cached value if any; do not hard-fail the whole view.
      });
  }

  return st;
}

// An action's error, said under it rather than in a toast that goes.
function inlineError() {
  const el = h("div", { class: "field-error", role: "alert", hidden: true });
  return {
    el,
    show(text) {
      el.textContent = text || "";
      el.hidden = !text;
    },
  };
}

// A key-value row, as Review and the details use them.
const kv = (label, value, className = "") =>
  h("div", { class: ["kv", className].filter(Boolean).join(" ") }, [
    h("span", { class: "kv-label", text: label }),
    h("span", { class: "kv-value" }, [].concat(value)),
  ]);

// A contract ID, short, with Copy beside it.
function contractValue(cid, actions) {
  return [
    h("span", { class: "mono", title: cid, text: shortAddress(cid) }),
    h("button", {
      class: "copy-ico",
      type: "button",
      title: "Copy contract ID",
      "aria-label": "Copy contract ID",
      html: iconSvg("copy"),
      onclick: async () => {
        const ok = await copyToClipboard(cid);
        actions?.showToast?.(ok ? "Contract ID copied" : "Couldn't copy the contract ID");
      },
    }),
  ];
}

export function assetsSectionsView(ov, { state, actions } = {}) {
  const st = ensureTokenBalancesLoaded(ov, { state, actions });
  const hidden = balancesHidden(ov);

  const openAddToken = () => {
    state.route = "asset_add_token";
    actions?.render?.().catch(() => {});
  };
  const openAddNft = () => {
    state.route = "asset_add_nft";
    actions?.render?.().catch(() => {});
  };

  const tokens = Array.isArray(st?.tokens) ? st.tokens : [];
  const nfts = Array.isArray(st?.nfts) ? st.nfts : [];

  const tokenRows = tokens.map((t) => {
    const cid = String(t?.contractId ?? "");
    const sym = String(t?.symbol ?? "").trim() || "TOKEN";
    const name = String(t?.name ?? "").trim() || "DRC20 token";
    const dec = Number(t?.decimals ?? 0) || 0;
    const balUnits = st?.balances?.[cid];
    const bal = balUnits != null ? formatTokenUnits(balUnits, dec, { maxFrac: UI_DISPLAY_DECIMALS }) : "—";

    return h(
      "button",
      {
        class: "list-row asset-row",
        type: "button",
        title: `Open ${sym}`,
        onclick: () => {
          state.assetTokenContractId = cid;
          state.route = "asset_token";
          actions?.render?.().catch(() => {});
        },
      },
      [
        h("span", { class: "row-icon asset-letter", "aria-hidden": "true", text: sym.slice(0, 1).toUpperCase() }),
        h("span", { class: "row-main" }, [
          h("span", { class: "row-title", text: sym }),
          h("span", { class: "row-sub", text: name, title: cid }),
        ]),
        h("span", { class: "tx-amount asset-amt" }, [balance(hidden, bal), bal === "—" ? null : h("span", { class: "tx-unit", text: ` ${sym}` })].filter(Boolean)),
      ]
    );
  });

  const nftRows = nfts.map((n) => {
    const cid = String(n?.contractId ?? "");
    const tokenId = String(n?.tokenId ?? "");
    const sym = String(n?.symbol ?? "").trim() || "NFT";
    const name = String(n?.name ?? "").trim() || "DRC721";
    return h(
      "button",
      {
        class: "list-row asset-row",
        type: "button",
        title: `Open ${sym} #${tokenId || "?"}`,
        onclick: () => {
          state.assetNft = { contractId: cid, tokenId };
          state.route = "asset_nft";
          actions?.render?.().catch(() => {});
        },
      },
      [
        h("span", { class: "row-icon", "aria-hidden": "true", html: iconSvg("nft") }),
        h("span", { class: "row-main" }, [
          h("span", { class: "row-title", text: `${sym} #${tokenId || "?"}` }),
          h("span", { class: "row-sub", text: name, title: cid }),
        ]),
        h("span", { class: "row-chev", "aria-hidden": "true", html: iconSvg("chev-r") }),
      ]
    );
  });

  // Tokens and NFTs, one section with its two actions in its head.
  const link = (text, onclick) => h("button", { class: "see-all chain-link", type: "button", text, onclick });
  const rows = [...tokenRows, ...nftRows];
  return [
    h("section", { class: "box home-assets" }, [
      h("div", { class: "section-head" }, [
        bracketTitle({ text: "Tokens and NFTs" }),
        h("div", { class: "section-actions" }, [link("Add token", openAddToken), link("Import NFT", openAddNft)]),
      ]),
      st?.error ? h("div", { class: "err", text: String(st.error) }) : null,
      rows.length
        ? h("div", { class: "group" }, rows)
        : h("div", { class: "group" }, [h("p", { class: "tx-empty", text: st?.loading ? "Loading…" : "No tokens or NFTs yet." })]),
    ].filter(Boolean)),
  ];
}

export function assetAddTokenView(ov, { state, actions } = {}) {
  const onBack = () => {
    state.route = "home";
    actions?.render?.().catch(() => {});
  };

  const st = (state.assetAddToken ??= {
    contractId: "",
    loading: false,
    error: null,
    meta: null,
  });

  const input = textInput({
    placeholder: "0x…",
    value: String(st.contractId ?? ""),
    onEnter: () => lookupBtn.click(),
    oninput: (e) => {
      st.contractId = String(e?.target?.value ?? "");
    },
  });

  const lookupBtn = h("button", {
    class: "btn-outline",
    text: st.loading ? "Looking up…" : "Look up",
    disabled: Boolean(st.loading),
    onclick: async () => {
      try {
        st.error = null;
        st.meta = null;
        st.loading = true;
        actions?.render?.().catch(() => {});

        const cid = normalizeContractIdInput(st.contractId);
        const resp = await actions?.send?.({ type: "DUSK_UI_DRC20_GET_METADATA", contractId: cid });
        if (resp?.error) throw new Error(resp.error.message ?? "Failed to fetch token metadata");
        st.meta = resp?.result ?? resp;
      } catch (e) {
        st.error = e?.message ?? String(e);
      } finally {
        st.loading = false;
        actions?.render?.().catch(() => {});
      }
    },
  });

  const addBtn = h("button", {
    class: "btn-primary",
    text: "Add token",
    disabled: Boolean(st.loading) || !st.meta,
    onclick: async () => {
      try {
        const cid = normalizeContractIdInput(st.contractId);
        const meta = st.meta || {};
        const resp = await actions?.send?.({
          type: "DUSK_UI_ASSETS_WATCH_TOKEN",
          token: {
            contractId: cid,
            name: meta?.name ?? "",
            symbol: meta?.symbol ?? "",
            decimals: meta?.decimals ?? 0,
          },
        });
        if (resp?.error) throw new Error(resp.error.message ?? "Failed to watch token");
        // Invalidate cache so Home refreshes.
        if (state.assets) state.assets.loaded = false;
        actions?.showToast?.("Token added.");
        state.route = "home";
        actions?.render?.({ forceRefresh: true }).catch(() => {});
      } catch (e) {
        addError.show(e?.message ?? String(e));
      }
    },
  });
  const addError = inlineError();
  const metaBox = st.meta
    ? h("div", { class: "group" }, [
        kv("Name", String(st.meta?.name ?? "—")),
        kv("Symbol", String(st.meta?.symbol ?? "—")),
        kv("Decimals", String(st.meta?.decimals ?? "—")),
      ])
    : null;

  return [
    subnav({ title: "Add token", onBack }),
    h("div", { class: "row" }, [
      fieldLabel(input, "Contract ID"),
      input,
      st.error ? h("div", { class: "field-error", role: "alert", text: String(st.error) }) : null,
      lookupBtn,
      metaBox,
      addError.el,
      addBtn,
    ].filter(Boolean)),
  ];
}

export function assetAddNftView(ov, { state, actions } = {}) {
  const onBack = () => {
    state.route = "home";
    actions?.render?.().catch(() => {});
  };

  const st = (state.assetAddNft ??= {
    contractId: "",
    tokenId: "",
    loading: false,
    error: null,
    info: null, // { meta, owner, tokenUri }
  });

  const contractInput = textInput({
    placeholder: "0x…",
    value: String(st.contractId ?? ""),
    onEnter: () => tokenIdInput.focus(),
    oninput: (e) => {
      st.contractId = String(e?.target?.value ?? "");
    },
  });

  const tokenIdInput = integerInput({
    placeholder: "e.g. 1",
    value: String(st.tokenId ?? ""),
    onEnter: () => lookupBtn.click(),
    oninput: (e) => {
      st.tokenId = String(e?.target?.value ?? "");
    },
  });

  const lookupBtn = h("button", {
    class: "btn-outline",
    text: st.loading ? "Looking up…" : "Look up",
    disabled: Boolean(st.loading),
    onclick: async () => {
      try {
        st.error = null;
        st.info = null;
        st.loading = true;
        actions?.render?.().catch(() => {});

        const cid = normalizeContractIdInput(st.contractId);
        const tid = parseU64(st.tokenId, { name: "token ID" });

        const [metaResp, ownerResp, uriResp] = await Promise.all([
          actions?.send?.({ type: "DUSK_UI_DRC721_GET_METADATA", contractId: cid }),
          actions?.send?.({ type: "DUSK_UI_DRC721_OWNER_OF", contractId: cid, tokenId: tid }),
          actions?.send?.({ type: "DUSK_UI_DRC721_TOKEN_URI", contractId: cid, tokenId: tid }),
        ]);

        if (metaResp?.error) throw new Error(metaResp.error.message ?? "Failed to fetch NFT contract metadata");
        if (ownerResp?.error) throw new Error(ownerResp.error.message ?? "Failed to fetch NFT owner");
        if (uriResp?.error) throw new Error(uriResp.error.message ?? "Failed to fetch token URI");

        st.info = {
          meta: metaResp?.result ?? metaResp,
          owner: ownerResp?.result ?? ownerResp,
          tokenUri: String(uriResp?.result ?? uriResp ?? ""),
          tokenId: tid,
          contractId: cid,
        };
      } catch (e) {
        st.error = e?.message ?? String(e);
      } finally {
        st.loading = false;
        actions?.render?.().catch(() => {});
      }
    },
  });

  const importBtn = h("button", {
    class: "btn-primary",
    text: "Import NFT",
    disabled: Boolean(st.loading) || !st.info,
    onclick: async () => {
      try {
        if (!st.info) throw new Error("Look up the NFT first.");
        const me = String(ov?.accounts?.[Number(ov?.selectedAccountIndex ?? 0) || 0] ?? "").trim();
        const owner = st.info?.owner;
        const ownerStr = accountEnumToString(owner);
        if (!me || !(owner && typeof owner === "object" && owner.External === me)) {
          throw new Error(`This NFT belongs to ${shortAddress(ownerStr)}, not to this profile.`);
        }

        const resp = await actions?.send?.({
          type: "DUSK_UI_ASSETS_WATCH_NFT",
          nft: {
            contractId: st.info.contractId,
            tokenId: st.info.tokenId,
            name: st.info?.meta?.name ?? "",
            symbol: st.info?.meta?.symbol ?? "",
            tokenUri: st.info?.tokenUri ?? "",
          },
        });
        if (resp?.error) throw new Error(resp.error.message ?? "Failed to import NFT");
        if (state.assets) state.assets.loaded = false;
        actions?.showToast?.("NFT imported.");
        state.route = "home";
        actions?.render?.({ forceRefresh: true }).catch(() => {});
      } catch (e) {
        importError.show(e?.message ?? String(e));
      }
    },
  });
  const importError = inlineError();
  const infoBox = st.info
    ? (() => {
        const me = String(ov?.accounts?.[Number(ov?.selectedAccountIndex ?? 0) || 0] ?? "").trim();
        const owner = st.info?.owner;
        const owned = Boolean(owner && typeof owner === "object" && owner.External === me);
        const ownerStr = accountEnumToString(owner);

        return h("div", { class: "group" }, [
          kv("Name", String(st.info?.meta?.name ?? "—")),
          kv("Symbol", String(st.info?.meta?.symbol ?? "—")),
          kv("Token ID", String(st.info?.tokenId ?? "—")),
          kv("Owner", [
            h("span", { class: "mono", title: ownerStr, text: ownerStr ? shortAddress(ownerStr) : "—" }),
            h("span", { class: owned ? "kv-muted" : "kv-bad", text: owned ? " · this profile" : " · not this profile" }),
          ]),
          kv("Token URI", st.info?.tokenUri ? String(st.info.tokenUri) : "None", "kv--wrap"),
        ]);
      })()
    : null;

  return [
    subnav({ title: "Import NFT", onBack }),
    h("div", { class: "row" }, [
      fieldLabel(contractInput, "Contract ID"),
      contractInput,
      fieldLabel(tokenIdInput, "Token ID"),
      tokenIdInput,
      st.error ? h("div", { class: "field-error", role: "alert", text: String(st.error) }) : null,
      lookupBtn,
      infoBox,
      importError.el,
      importBtn,
    ].filter(Boolean)),
  ];
}

export function assetTokenView(ov, { state, actions } = {}) {
  const cid = String(state?.assetTokenContractId ?? "").trim();
  if (!cid) {
    state.route = "home";
    return [];
  }

  const st = ensureTokenBalancesLoaded(ov, { state, actions });
  const token = Array.isArray(st?.tokens) ? st.tokens.find((t) => contractIdsEqual(t?.contractId, cid)) : null;

  const onBack = () => {
    state.assetTokenContractId = null;
    state.route = "home";
    actions?.render?.().catch(() => {});
  };

  if (!token) {
    if (st.loading || !st.loaded) {
      return [
        subnav({ title: "Token", onBack }),
        h("div", { class: "row" }, [
          h("div", { class: "muted", text: "Loading token…" }),
        ]),
      ];
    }

    return [
      subnav({ title: "Token", onBack }),
      h("div", { class: "row" }, [
        h("div", { class: "err", text: "Token not found in watched list." }),
        h("div", { class: "box" }, [h("code", { text: cid })]),
      ]),
    ];
  }

  const sym = String(token?.symbol ?? "").trim() || "TOKEN";
  const name = String(token?.name ?? "").trim() || "DRC20 token";
  const dec = Number(token?.decimals ?? 0) || 0;

  const balUnits = st?.balances?.[cid];
  const balHuman = balUnits != null ? formatTokenUnits(balUnits, dec, { maxFrac: UI_DISPLAY_DECIMALS }) : "—";
  const hidden = balancesHidden(ov);

  const form = (state.assetTokenForm ??= { to: "", amount: "", spender: "", approveAmount: "" });

  const doUnwatch = async () => {
    try {
      const resp = await actions?.send?.({ type: "DUSK_UI_ASSETS_UNWATCH_TOKEN", contractId: cid });
      if (resp?.error) throw new Error(resp.error.message ?? "Failed to unwatch token");
      if (state.assets) state.assets.loaded = false;
      actions?.showToast?.("Token removed.");
      onBack();
    } catch (e) {
      actions?.showToast?.(e?.message ?? String(e), 2500);
    }
  };

  const reviewTransfer = async () => {
    try {
      const to = parseDrcAccount(form.to, { name: "recipient" });
      const valueUnits = parseTokenAmountHuman(form.amount, dec);
      if (safeBigInt(valueUnits, 0n) <= 0n) throw new Error("Enter an amount greater than 0.");

      const enc = await actions?.send?.({
        type: "DUSK_UI_DRC20_ENCODE_INPUT",
        fnName: "transfer",
        args: { to, value: valueUnits },
        driver: token?.driver,
      });
      if (enc?.error) throw new Error(enc.error.message ?? "Failed to encode transfer");

      state.assetTxDraft = {
        op: "transfer",
        token: { contractId: cid, symbol: sym, name, decimals: dec, driver: token?.driver },
        params: {
          kind: TX_KIND.CONTRACT_CALL,
          privacy: "public",
          contractId: cid,
          fnName: "transfer",
          fnArgs: enc?.result ?? enc,
          amount: "0",
          deposit: "0",
        },
        asset: {
          type: "DRC20",
          op: "transfer",
          symbol: sym,
          name,
          decimals: dec,
          driver: token?.driver,
          valueUnits,
          to: accountEnumToString(to),
        },
      };
      state.route = "asset_token_confirm";
      actions?.render?.().catch(() => {});
    } catch (e) {
      transferError.show(e?.message ?? String(e));
    }
  };
  const transferError = inlineError();

  const reviewApprove = async ({ max = false } = {}) => {
    try {
      const spender = parseDrcAccount(form.spender, { name: "spender" });
      const valueUnits = max ? MAX_U64.toString() : parseTokenAmountHuman(form.approveAmount, dec);
      if (safeBigInt(valueUnits, 0n) < 0n) throw new Error("Enter an amount of 0 or more.");

      const enc = await actions?.send?.({
        type: "DUSK_UI_DRC20_ENCODE_INPUT",
        fnName: "approve",
        args: { spender, value: valueUnits },
        driver: token?.driver,
      });
      if (enc?.error) throw new Error(enc.error.message ?? "Failed to encode approve");

      state.assetTxDraft = {
        op: "approve",
        token: { contractId: cid, symbol: sym, name, decimals: dec, driver: token?.driver },
        params: {
          kind: TX_KIND.CONTRACT_CALL,
          privacy: "public",
          contractId: cid,
          fnName: "approve",
          fnArgs: enc?.result ?? enc,
          amount: "0",
          deposit: "0",
        },
        asset: {
          type: "DRC20",
          op: "approve",
          symbol: sym,
          name,
          decimals: dec,
          driver: token?.driver,
          valueUnits,
          spender: accountEnumToString(spender),
          isMax: Boolean(max),
        },
      };
      state.route = "asset_token_confirm";
      actions?.render?.().catch(() => {});
    } catch (e) {
      approveError.show(e?.message ?? String(e));
    }
  };
  const approveError = inlineError();

  // The token: its letter, its name, then its balance, large.
  const tokenHero = h("div", { class: "tx-hero asset-token-hero" }, [
    h("span", { class: "row-icon tx-hero-icon asset-letter", "aria-hidden": "true", text: sym.slice(0, 1).toUpperCase() }),
    h("div", { class: "tx-hero-lead", text: name, title: cid }),
    h("div", { class: "tx-hero-amount asset-token-balance-value" }, [
      balance(hidden, balHuman),
      balHuman === "—" ? null : h("span", { class: "tx-unit", text: ` ${sym}` }),
    ].filter(Boolean)),
  ]);
  const tokenMeta = h("div", { class: "group" }, [
    kv("Contract", contractValue(cid, actions)),
    kv("Decimals", String(dec)),
    balUnits != null
      ? kv("Atomic units", h("span", { class: "mono asset-token-units", title: hidden ? undefined : String(balUnits) }, [balance(hidden, String(balUnits))]))
      : null,
  ].filter(Boolean));

  const transferToInput = textInput({
    name: "assetTokenRecipient",
    placeholder: "Account or 0x… contract ID",
    value: String(form.to ?? ""),
    onEnter: () => transferAmountInput.focus(),
    oninput: (e) => {
      form.to = String(e?.target?.value ?? "");
    },
  });
  const transferAmountInput = textInput({
    name: "assetTokenAmount",
    placeholder: sym,
    value: String(form.amount ?? ""),
    numericMode: dec > 0 ? "decimal" : "integer",
    onEnter: () => reviewTransferBtn.click(),
    oninput: (e) => {
      form.amount = String(e?.target?.value ?? "");
    },
  });

  const reviewTransferBtn = h("button", { class: "btn-primary", text: "Review transfer", onclick: reviewTransfer });

  const sendSection = h("section", { class: "asset-action-section" }, [
    bracketTitle({ class: "asset-action-title", text: `Send ${sym}` }),
    fieldLabel(transferToInput, "Recipient"),
    transferToInput,
    fieldLabel(transferAmountInput, "Amount"),
    transferAmountInput,
    transferError.el,
    reviewTransferBtn,
  ]);

  const approveMaxBtn = h("button", {
    class: "mini-btn",
    type: "button",
    text: "Unlimited",
    title: "No limit on what the spender can move. Use with care.",
    onclick: async () => reviewApprove({ max: true }),
  });

  const approveSpenderInput = textInput({
    name: "assetTokenSpender",
    placeholder: "Account or 0x… contract ID",
    value: String(form.spender ?? ""),
    onEnter: () => approveAmountInput.focus(),
    oninput: (e) => {
      form.spender = String(e?.target?.value ?? "");
    },
  });
  const approveAmountInput = textInput({
    name: "assetTokenApproveAmount",
    placeholder: sym,
    value: String(form.approveAmount ?? ""),
    numericMode: dec > 0 ? "decimal" : "integer",
    onEnter: () => reviewApproveBtn.click(),
    oninput: (e) => {
      form.approveAmount = String(e?.target?.value ?? "");
    },
  });

  const reviewApproveBtn = h("button", {
    class: "btn-primary",
    text: "Review approval",
    onclick: () => reviewApprove({ max: false }),
  });
  const approveSection = h("section", { class: "asset-action-section" }, [
    bracketTitle({ class: "asset-action-title", text: "Approve" }),
    h("p", { class: "asset-action-note", text: `Let another account or contract spend your ${sym}. An exact amount is safer than Unlimited.` }),
    fieldLabel(approveSpenderInput, "Spender"),
    approveSpenderInput,
    fieldLabel(approveAmountInput, "Allowance"),
    h("div", { class: "asset-allowance" }, [approveAmountInput, approveMaxBtn]),
    approveError.el,
    reviewApproveBtn,
  ]);

  return [
    subnav({ title: sym, onBack }),
    h("div", { class: "row asset-token-page" }, [
      tokenHero,
      tokenMeta,
      sendSection,
      approveSection,
      h("button", { class: "text-btn asset-remove-btn", type: "button", text: "Remove token", onclick: doUnwatch }),
    ]),
  ];
}

export function assetTokenConfirmView(ov, { state, actions } = {}) {
  const d = state.assetTxDraft;
  if (!d) {
    state.route = "home";
    return [];
  }

  const token = d?.token ?? {};
  const sym = String(token?.symbol ?? "").trim() || "TOKEN";
  const dec = Number(token?.decimals ?? 0) || 0;
  const op = String(d?.op ?? "");

  const onBack = () => {
    state.route = "asset_token";
    actions?.render?.().catch(() => {});
  };

  const params = d.params ?? null;
  if (!params) {
    state.route = "asset_token";
    return [];
  }

  // The network's gas price by default; Custom fee for gas of your own.
  const { defaultGas, editor: gasEditor, error: confirmError, readGas } = reviewGas({
    kind: TX_KIND.CONTRACT_CALL,
    amountLux: "0",
    ov,
    actions,
    gas: d?.gas,
    fallbackPrice: "1",
  });

  const valueUnits = String(d?.asset?.valueUnits ?? d?.asset?.value ?? "0");
  const valueHuman = formatTokenUnits(valueUnits, dec, { maxFrac: UI_DISPLAY_DECIMALS });

  const warn =
    op === "approve" && d?.asset?.isMax
      ? h("p", {
          class: "field-error asset-unlimited",
          role: "alert",
          text: `Unlimited: the spender can move any amount of your ${sym}.`,
        })
      : null;

  // Back returns to the token, so Review has no Cancel.
  const confirmBtn = h("button", { class: "btn-primary", text: "Confirm" });

  confirmBtn.addEventListener("click", async () => {
    const gas = readGas();
    if (gas === false) return;
    confirmBtn.disabled = true;
    d.gas = gas;

    const capGas = gas ?? defaultGas;
    const counterparty = String(op === "approve" ? d?.asset?.spender ?? "" : d?.asset?.to ?? "");
    await sendFromReview({
      state,
      actions,
      message: {
        type: "DUSK_UI_SEND_TX",
        params: { ...params, gas: gas || undefined },
        asset: d?.asset && typeof d.asset === "object" ? d.asset : undefined,
      },
      summary: {
        title: op === "transfer" ? `Send ${sym}` : op === "approve" ? `Approve ${sym}` : "Contract call",
        amountDisplay: op === "approve" && d?.asset?.isMax ? "" : valueHuman,
        amountText: op === "approve" && d?.asset?.isMax ? "Unlimited" : "",
        unit: sym,
        to: counterparty ? { name: "", address: counterparty, short: shortAddress(counterparty) } : null,
        from: "from your public balance",
        feeCapLux: (safeBigInt(capGas?.limit, 0n) * safeBigInt(capGas?.price, 0n)).toString(),
      },
      backRoute: "asset_token_confirm",
      doneRoute: "asset_token",
      onSent: () => {
        // Invalidate balance cache for this token.
        try {
          const cid = String(token?.contractId ?? "");
          if (state.assets?.balancesAt && cid) state.assets.balancesAt[cid] = 0;
        } catch {}
        // Done with, unless a newer draft took its place meanwhile.
        if (state.assetTxDraft === d) state.assetTxDraft = null;
      },
    });
    confirmBtn.disabled = false;
  });
  submitOnGasEnter(gasEditor, confirmBtn);

  const counterpartyAddr = String(op === "approve" ? d?.asset?.spender ?? "" : d?.asset?.to ?? "");
  return [
    subnav({ title: "Review", onBack }),
    h("div", { class: "row asset-review" }, [
      h("div", { class: "review-head" }, [
        h("div", { class: "review-kind", text: op === "approve" ? `Approve ${sym}` : op === "transfer" ? `Send ${sym}` : "Contract call" }),
        h("div", { class: "balance-amount" }, [
          op === "approve" && d?.asset?.isMax ? "Unlimited" : valueHuman,
          h("span", { class: "balance-unit", text: ` ${sym}` }),
        ]),
      ].filter(Boolean)),
      h("div", { class: "group" }, [
        counterpartyAddr
          ? kv(op === "approve" ? "Spender" : "To", h("span", { class: "mono review-to__address", text: counterpartyAddr }), "kv--wrap")
          : null,
        kv("Token", contractValue(String(params?.contractId ?? ""), actions)),
        kv("Atomic units", h("span", { class: "mono", text: valueUnits })),
      ].filter(Boolean)),
      warn,
      gasEditor,
      confirmError,
      h("div", { class: "btnrow" }, [confirmBtn]),
    ].filter(Boolean)),
  ];
}

export function assetNftView(ov, { state, actions } = {}) {
  const sel = state?.assetNft;
  const cid = String(sel?.contractId ?? "").trim();
  const tokenId = String(sel?.tokenId ?? "").trim();

  const onBack = () => {
    state.assetNft = null;
    state.route = "home";
    actions?.render?.().catch(() => {});
  };

  if (!cid || !tokenId) {
    state.route = "home";
    return [];
  }

  const st = ensureAssetsLoaded(ov, { state, actions });
  const nft = Array.isArray(st?.nfts)
    ? st.nfts.find((x) => String(x?.contractId ?? "") === cid && String(x?.tokenId ?? "") === tokenId)
    : null;

  if (!nft) {
    return [
      subnav({ title: "NFT", onBack }),
      h("div", { class: "row" }, [
        h("div", { class: "err", text: "NFT not found in imported list." }),
        h("div", { class: "box" }, [h("code", { text: `${cid}:${tokenId}` })]),
      ]),
    ];
  }

  const sym = String(nft?.symbol ?? "").trim() || "NFT";
  const name = String(nft?.name ?? "").trim() || "DRC721";
  const tokenUri = String(nft?.tokenUri ?? "").trim();

  const doUnwatch = async () => {
    try {
      const resp = await actions?.send?.({ type: "DUSK_UI_ASSETS_UNWATCH_NFT", contractId: cid, tokenId });
      if (resp?.error) throw new Error(resp.error.message ?? "Failed to remove NFT");
      if (state.assets) state.assets.loaded = false;
      actions?.showToast?.("NFT removed.");
      onBack();
    } catch (e) {
      actions?.showToast?.(e?.message ?? String(e), 2500);
    }
  };

  return [
    subnav({ title: `${sym} #${tokenId}`, onBack }),
    h("div", { class: "row asset-nft-page" }, [
      h("div", { class: "tx-hero" }, [
        h("span", { class: "row-icon tx-hero-icon", "aria-hidden": "true", html: iconSvg("nft") }),
        h("h2", { class: "tx-hero-name", text: `${sym} #${tokenId}` }),
        h("div", { class: "tx-hero-lead", text: name }),
      ]),
      h("div", { class: "group" }, [
        kv("Contract", contractValue(cid, actions)),
        kv("Token ID", tokenId),
        kv("Token URI", tokenUri || "None", "kv--wrap"),
      ]),
      tokenUri ? h("p", { class: "asset-action-note", text: "Media previews are off for now." }) : null,
      h("button", { class: "text-btn asset-remove-btn", type: "button", text: "Remove NFT", onclick: doUnwatch }),
    ].filter(Boolean)),
  ];
}
