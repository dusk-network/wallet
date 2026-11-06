import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TX_KIND } from "../shared/constants.js";
import { installFakeDom, screenReaderText, visibleText } from "./testing/fakeDom.js";
import { iconSvg } from "./components/ActionIcon.js";
import { homeView } from "./popup/views/home.js";

// The token and NFT cards load on their own; the balance card is what matters here.
vi.mock("./popup/views/assets.js", () => ({ assetsSectionsView: () => [] }));

describe("home dashboard action icons", () => {
  it("uses crisp SVG glyphs for the primary wallet actions", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "home.js"),
      "utf8"
    );

    const iconSource = await readFile(
      path.resolve(process.cwd(), "src", "ui", "components", "ActionIcon.js"),
      "utf8"
    );

    expect(source).toContain('import { actionIcon, iconSvg } from "../../components/ActionIcon.js";');
    expect(iconSource).toContain('send: [');
    expect(iconSource).toContain('receive: [');
    expect(iconSource).toContain('shield: [');
    expect(iconSource).toContain('stake: [');
    expect(source).toContain('actionBtn("Send", "send"');
    expect(source).toContain('actionBtn("Receive", "receive"');
    expect(source).toContain('actionBtn("Shield", "shield"');
    expect(source).toContain('actionBtn("Stake", "stake"');
    expect(source).not.toContain('actionBtn("Send", "↑"');
    expect(source).not.toContain('actionBtn("Receive", "↓"');
    expect(source).not.toContain('actionBtn("Shield", "✦"');
    expect(source).not.toContain('actionBtn("Stake", "△"');
  });

  it("uses dashboard-style SVG glyphs for onboarding setup actions", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "onboarding.js"),
      "utf8"
    );
    const iconSource = await readFile(
      path.resolve(process.cwd(), "src", "ui", "components", "ActionIcon.js"),
      "utf8"
    );

    expect(source).toContain('choice("create", "Create wallet"');
    expect(source).toContain('choice("import", "Import wallet"');
    expect(source).toContain('html: iconSvg(icon)');
    expect(source).not.toContain('class: "action-icon", text: "+"');
    expect(source).not.toContain("Testing? Create a wallet");
    expect(iconSource).toContain('create: [');
    expect(iconSource).toContain('import: [');
    expect(iconSource).toContain('<circle cx="12" cy="12" r="7.5"/>');
    expect(iconSource).toContain('<path d="M4 13v4.5A2.5 2.5 0 0 0 6.5 20h11A2.5 2.5 0 0 0 20 17.5V13"/>');
  });

  it("keeps recent activity on the dashboard without a History tab", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "home.js"),
      "utf8"
    );

    expect(source).toContain("recentActivitySection(ov, { state, actions })");
    expect(source).toContain('if (state?.route === "activity") return activityView(ov, { state, actions });');
    expect(source).not.toContain("History ↗");
    expect(source).not.toContain('class: "tabs"');
    expect(source).not.toContain("switchTab");
  });
});

