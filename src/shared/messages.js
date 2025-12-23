// Central list of message type strings.
// Keeping these in one place helps prevent drift/typos.

export const MSG = Object.freeze({
  // Provider / RPC
  RPC_REQUEST: "DUSK_RPC_REQUEST",
  RPC_RESPONSE: "DUSK_RPC_RESPONSE",

  // Engine bridge
  ENGINE_CALL: "DUSK_ENGINE_CALL",

  // UI <-> background
  UI_UNLOCK: "DUSK_UI_UNLOCK",
  UI_LOCK: "DUSK_UI_LOCK",
  UI_CREATE_WALLET: "DUSK_UI_CREATE_WALLET",
  UI_STATUS: "DUSK_UI_STATUS",
  UI_SET_NODE_URL: "DUSK_UI_SET_NODE_URL",
  UI_OVERVIEW: "DUSK_UI_OVERVIEW",
  UI_SEND_TX: "DUSK_UI_SEND_TX",
  UI_TRANSFER: "DUSK_UI_TRANSFER",

  // Approvals
  GET_PENDING: "DUSK_GET_PENDING",
  PENDING_DECISION: "DUSK_PENDING_DECISION",
});
