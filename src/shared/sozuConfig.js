const SOZU_CONFIGS = Object.freeze({
  testnet: Object.freeze({
    networkKey: "testnet",
    contracts: Object.freeze({
      hub: "bae85f8c24730a5a19fbe3d3bd58248ac8c302b62fe414a8c640d8c0ed286b9e",
      pool: "72883945ac1aa032a88543aacc9e358d1dfef07717094c05296ce675f23078f2",
      relayer: "51ced4fad52fc590def2736969c9e3e30013275a996c53714b81d8a08774aa37",
      substrate: "0077ecbf88aa20d6d0a6afa20bd26300a2b562fdbac368bf1e3c1325e8555941",
    }),
  }),
  mainnet: Object.freeze({
    networkKey: "mainnet",
    contracts: Object.freeze({
      hub: "b32c917e76abc6fcf2edbee0fa70231d8e19c405b18421794a11badfc66d2f26",
      pool: "6fdfdc713a18fc6ca2ad20eb2b4a3305a935ef47d6a872d9a4df8bc9fd9d169e",
      relayer: "1cc415d05b1cfbf2583bf2e8a0e39b2c768d263ef92d6a21a4787f76c6afa924",
      substrate: "bc6f50f7404d098cdd1117b15dddab6f6f3dad01c5ce3c5ce9b68a8b60bc4c1d",
    }),
  }),
});

function normalizeNetworkKey(value) {
  const key = String(value ?? "").trim().toLowerCase();
  if (key === "1" || key === "main" || key === "mainnet") return "mainnet";
  if (key === "2" || key === "test" || key === "testnet") return "testnet";
  return key;
}

export function getSozuConfig(networkKeyOrChainId) {
  const key = normalizeNetworkKey(networkKeyOrChainId);
  return SOZU_CONFIGS[key] ?? null;
}

export function listSozuConfigs() {
  return Object.values(SOZU_CONFIGS);
}

export function hasSozuConfig(networkKeyOrChainId) {
  return Boolean(getSozuConfig(networkKeyOrChainId));
}
