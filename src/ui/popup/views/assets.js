import { UI_DISPLAY_DECIMALS, safeBigInt } from "../../../shared/amount.js";
import { TX_KIND } from "../../../shared/constants.js";
import { getDefaultGas } from "../../../shared/txDefaults.js";
import { h } from "../../lib/dom.js";
import { truncateMiddle } from "../../lib/strings.js";
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
  if (!raw) throw new Error("Missing contract ID");
  if (/^0x[0-9a-f]{64}$/i.test(raw)) return raw.toLowerCase();
  if (/^[0-9a-f]{64}$/i.test(raw)) return `0x${raw.toLowerCase()}`;
  throw new Error("Invalid contract ID (expected 32-byte hex)");
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
  if (!raw) throw new Error(`Missing ${name}`);
  let n;
  try {
    n = BigInt(raw);
  } catch {
    throw new Error(`Invalid ${name}: must be a u64 decimal string`);
  }
  if (n < 0n || n > MAX_U64) throw new Error(`${name} out of range for u64`);
  return n.toString();
}

function parseDrcAccount(s, { name = "account" } = {}) {
  const raw = String(s ?? "").trim();
  if (!raw) throw new Error(`Missing ${name}`);
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
  if (!s) throw new Error("Missing amount");
  if (s.startsWith("-")) throw new Error("Amount must be >= 0");

  let d = Number(decimals ?? 0);
  if (!Number.isFinite(d) || d < 0) d = 0;
  d = Math.min(64, Math.floor(d));

  if (!s.includes(".")) {
    // Integer amount in human units.
    const n = BigInt(s);
    const out = n * 10n ** BigInt(d);
    if (out > MAX_U64) throw new Error("Amount out of range for u64");
    return out.toString();
  }

  const [intRaw, fracRaw = ""] = s.split(".");
  if (intRaw && !/^[0-9]+$/.test(intRaw)) throw new Error("Invalid amount");
  if (fracRaw && !/^[0-9]+$/.test(fracRaw)) throw new Error("Invalid amount");

  const intPart = intRaw ? BigInt(intRaw) : 0n;
  const fracDigits = fracRaw;
  if (fracDigits.length > d) throw new Error(`Too many decimals (max ${d})`);

  const fracPadded = fracDigits.padEnd(d, "0");
  const combined = `${intPart.toString()}${fracPadded}`;
  const out = BigInt(combined);
  if (out > MAX_U64) throw new Error("Amount out of range for u64");
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
        class: "activity-item asset-click-row",
        title: `Open ${sym}`,
        onclick: () => {
          state.assetTokenContractId = cid;
          state.route = "asset_token";
          actions?.render?.().catch(() => {});
        },
      },
      [
        h("div", { class: "asset-ico", text: sym.slice(0, 1).toUpperCase() }),
        h("div", { class: "asset-main" }, [
          h("div", { class: "asset-sym", text: sym }),
          h("div", { class: "asset-name", text: name, title: cid }),
        ]),
        h("div", { class: "asset-row-tail" }, [
          h("div", { class: "asset-bal" }, [
            h("div", { class: "asset-amt" }, [balance(hidden, bal)]),
            h("div", { class: "asset-sub", text: "Balance" }),
          ]),
          h("div", { class: "activity-chevron", text: "›" }),
        ]),
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
        class: "activity-item asset-click-row",
        title: `Open ${sym} #${tokenId || "?"}`,
        onclick: () => {
          state.assetNft = { contractId: cid, tokenId };
          state.route = "asset_nft";
          actions?.render?.().catch(() => {});
        },
      },
      [
        h("div", { class: "asset-ico", html: iconSvg("nft") }),
        h("div", { class: "asset-main" }, [
          h("div", { class: "asset-sym", text: `${sym} #${tokenId || "?"}` }),
          h("div", { class: "asset-name", text: name, title: cid }),
        ]),
        h("div", { class: "asset-row-tail" }, [
          h("div", { class: "asset-bal" }, [
            h("div", { class: "asset-amt", text: "1" }),
            h("div", { class: "asset-sub", text: "NFT" }),
          ]),
          h("div", { class: "activity-chevron", text: "›" }),
        ]),
      ]
    );
  });

  const tokensCard = h("div", { class: "box asset-section-card" }, [
    h("div", { class: "hrow" }, [
      bracketTitle({ class: "asset-section-title", text: "Tokens" }),
      h("button", { class: "btn-outline", text: "Add token", onclick: openAddToken }),
    ]),
    st?.loading ? h("div", { class: "muted", text: "Loading…" }) : null,
    st?.error ? h("div", { class: "err", text: String(st.error) }) : null,
    tokenRows.length ? h("div", { class: "activity-list" }, tokenRows) : h("div", { class: "muted", text: "No tokens added." }),
  ].filter(Boolean));

  const nftCard = h("div", { class: "box asset-section-card" }, [
    h("div", { class: "hrow" }, [
      bracketTitle({ class: "asset-section-title", text: "NFTs" }),
      h("button", { class: "btn-outline", text: "Import NFT", onclick: openAddNft }),
    ]),
    nftRows.length ? h("div", { class: "activity-list" }, nftRows) : h("div", { class: "muted", text: "No NFTs added." }),
  ]);

  return [tokensCard, nftCard];
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
    text: "Lookup",
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
    ? h("div", { class: "box" }, [
        h("div", { class: "hrow" }, [h("div", { class: "muted", text: "Name" }), h("code", { text: String(st.meta?.name ?? "—") })]),
        h("div", { class: "hrow" }, [h("div", { class: "muted", text: "Symbol" }), h("code", { text: String(st.meta?.symbol ?? "—") })]),
        h("div", { class: "hrow" }, [h("div", { class: "muted", text: "Decimals" }), h("code", { text: String(st.meta?.decimals ?? "—") })]),
      ])
    : null;

  return [
    subnav({ title: "Add token", onBack }),
    h("div", { class: "row" }, [
      fieldLabel(input, "Contract ID"),
      input,
      h("div", { class: "btnrow" }, [lookupBtn, addBtn]),
      addError.el,
      st.error ? h("div", { class: "err", text: String(st.error) }) : null,
      metaBox,
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
    text: "Lookup",
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
        if (!st.info) throw new Error("Lookup an NFT first");
        const me = String(ov?.accounts?.[Number(ov?.selectedAccountIndex ?? 0) || 0] ?? "").trim();
        const owner = st.info?.owner;
        const ownerStr = accountEnumToString(owner);
        if (!me || !(owner && typeof owner === "object" && owner.External === me)) {
          throw new Error(`You do not own this NFT (owner is ${truncateMiddle(ownerStr, 10, 8)})`);
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

        return h("div", { class: "box" }, [
          h("div", { class: "hrow" }, [h("div", { class: "muted", text: "Name" }), h("code", { text: String(st.info?.meta?.name ?? "—") })]),
          h("div", { class: "hrow" }, [h("div", { class: "muted", text: "Symbol" }), h("code", { text: String(st.info?.meta?.symbol ?? "—") })]),
          h("div", { class: "hrow" }, [h("div", { class: "muted", text: "Token ID" }), h("code", { text: String(st.info?.tokenId ?? "—") })]),
          h("div", { class: "hrow" }, [h("div", { class: "muted", text: "Owner" }), h("code", { text: ownerStr || "—", title: ownerStr })]),
          h("div", { class: owned ? "muted" : "err", text: owned ? "Owned by this account." : "Not owned by this account." }),
          st.info?.tokenUri ? h("div", { class: "muted", text: `Token URI: ${st.info.tokenUri}` }) : h("div", { class: "muted", text: "Token URI is empty for this contract." }),
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
      h("div", { class: "btnrow" }, [lookupBtn, importBtn]),
      importError.el,
      st.error ? h("div", { class: "err", text: String(st.error) }) : null,
      infoBox,
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
      if (safeBigInt(valueUnits, 0n) <= 0n) throw new Error("Amount must be > 0");

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
      if (safeBigInt(valueUnits, 0n) < 0n) throw new Error("Amount must be >= 0");

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

  const tokenHero = h("div", { class: "box asset-token-hero" }, [
    h("div", { class: "asset-token-head" }, [
      h("div", { class: "asset-token-icon", text: sym.slice(0, 1).toUpperCase() }),
      h("div", { class: "asset-token-titleblock" }, [
        h("div", { class: "asset-token-symbol", text: sym }),
        h("div", { class: "asset-token-name", text: name, title: cid }),
      ]),
    ]),
    h("div", { class: "asset-token-balance" }, [
      h("div", { class: "asset-token-balance-label", text: "Balance" }),
      h("div", { class: "asset-token-balance-value" }, [balance(hidden, balHuman)]),
    ]),
    h("div", { class: "asset-token-meta" }, [
      h("div", { class: "asset-token-meta-row" }, [
        h("span", { text: "Contract" }),
        h("code", { text: truncateMiddle(cid, 12, 10), title: cid }),
      ]),
      balUnits != null
        ? h("div", { class: "asset-token-meta-row" }, [
            h("span", { text: "Atomic units" }),
            h("code", { title: hidden ? undefined : String(balUnits) }, [balance(hidden, String(balUnits))]),
          ])
        : null,
    ].filter(Boolean)),
  ]);

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

  const sendSection = h("div", { class: "box asset-action-section" }, [
    h("div", { class: "asset-action-head" }, [
      h("div", { class: "asset-action-title", text: "Send" }),
    ]),
    fieldLabel(transferToInput, "Recipient"),
    transferToInput,
    fieldLabel(transferAmountInput, "Amount"),
    transferAmountInput,
    transferError.el,
    reviewTransferBtn,
  ]);

  const approveMaxBtn = h("button", {
    class: "btn-outline",
    text: "MAX",
    title: "Unlimited allowance (u64::MAX). Use with caution.",
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
  const approveSection = h("div", { class: "box asset-action-section" }, [
    h("div", { class: "asset-action-head" }, [
      h("div", { class: "asset-action-title", text: "Approve" }),
      h("div", { class: "asset-action-subtitle", text: `Let another account or contract spend ${sym}.` }),
    ]),
    fieldLabel(approveSpenderInput, "Spender"),
    approveSpenderInput,
    fieldLabel(approveAmountInput, "Allowance"),
    h("div", { class: "hrow" }, [
      approveAmountInput,
      approveMaxBtn,
    ]),
    approveError.el,
    reviewApproveBtn,
    h("div", {
      class: "asset-action-note",
      text: "MAX approvals grant broad spending permission. Prefer exact amounts.",
    }),
  ]);

  return [
    subnav({ title: sym, onBack }),
    h("div", { class: "row asset-token-page" }, [
      tokenHero,
      sendSection,
      approveSection,
      h("button", { class: "btn-outline asset-remove-btn", text: "Remove token", onclick: doUnwatch }),
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

  const defaultGas = getDefaultGas(TX_KIND.CONTRACT_CALL);
  const defaultLimit = defaultGas?.limit != null ? String(defaultGas.limit) : "";
  const fallbackPrice = defaultGas?.price != null ? String(defaultGas.price) : "1";

  const gasEditor = document.createElement("dusk-gas-editor");
  gasEditor.maxDecimals = UI_DISPLAY_DECIMALS;
  gasEditor.amountLux = "0";
  gasEditor.setGas(d?.gas ?? null);

  // The gas price suggestion opens with the fee's Edit.
  const gasHint = h("div", { class: "muted", text: "Loading gas price suggestion…" });
  gasEditor.setEditContent([gasHint]);

  (async () => {
    try {
      if (d?.gas) {
        gasHint.textContent = defaultLimit ? `Default gas limit: ${defaultLimit}` : "Gas is set.";
        return;
      }
      const resp = await actions?.send?.({ type: "DUSK_UI_GET_CACHED_GAS_PRICE" });
      if (resp?.error) throw new Error(resp.error.message ?? "Failed to fetch gas price");
      const stats = resp?.result ?? resp;
      const median = String(stats?.median ?? stats?.average ?? "1");
      gasHint.textContent = `Gas price suggestion (LUX): median ${median}`;
      if (defaultLimit) gasEditor.setGas({ limit: defaultLimit, price: median });
      else gasEditor.setGas({ limit: "", price: median || fallbackPrice });
    } catch {
      gasHint.textContent = "Gas price unavailable (using defaults).";
      if (defaultLimit && fallbackPrice) gasEditor.setGas({ limit: defaultLimit, price: fallbackPrice });
    }
  })().catch(() => {});

  const valueUnits = String(d?.asset?.valueUnits ?? d?.asset?.value ?? "0");
  const valueHuman = formatTokenUnits(valueUnits, dec, { maxFrac: UI_DISPLAY_DECIMALS });

  const title =
    op === "transfer"
      ? `Send ${valueHuman} ${sym}`
      : op === "approve"
      ? `Approve ${sym}`
      : "Contract call";

  const subtitle =
    op === "transfer"
      ? d?.asset?.to
        ? `to ${truncateMiddle(String(d.asset.to), 12, 10)}`
        : ""
      : op === "approve"
      ? d?.asset?.spender
        ? `spender ${truncateMiddle(String(d.asset.spender), 12, 10)}`
        : ""
      : "";

  const warn =
    op === "approve" && d?.asset?.isMax
      ? h("div", {
          class: "err",
          text: "Unlimited approval. The spender can transfer any amount of this token from your account.",
        })
      : null;

  // Back returns to the token, so Review has no Cancel.
  const confirmBtn = h("button", { class: "btn-primary", text: "Confirm" });

  // Gas that won't do says so above Confirm; nothing is sent.
  const confirmError = h("div", { class: "field-error", role: "alert", hidden: true });

  confirmBtn.addEventListener("click", async () => {
    let gas;
    try {
      gas = gasEditor.readFinalGas();
    } catch (e) {
      confirmError.textContent = e?.message ?? String(e);
      confirmError.hidden = false;
      return;
    }
    confirmError.hidden = true;
    confirmBtn.disabled = true;
    state.assetTxDraft.gas = gas;

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
        to: counterparty ? { name: "", address: counterparty, short: truncateMiddle(counterparty, 6, 6) } : null,
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
        state.assetTxDraft = null;
      },
    });
    confirmBtn.disabled = false;
  });
  submitOnGasEnter(gasEditor, confirmBtn);

  return [
    subnav({ title: "Review", onBack }),
    h("div", { class: "row" }, [
      h("div", { class: "box tx-summary" }, [
        h("div", { class: "muted", text: title }),
        subtitle ? h("div", { class: "muted", text: subtitle }) : null,
        h("div", { class: "muted", text: `Units: ${valueUnits}` }),
        h("div", { class: "muted" }, [h("code", { text: String(params?.contractId ?? "") })]),
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
    h("div", { class: "row" }, [
      h("div", { class: "box tx-summary" }, [
        h("div", { class: "muted", text: name }),
        h("div", { class: "muted" }, [h("code", { text: cid })]),
        tokenUri ? h("div", { class: "muted", text: `Token URI: ${tokenUri}` }) : h("div", { class: "muted", text: "Token URI is empty." }),
      ]),
      tokenUri
        ? h("div", {
            class: "muted",
            text: "Media previews are disabled for now.",
          })
        : null,
      h("button", { class: "btn-outline", text: "Remove NFT", onclick: doUnwatch }),
    ].filter(Boolean)),
  ];
}
