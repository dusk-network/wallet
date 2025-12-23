import { isOptionsPage } from "./env.js";

export const ONBOARD_ROUTES = new Set([
  "onboard_welcome",
  "onboard_create_password",
  "onboard_create_phrase",
  "onboard_create_confirm",
  "onboard_import",
]);

export const state = {
  // home | send | confirm | receive | options | onboarding_*...
  route: isOptionsPage ? "options" : "home",
  overview: null,
  draft: null,
  banner: null,
  toast: null,
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
