import { afterEach, describe, expect, it, vi } from "vitest";

import { installFakeDom, visibleText } from "../testing/fakeDom.js";

vi.mock("../../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: vi.fn(async () => null),
}));

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const SECOND =
  "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";

const overview = {
  hasVault: true,
  isUnlocked: true,
  networkName: "Testnet",
  nodeUrl: "https://testnet.nodes.dusk.network",
  accounts: [ACCOUNT, SECOND],
  accountCount: 2,
  selectedAccountIndex: 0,
};

// The popup, or the full view in a tab; env.js reads which when it loads.
const VIEWS = {
  popup: { pathname: "/popup.html", bodyClass: "page--popup" },
  full: { pathname: "/full.html", bodyClass: "page--full" },
};

let menus = [];

async function setup(view) {
  const dom = installFakeDom({ pathname: VIEWS[view].pathname });
  dom.document.body.className = VIEWS[view].bodyClass;
  vi.resetModules();
  const names = await import("../../shared/duskNames.js");
  names.lookupPrimaryName.mockReset();
  names.lookupPrimaryName.mockResolvedValue(null);
  const { createHeaderRenderer } = await import("./header.js");
  const { createAccountMenuController } = await import("../components/AccountMenu.js");

  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const acctMenu = createAccountMenuController({ onSelectAccountIndex: vi.fn() });
  menus.push(acctMenu);
  const renderHeader = createHeaderRenderer({
    headerActionsHost: host,
    netMenu: { isOpen: false, open: vi.fn(), close: vi.fn() },
    acctMenu,
    onOpenOptions: vi.fn(),
    onExpand: vi.fn(),
  });
  return {
    dom,
    names,
    host,
    acctMenu,
    renderHeader,
    chip: () => host.querySelector(".account-chip"),
    menu: () => dom.document.body.querySelector(".acct-menu"),
  };
}

afterEach(() => {
  for (const menu of menus) menu.close();
  menus = [];
  vi.unstubAllGlobals();
});

// The panel's strip over the header, as popup.html and full.html have it, and the network's pill.
function page(dom) {
  const panel = dom.document.createElement("div");
  panel.className = "panel";
  const pill = dom.document.createElement("button");
  pill.id = "network-pill";
  const label = dom.document.createElement("span");
  label.className = "network-pill__label";
  pill.appendChild(label);
  panel.appendChild(pill);
  dom.document.body.appendChild(panel);
  const strips = () => panel.querySelectorAll(".testnet-strip");
  return {
    label: () => label.textContent,
    strips,
    strip: () => (strips()[0] ? visibleText(strips()[0]) : ""),
    dot: () => pill.querySelector(".net-status-dot"),
  };
}

// What the strip says of a test network: that its DUSK has no value, in the app's own words.
async function noValueNote() {
  const { dom, renderHeader } = await setup("popup");
  const { strip } = page(dom);
  renderHeader(overview);
  return strip().replace("Testnet", "").replace(/^[\s·]+/, "");
}

