import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TX_KIND } from "../shared/constants.js";
import { installFakeDom } from "./testing/fakeDom.js";
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

    expect(source).toContain('actionIcon("create", { className: "action-icon" })');
    expect(source).toContain('actionIcon("import", { className: "action-icon" })');
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

    expect(source).toContain("Recent activity");
    expect(source).toContain("View all");
    expect(source).toContain("History ↗");
    expect(source).toContain("explorerAccountUrl");
    expect(source).toContain('state.route = "activity"');
    expect(source).toContain("txs.slice(0, 5)");
    expect(source).toContain("activity-head-actions");
    expect(source).toContain("activity-card-footer");
    expect(source).toContain("activityList(txs");
    expect(source).toContain("listAddressBook()");
    expect(source).toContain("contactForTx(tx)");
    expect(source).toContain("activity-contact-badge");
    expect(source).not.toContain("Cached activity");
    expect(source).not.toContain('h("span", { text: "Activity" })');
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

  it("names shield rows as the Shield view does, and offers View all only for more than the card shows", async () => {
    const { document } = installFakeDom();
    const actions = { render: vi.fn(async () => {}), refresh: vi.fn(async () => {}), showToast: vi.fn() };
    const state = { route: "home", addressBook: { loaded: true, items: [] } };
    const tx = (n, kind) => ({ hash: `${n}`.padStart(64, "0"), kind, amount: "1000000000", status: "executed" });
    const render = (txs) => {
      const ov = { isUnlocked: true, nodeUrl: "https://testnet.nodes.dusk.network", accounts: [], txs };
      document.body.replaceChildren(...homeView(ov, { state, actions }));
      return document.body.querySelectorAll(".activity-tx-item");
    };

    const rows = render([tx(1, TX_KIND.SHIELD), tx(2, TX_KIND.UNSHIELD)]);
    expect(rows.map((row) => row.querySelector(".activity-title span").textContent)).toEqual(["Shield", "Unshield"]);
    expect(rows.map((row) => row.querySelector(".activity-sub span").textContent)).toEqual([
      "Public → Shielded",
      "Shielded → Public",
    ]);
    expect(document.body.querySelector(".activity-view-all")).toBeNull();

    // Five show on the dashboard; View all lists the rest too.
    expect(render([1, 2, 3, 4, 5].map((n) => tx(n, TX_KIND.SHIELD)))).toHaveLength(5);
    expect(document.body.querySelector(".activity-view-all")).toBeNull();
    expect(render([1, 2, 3, 4, 5, 6].map((n) => tx(n, TX_KIND.SHIELD)))).toHaveLength(5);
    expect(document.body.querySelector(".activity-view-all").textContent).toBe("View all");
  });

  it("refreshes through the header's old Refresh action", async () => {
    const app = await readFile(path.resolve(process.cwd(), "src", "ui", "popup", "app.js"), "utf8");
    expect(app).toMatch(/const actions = \{ send, render, showToast, refresh: onRefresh[,}]/);
    const onRefresh = app.match(/async function onRefresh\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(onRefresh).toContain("acctMenu.close();");
    expect(onRefresh).toContain("state.needsRefresh = true;");
    expect(onRefresh).toContain("await render({ forceRefresh: true });");
  });
});
