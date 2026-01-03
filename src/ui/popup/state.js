import { isOptionsPage } from "./env.js";

export const ONBOARD_ROUTES = new Set([
  "onboard_welcome",
  "onboard_create_password",
  "onboard_create_phrase",
  "onboard_create_confirm",
  "onboard_import",
]);

export const state = {
  // home | send | confirm | convert | convert_confirm | receive | activity | tx | options | onboarding_*...
  route: (() => {
    if (isOptionsPage) return "options";
    try {
      const r = new URLSearchParams(location.search).get("route");
      const allowed = new Set([
        "home",
        "send",
        "confirm",
        "convert",
        "convert_confirm",
        "receive",
        "activity",
        "tx",
        "options",
      ]);
      if (r && allowed.has(r)) return r;
    } catch {
      // ignore
    }
    return "home";
  })(),
  // Optional highlight for Activity screen (e.g. opened from notifications)
  highlightTx: (() => {
    try {
      return new URLSearchParams(location.search).get("tx") || null;
    } catch {
      return null;
    }
  })(),
  // Selected tx hash for the Tx details view
  txDetailHash: (() => {
    try {
      return new URLSearchParams(location.search).get("hash") || null;
    } catch {
      return null;
    }
  })(),
  txDetailFrom: null,
  overview: null,
  draft: null,
  toast: null,
  // { hash: string, kind: "ok"|"bad", at: number }
  txPulse: null,
  onboard: {
    // mode: "create" | "import"
    mode: null,
    mnemonic: null,
    password: "",
    reveal: false,
  },
  receive: {
    // Receive screen state
    tab: "shielded", // "shielded" | "public"
    amountDusk: "", // Optional amount encoded into receive QR / request link
    memo: "", // Optional memo/message included in request link
  },
  needsRefresh: true,
  lastOrigin: null,
};