describe("the network at the top", () => {
  it("is Custom, saying whose, while the prover or the archiver isn't the network's own", async () => {
    const { dom, renderHeader } = await setup("popup");
    const { label, strip } = page(dom);
    const own = { ...overview, proverUrl: "https://testnet.provers.dusk.network", archiverUrl: "https://testnet.nodes.dusk.network" };
    renderHeader(own);
    expect(label()).toBe("Testnet");
    expect(strip()).not.toBe("");
    expect(strip()).not.toContain("example");

    renderHeader({ ...own, proverUrl: "http://hostile-node.example", archiverUrl: "https://hostile-node.example" });
    expect(label()).toBe("Custom");
    expect(strip()).toContain("hostile-node.example");
    renderHeader({ ...own, archiverUrl: "https://archive.example" });
    expect(label()).toBe("Custom");
    expect(strip()).toContain("archive.example");

    // Mainnet's own node says nothing, unless what it uses with it is someone else's.
    const mainnet = { ...overview, networkName: "Mainnet", nodeUrl: "https://nodes.dusk.network", proverUrl: "https://provers.dusk.network", archiverUrl: "https://nodes.dusk.network" };
    renderHeader(mainnet);
    expect([label(), strip()]).toEqual(["Mainnet", ""]);
    renderHeader({ ...mainnet, proverUrl: "https://prover.example" });
    expect(label()).toBe("Custom");
    expect(strip()).toContain("prover.example");
  });

  it.each(Object.keys(VIEWS))("says above the header that test DUSK has no value, on a test network only (%s)", async (view) => {
    const note = await noValueNote();
    expect(note).not.toBe("");
    const { dom, renderHeader } = await setup(view);
    const { strips, strip } = page(dom);

    renderHeader(overview);
    expect(strips()).toHaveLength(1);
    expect(strip()).toContain(note);
    // Locked, it still says so; a redraw keeps the one strip.
    renderHeader({ ...overview, isUnlocked: false });
    expect(strips()).toHaveLength(1);
    renderHeader({ ...overview, networkName: "Devnet", nodeUrl: "https://devnet.nodes.dusk.network" });
    expect(strip()).toContain(note);

    renderHeader({ ...overview, networkName: "Mainnet", nodeUrl: "https://nodes.dusk.network" });
    expect(strips()).toHaveLength(0);
  });

  it("says which custom node it's on, whatever it says of itself, with no test-network words and no green", async () => {
    const note = await noValueNote();
    const { dom, renderHeader } = await setup("popup");
    const { label, strip, dot } = page(dom);
    const custom = { ...overview, networkName: "Custom", nodeUrl: "https://nodes.dusk.network.evil.example", networkStatus: { nodeStatus: "online" } };

    for (const chainId of [2, 3, 0, null, 9]) {
      renderHeader({ ...custom, chainId });
      expect(label()).toBe("Custom");
      expect(strip()).toContain("nodes.dusk.network.evil.example");
      expect(strip()).not.toContain(note);
      expect(dot().classList.contains("net-status--online")).toBe(false);
    }
    // Where what's signed there counts, when that's a network's chain.
    renderHeader({ ...custom, chainId: 1 });
    expect(strip()).toContain("nodes.dusk.network.evil.example");
    expect(strip()).toContain("Mainnet");
    // The real thing is green, and says nothing above its header.
    renderHeader({ ...overview, networkName: "Mainnet", nodeUrl: "https://nodes.dusk.network", networkStatus: { nodeStatus: "online" } });
    expect(strip()).toBe("");
    expect(dot().classList.contains("net-status--online")).toBe(true);
  });

  it("says a node on this machine's test DUSK has no value only on a chain of its own", async () => {
    const note = await noValueNote();
    const { dom, renderHeader } = await setup("popup");
    const { strip } = page(dom);
    const local = { ...overview, networkName: "Local", nodeUrl: "http://127.0.0.1:8080" };
    renderHeader({ ...local, chainId: 0 });
    expect(strip()).toContain(note);
    renderHeader({ ...local, chainId: 1 });
    expect(strip()).not.toContain(note);
    expect(strip()).toContain("127.0.0.1:8080");
    expect(strip()).toContain("Mainnet");
  });

  it("says why nothing is signed on a node that contradicts the chain it's fixed to", async () => {
    const { dom, renderHeader } = await setup("popup");
    const { strip } = page(dom);
    const refusal = "hostile-node.example now says it's on Mainnet (chain 1), not Testnet (chain 2). Nothing was signed, because a signature here could count on the other network.";
    renderHeader({ ...overview, networkName: "Custom", nodeUrl: "https://hostile-node.example", chainId: 2, chainRefusal: refusal });
    expect(strip()).toBe(refusal);
  });
});

describe("the account at the top", () => {
  it("leaves the chip out while the wallet is locked", async () => {
    const { renderHeader, chip } = await setup("popup");
    renderHeader(overview);
    expect(chip()).not.toBeNull();
    renderHeader({ ...overview, isUnlocked: false });
    expect(chip()).toBeNull();
  });
});
