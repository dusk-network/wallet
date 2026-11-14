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

  // Chen's on Firefox for Android: opened with no signal, "—" in place of the balance, while it said the balance
  // "may be out of date". Lena's: a stake that couldn't be read went without a word.
  it("shows the balance read last where it can't be read now, says so with when it was read, and names a part it couldn't read", () => {
    const { document } = installFakeDom();
    const state = { route: "home", addressBook: { loaded: true, items: [] } };
    const readAt = new Date(2026, 10, 12, 19, 52).getTime();
    const draw = (over, online = true) => {
      vi.stubGlobal("navigator", { ...globalThis.navigator, onLine: online });
      const ov = { isUnlocked: true, nodeUrl: "https://testnet.nodes.dusk.network", accounts: [], txs: [], balance: { value: "857535243" }, shieldedBalance: { value: "0", spendable: "0" }, staked: { lux: "247500000", native: "0", sozu: "247500000" }, ...over };
      document.body.replaceChildren(...homeView(ov, { state, actions: {} }));
      return {
        total: document.body.querySelector(".home-hero .balance-amount").textContent,
        label: document.body.querySelector(".balance-label__text").textContent,
        note: document.body.querySelector(".balance-stale")?.textContent ?? "",
      };
    };
    // Opened offline: the figures read last, never a dash, and when they were read.
    const offline = draw({ balanceError: "Failed to fetch", balanceStale: true, balanceReadAt: readAt, shieldedStale: true, stakeStale: true }, false);
    expect(offline.total).toBe("1.105 DUSK");
    expect(offline.label).toBe("Total balance");
    expect(offline.note).toMatch(/^Your balance may be out of date until you're back online\. Last read (at|yesterday at|on .+ at) /);
    // Online, the node silent: the same, without the connection.
    expect(draw({ balanceError: "timed out", balanceStale: true, balanceReadAt: readAt }).note).toMatch(/^Your balance may be out of date\. Last read /);
    // What the node couldn't give now, by name: the stake; the stake and the shielded balance.
    expect(draw({ stakeStale: true }).note).toBe("Your stake couldn't be read just now, so it may be out of date.");
    expect(draw({ stakeStale: true, shieldedStale: true }).note).toBe("Your shielded balance and stake couldn't be read just now, so they may be out of date.");
    expect(draw({}).note).toBe("");
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

describe("payments from Send waiting for the network, on Home", () => {
  // Amélie's, Marek's and Chen's: two sends waiting offline showed as two identical boxes, and Cancel said nothing.
  const LUCAS = "lucas-account-26JfWKvhYdVY71bdSPVLNJ51Buy4GjimCT7zcsoxNQtydDbdoH2AwZaH8W7rjcAc9riAu39Vw9Lx1w7yrkBgotSjWmUdk";
  const at = (h, m) => new Date(2026, 10, 13, h, m).getTime();
  const send = (over = {}) => ({ sendId: "s1", walletId: "w", nodeUrl: "https://testnet.nodes.dusk.network", profileIndex: 0, privacy: "public", to: LUCAS, lux: "10000000", feeLux: "2500000", memo: "Hors ligne un", at: at(2, 34), waiting: true, waits: true, ...over });
  const ov = (waitingSends, over = {}) => ({
    isUnlocked: true,
    nodeUrl: "https://testnet.nodes.dusk.network",
    accounts: ["mine"],
    selectedAccountIndex: 0,
    balance: { value: "900000000" },
    shieldedBalance: { value: "0", spendable: "0" },
    waitingSends,
    ...over,
  });
  const boxes = (document) => document.body.querySelectorAll(".home-waiting").map((el) => visibleText(el));

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("says what each pays, to whom, its memo and when it was made, to tell them apart, with Cancel", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(2, 40));
    const { document } = installFakeDom();
    const state = { route: "home", addressBook: { loaded: true, items: [{ address: LUCAS, name: "Lucas (petit-fils)" }] } };
    const sent = [];
    const actions = {
      render: vi.fn(async () => {}),
      showToast: vi.fn(),
      send: vi.fn(async (message) => {
        sent.push(message);
        return { ok: true, result: { cancelled: true } };
      }),
    };
    document.body.replaceChildren(...homeView(ov([send(), send({ sendId: "s2", memo: "Hors ligne deux", at: at(2, 36), waits: false })]), { state, actions }));
    expect(boxes(document)).toEqual([
      "Not sent yet: 0.01 DUSK to Lucas (petit-fils)“Hors ligne un” · made at 02:34It goes out once the network answers.Cancel",
      "Not sent yet: 0.01 DUSK to Lucas (petit-fils)“Hors ligne deux” · made at 02:36It's being sent.Cancel",
    ]);

    // Cancel on the second: that one alone, and said.
    document.body.querySelectorAll(".home-waiting button")[1].click();
    await vi.waitFor(() => expect(actions.showToast).toHaveBeenCalled());
    expect(sent).toEqual([{ type: "DUSK_UI_CANCEL_SEND", sendId: "s2" }]);
    expect(actions.showToast).toHaveBeenCalledWith({ text: "Not sent: 0.01 DUSK to Lucas (petit-fils). Nothing was sent and no fee was charged.", tone: "ok" });
    expect(actions.render).toHaveBeenCalledWith({ forceRefresh: true });

    // Hidden balances hide what it pays; another profile's aren't this one's to list.
    document.body.replaceChildren(...homeView(ov([send()], { hideBalances: true }), { state, actions }));
    expect(boxes(document)[0]).toMatch(/^Not sent yet: •••• DUSK to Lucas/);
    document.body.replaceChildren(...homeView(ov([send({ profileIndex: 1 })]), { state, actions }));
    expect(boxes(document)).toEqual([]);
  });

  // Chen's: one handed over as the Wi-Fi died showed as sent in Activity, though the node never had it.
  it("says one handed over without a clear answer may have gone out, with no Cancel, until the node's asked", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(2, 40));
    const { document } = installFakeDom();
    const state = { route: "home", addressBook: { loaded: true, items: [{ address: LUCAS, name: "Lucas (petit-fils)" }] } };
    const actions = { render: vi.fn(async () => {}), showToast: vi.fn(), send: vi.fn(async () => ({ ok: true })) };
    const waits = send({ unclear: true });
    const checks = send({ sendId: "s2", memo: "Hors ligne deux", at: at(2, 36), waits: false, unclear: true, checks: true });
    const going = send({ sendId: "s3", memo: "Trois", at: at(2, 38), waits: false, unclear: true });
    document.body.replaceChildren(...homeView(ov([waits, checks, going]), { state, actions }));
    expect(boxes(document)).toEqual([
      "Not confirmed: 0.01 DUSK to Lucas (petit-fils)“Hors ligne un” · made at 02:34It may have gone out already. If it didn't, it goes out once the network answers.",
      "Not confirmed: 0.01 DUSK to Lucas (petit-fils)“Hors ligne deux” · made at 02:36It may have gone out already. The wallet checks once the network answers.",
      "Not confirmed: 0.01 DUSK to Lucas (petit-fils)“Trois” · made at 02:38It's being sent.",
    ]);
    expect(document.body.querySelectorAll(".home-waiting button")).toEqual([]);
  });

  it("says plainly one the wallet stopped waiting for wasn't sent, never sends it by itself, and offers Send it now through Review, or Drop", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(9, 0));
    const { document } = installFakeDom();
    const state = { route: "home", addressBook: { loaded: true, items: [] } };
    const actions = { render: vi.fn(async () => {}), showToast: vi.fn(), send: vi.fn(async () => ({ ok: true, result: { dropped: true } })) };
    const closed = send({ waiting: false, waits: false, ended: "closed" });
    const failed = send({ sendId: "s2", memo: "", waiting: false, waits: false, ended: "failed", error: "Failed to fetch" });
    document.body.replaceChildren(...homeView(ov([closed, failed]), { state, actions }));
    expect(boxes(document)).toEqual([
      "Not sent: 0.01 DUSK to lucas-…jWmUdk“Hors ligne un” · made at 02:34The wallet closed before the network answered, so nothing was sent.Send it nowDrop",
      "Not sent: 0.01 DUSK to lucas-…jWmUdkmade at 02:34Couldn't reach the network. Nothing was sent and no fee was charged.Send it nowDrop",
    ]);

    // Send it now: Send, filled in, for Review; the one said goes.
    document.body.querySelectorAll(".home-waiting button").find((b) => b.textContent === "Send it now").click();
    await vi.waitFor(() => expect(state.route).toBe("send"));
    expect(actions.send).toHaveBeenCalledWith({ type: "DUSK_UI_DROP_UNSENT", sendId: "s1" });
    expect(state.draft).toMatchObject({ to: LUCAS, amountDusk: "0.01", memo: "Hors ligne un" });

    // Drop: gone, Home drawn again.
    document.body.querySelectorAll(".home-waiting button").filter((b) => b.textContent === "Drop")[1].click();
    await vi.waitFor(() => expect(actions.send).toHaveBeenCalledWith({ type: "DUSK_UI_DROP_UNSENT", sendId: "s2" }));
  });
});
