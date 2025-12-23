export const NETWORK_PRESETS = [
  {
    id: "mainnet",
    label: "Mainnet",
    nodeUrl: "https://nodes.dusk.network",
    hint: "Public mainnet",
  },
  {
    id: "testnet",
    label: "Testnet",
    nodeUrl: "https://testnet.nodes.dusk.network",
    hint: "Public testnet",
  },
  {
    id: "devnet",
    label: "Devnet",
    nodeUrl: "https://devnet.nodes.dusk.network",
    hint: "Experimental network",
  },
  {
    id: "local",
    label: "Local",
    nodeUrl: "http://127.0.0.1:8080",
    hint: "For a locally running node (Rusk HTTP/RUES on :8080)",
  },
  {
    id: "custom",
    label: "Custom",
    nodeUrl: "",
    hint: "Use any Rusk/RUES-enabled node URL",
  },
];