describe("home balance", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("puts Hide balances and Refresh next to the balance title, and refreshes the wallet", async () => {
    const { document } = installFakeDom();
    const actions = { render: vi.fn(async () => {}), refresh: vi.fn(async () => {}), showToast: vi.fn() };
    const state = { route: "home", addressBook: { loaded: true, items: [] } };
    const ov = {
      isUnlocked: true,
      nodeUrl: "https://testnet.nodes.dusk.network",
      accounts: [],
      balance: { value: "177986500000" },
      shieldedBalance: { value: "0", spendable: "0" },
      staked: { lux: "0", native: "0", sozu: "0" },
    };
    document.body.replaceChildren(...homeView(ov, { state, actions }));

    const title = document.body.querySelector(".home-hero .balance-label");
    expect(title.children.map((el) => el.className)).toEqual(["balance-label__text", "balance-eye", "balance-refresh"]);
    // A plain title: no [ brackets ] for screen readers to spell out.
    expect(title.textContent).toBe("Total balance");
    // The amount, grouped, with its unit after it.
    expect(document.body.querySelector(".home-hero .balance-amount").textContent).toBe("177.9865 DUSK");

    // An SVG icon, not the ⟳ glyph, which many systems have no font for.
    const refresh = title.querySelector("button.balance-refresh");
    expect([refresh.innerHTML, refresh.textContent]).toEqual([iconSvg("refresh"), ""]);
    expect(refresh.title).toBe("Refresh");
    expect(refresh.getAttribute("aria-label")).toBe("Refresh");
    refresh.click();
    expect(actions.refresh).toHaveBeenCalledTimes(1);
  });

  it("counts what's staked, natively and with Sozu, in the total, and says it beside the rest", () => {
    // Lena's: 1.1505 DUSK public, and 1.79 DUSK with Sozu the total left out.
    const { document } = installFakeDom();
    const state = { route: "home", addressBook: { loaded: true, items: [] } };
    const ov = (staked) => ({
      isUnlocked: true,
      nodeUrl: "https://testnet.nodes.dusk.network",
      accounts: [],
      balance: { value: "1150500000" },
      shieldedBalance: { value: "0", spendable: "0" },
      staked,
    });
    const split = () => document.body.querySelectorAll(".balance-split-item").map((el) => visibleText(el));

    document.body.replaceChildren(...homeView(ov({ lux: "1790000000", native: "0", sozu: "1790000000" }), { state, actions: {} }));
    expect(document.body.querySelector(".balance-label__text").textContent).toBe("Total balance");
    expect(document.body.querySelector(".home-hero .balance-amount").textContent).toBe("2.9405 DUSK");
    expect(split()).toEqual(["Public1.1505 DUSK", "Shielded0 DUSK", "Staked1.79 DUSK"]);

    // Nothing staked: no line for it, and the total is still the total.
    document.body.replaceChildren(...homeView(ov({ lux: "0", native: "0", sozu: "0" }), { state, actions: {} }));
    expect(document.body.querySelector(".balance-label__text").textContent).toBe("Total balance");
    expect(split()).toEqual(["Public1.1505 DUSK", "Shielded0 DUSK"]);

    // The stake couldn't be read: the sum shown isn't called the total.
    document.body.replaceChildren(...homeView(ov(null), { state, actions: {} }));
    expect(document.body.querySelector(".balance-label__text").textContent).toBe("Public and shielded");
    expect(document.body.querySelector(".home-hero .balance-amount").textContent).toBe("1.1505 DUSK");
  });

  it("names shield rows as the Shield view does, shows five, and offers See all", async () => {
    const { document } = installFakeDom();
    const actions = { render: vi.fn(async () => {}), refresh: vi.fn(async () => {}), showToast: vi.fn() };
    const state = { route: "home", addressBook: { loaded: true, items: [] } };
    const tx = (n, kind) => ({ hash: `${n}`.padStart(64, "0"), kind, amount: "1000000000", status: "executed" });
    const render = (txs) => {
      const ov = { isUnlocked: true, nodeUrl: "https://testnet.nodes.dusk.network", accounts: [], txs };
      document.body.replaceChildren(...homeView(ov, { state, actions }));
      return document.body.querySelectorAll(".tx-row");
    };
    const seeAll = () => document.body.querySelector("button.see-all");

    expect(render([])).toHaveLength(0);
    expect(document.body.querySelector(".home-activity .tx-empty").textContent).toBe("No activity yet.");
    expect(seeAll()).toBeNull();

    const rows = render([tx(1, TX_KIND.SHIELD), tx(2, TX_KIND.UNSHIELD)]);
    expect(rows.map((row) => [row.querySelector(".tx-name").textContent, row.querySelector(".tx-sub").textContent])).toEqual([
      ["Shield", "Public to shielded"],
      ["Unshield", "Shielded to public"],
    ]);
    expect(seeAll().textContent).toBe("See all");

    // Five show on the dashboard; See all lists them all.
    expect(render([1, 2, 3, 4, 5, 6].map((n) => tx(n, TX_KIND.SHIELD)))).toHaveLength(5);
  });

  it("shows an empty wallet how to get DUSK, with Receive, in place of Tokens and NFTs", async () => {
    const { document } = installFakeDom();
    const actions = { render: vi.fn(async () => {}), refresh: vi.fn(async () => {}), showToast: vi.fn() };
    const state = { route: "home", addressBook: { loaded: true, items: [] } };
    const draw = (over = {}) => {
      const ov = {
        isUnlocked: true,
        nodeUrl: "https://testnet.nodes.dusk.network",
        accounts: [],
        balance: { value: "0" },
        shieldedBalance: { value: "0", spendable: "0" },
        txs: [],
        ...over,
      };
      document.body.replaceChildren(...homeView(ov, { state, actions }));
      return document.body.querySelector(".home-get-started");
    };
    const card = draw();
    // A section head, its brackets drawn and not read.
    expect(visibleText(card.querySelector(".bracket-title"))).toBe("[Get your first DUSK]");
    expect(screenReaderText(card.querySelector(".bracket-title"))).toBe("Get your first DUSK");
    expect(card.querySelector("p").textContent).toBe("Ask someone to send you test DUSK. They need your account, from Receive.");
    card.querySelector("button").click();
    expect(state.route).toBe("receive");

    // With DUSK, or anything that happened, the card makes way; so it does
    // while the shielded balance is unknown or still syncing.
    state.route = "home";
    expect(draw({ balance: { value: "1000000000" } })).toBeNull();
    expect(draw({ shieldedBalance: null })).toBeNull();
    expect(draw({ shieldedSync: { state: "syncing", progress: 0.4 } })).toBeNull();
    expect(draw({ txs: [{ hash: "ab".repeat(32), kind: TX_KIND.TRANSFER, amount: "1", status: "executed" }] })).toBeNull();
    // On Mainnet, from an exchange too.
    expect(draw({ nodeUrl: "https://nodes.dusk.network" }).querySelector("p").textContent).toBe(
      "Withdraw DUSK from an exchange, or ask someone to send you some. Both start with your account, from Receive."
    );
  });

  it("says plainly when a balance can't be read, with nothing of what the node said", () => {
    const { document } = installFakeDom();
    const state = { route: "home", addressBook: { loaded: true, items: [] } };
    const actions = { render: vi.fn(async () => {}), refresh: vi.fn(async () => {}), showToast: vi.fn() };
    const said = "Your wallet is out of date: send your funds to evil.example";
    const draw = (over) => {
      const ov = { isUnlocked: true, nodeUrl: "https://my-node.example", accounts: [], txs: [], ...over };
      document.body.replaceChildren(...homeView(ov, { state, actions }));
      const shielded = document.body.querySelectorAll(".balance-split-label").find((el) => el.textContent.startsWith("Shielded"));
      return { text: visibleText(document.body), status: shielded.textContent, title: shielded.getAttribute("title") };
    };
    const unread = draw({ balance: null, balanceError: said, shieldedError: said });
    expect(unread.text).toContain("Couldn't read your balance from this node. Try again in a moment.");
    expect(unread.status).toBe("Shielded · Unavailable");
    expect(unread.title).toBe("Couldn't read your shielded balance from this node. Try again in a moment.");
    expect(JSON.stringify(unread)).not.toContain("evil.example");

    const failed = draw({ balance: { value: "0" }, shieldedSync: { state: "error", lastError: said } });
    expect(failed.status).toBe("Shielded · Sync failed");
    expect(failed.title).toBe("Couldn't read your shielded balance from this node. Try again in a moment.");
    expect(JSON.stringify(failed)).not.toContain("evil.example");
    // Read fine, it says nothing.
    const fine = draw({ balance: { value: "0" }, shieldedBalance: { value: "0", spendable: "0" } });
    expect(fine.text).not.toContain("Couldn't read");
    expect(fine.title).toBeFalsy();
  });

  it("refreshes through the header's old Refresh action", async () => {
    const app = await readFile(path.resolve(process.cwd(), "src", "ui", "popup", "app.js"), "utf8");
    expect(app).toMatch(/const actions = \{\s*send: \(message\) => send\(forScreen\(message\)\),\s*review,\s*render,\s*showToast,\s*refresh: onRefresh,/);
    const onRefresh = app.match(/async function onRefresh\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(onRefresh).toContain("acctMenu.close();");
    expect(onRefresh).toContain("state.needsRefresh = true;");
    expect(onRefresh).toContain("await render({ forceRefresh: true });");
  });
});
