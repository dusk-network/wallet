// The networks Settings and the network menu offer: Dusk's own, with their
// endpoints and explorer from their files in @dusk-network/networks, then a
// node on this machine and any other. `hint` is a preset's second line,
// where its name doesn't say it all.

import { networks } from "@dusk-network/networks";

const own = (net, extra = {}) => ({
  id: net.name,
  label: net.label,
  nodeUrl: net.urls.node,
  proverUrl: net.urls.prover,
  archiverUrl: net.urls.archive,
  explorerBase: net.apps.explorer,
  ...extra,
});

export const NETWORK_PRESETS = [
  own(networks.mainnet),
  own(networks.testnet),
  own(networks.devnet, { hint: "Experimental" }),
  {
    id: "local",
    label: "Local",
    nodeUrl: "http://127.0.0.1:8080",
    proverUrl: "http://127.0.0.1:8080",
    archiverUrl: "http://127.0.0.1:8080",
    explorerBase: null,
    hint: "127.0.0.1:8080",
  },
  {
    id: "custom",
    label: "Custom",
    nodeUrl: "",
    proverUrl: "",
    archiverUrl: "",
    explorerBase: null,
    hint: "Any node URL",
  },
];
