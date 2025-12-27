export const NETWORK_PRESETS = [
  {
    id: "mainnet",
    label: "Mainnet",
    nodeUrl: "https://nodes.dusk.network",
    explorerBase: "https://apps.dusk.network/explorer",
    hint: "Public mainnet",
  },
  {
    id: "testnet",
    label: "Testnet",
    nodeUrl: "https://testnet.nodes.dusk.network",
    explorerBase: "https://apps.testnet.dusk.network/explorer",
    hint: "Public testnet",
  },
  {
    id: "devnet",
    label: "Devnet",
    nodeUrl: "https://devnet.nodes.dusk.network",
    explorerBase: "https://apps.devnet.dusk.network/explorer",
    hint: "Experimental network",
  },
  {
    id: "local",
    label: "Local",
    nodeUrl: "http://127.0.0.1:8080",
    explorerBase: null,
    hint: "For a locally running node (Rusk HTTP/RUES on :8080)",
  },
  {
    id: "custom",
    label: "Custom",
    nodeUrl: "",
    explorerBase: null,
    hint: "Use any Rusk/RUES-enabled node URL",
  },
];
