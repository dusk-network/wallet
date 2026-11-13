import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";

import fixture from "../../shared/fixtures/activity-testnet.json";
import { fakeArchive } from "../../shared/fixtures/fakeArchive.js";
import { installFakeDom, settle } from "../testing/fakeDom.js";

vi.mock("../../wallet/bus.js", () => ({ send: vi.fn() }));
vi.mock("../../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: vi.fn(async () => null),
  lookupRecipientNames: vi.fn(async () => new Map()),
}));

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("switching network from the header", () => {
  it("names the network it's still on when the switch fails", async () => {
    const dom = installFakeDom({ pathname: "/popup.html" });
    dom.document.body.innerHTML = "";
    const pill = dom.document.createElement("button");
    pill.id = "network-pill";
    pill.className = "network-pill";
    const label = dom.document.createElement("span");
    label.className = "network-pill__label";
    pill.appendChild(label);
    const actions = dom.document.createElement("div");
    actions.id = "header-actions";
    const app = dom.document.createElement("div");
    app.id = "app";
    dom.document.body.append(pill, actions, app);

    vi.resetModules();
    const { send } = await import("../../wallet/bus.js");
    send.mockImplementation(async (message) => {
      if (message.type === "DUSK_UI_OVERVIEW")
        return {
          hasVault: true,
          isUnlocked: true,
          networkName: "Testnet",
          nodeUrl: "https://testnet.nodes.dusk.network",
          accounts: [ACCOUNT],
          selectedAccountIndex: 0,
          balance: { value: "0" },
        };
      if (message.type === "DUSK_UI_SET_NODE_URL") return { error: { message: "Couldn't reach the node" } };
      return {};
    });
    const { render } = await import("./app.js");
    await render();
    await settle();
    expect(label.textContent).toBe("Testnet");

    pill.click();
    const item = dom.document.body
      .querySelectorAll(".net-menu [role=menuitemradio]")
      .find((el) => el.querySelector(".net-menu-item-label").textContent === "Mainnet");
    item.click();
    await settle();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "DUSK_UI_SET_NODE_URL" }));
    expect([label.textContent, pill.classList.contains("is-switching")]).toEqual(["Testnet", false]);
    expect(dom.document.body.querySelector(".toast")?.textContent).toBe("Couldn't reach the node");
  });
});

describe("a connection that drops and comes back", () => {
  it("says it's offline at once, keeps the balance read last as maybe out of date, and reads again by itself once back", async () => {
    // Amélie's: the dot stayed green offline, Refresh left a dash and Unavailable, and they stayed once the connection was back.
    const dom = installFakeDom({ pathname: "/popup.html" });
    dom.document.body.innerHTML = "";
    const pill = dom.document.createElement("button");
    pill.id = "network-pill";
    pill.className = "network-pill";
    const label = dom.document.createElement("span");
    label.className = "network-pill__label";
    pill.appendChild(label);
    const actions = dom.document.createElement("div");
    actions.id = "header-actions";
    const app = dom.document.createElement("div");
    app.id = "app";
    dom.document.body.append(pill, actions, app);

    let online = true;
    vi.stubGlobal("navigator", { ...globalThis.navigator, language: "en-US", get onLine() { return online; } });
    vi.resetModules();
    const { send } = await import("../../wallet/bus.js");
    const overview = { hasVault: true, isUnlocked: true, networkName: "Testnet", nodeUrl: "https://testnet.nodes.dusk.network", accounts: [ACCOUNT], selectedAccountIndex: 0, txs: [] };
    send.mockReset();
    send.mockImplementation(async (message) => {
      if (message.type !== "DUSK_UI_OVERVIEW") return {};
      return online
        ? { ...overview, balance: { value: "1047700000" }, shieldedBalance: { value: "0", spendable: "0" }, shieldedSync: { state: "done", notes: 1 } }
        : { ...overview, balance: null, balanceError: "Failed to fetch", shieldedError: "Failed to fetch", shieldedSync: { state: "done", notes: 1 } };
    });
    const reads = () => send.mock.calls.filter(([m]) => m.type === "DUSK_UI_OVERVIEW").length;
    const text = () => app.textContent;
    const dot = () => pill.querySelector(".net-status-dot")?.className ?? "";
    const { render } = await import("./app.js");
    await render();
    await settle();
    expect(app.querySelector(".balance-amount").textContent).toBe("1.0477 DUSK");
    expect(dot()).not.toContain("net-status--offline");

    // Offline: said at once, before anything fails, the balance as it was.
    online = false;
    dom.window.dispatchEvent(new Event("offline"));
    await settle();
    expect(dot()).toContain("net-status--offline");
    expect(text()).toContain("Your balance may be out of date until you're back online.");
    expect(app.querySelector(".balance-amount").textContent).toBe("1.0477 DUSK");

    // Refresh can't read it now: what was read last stays, never a dash or Unavailable.
    app.querySelector("button.balance-refresh").click();
    await vi.waitFor(() => expect(reads()).toBe(2));
    await settle();
    expect(app.querySelector(".balance-amount").textContent).toBe("1.0477 DUSK");
    expect(text()).not.toContain("Unavailable");
    expect(text()).not.toContain("Couldn't read your balance");
    expect(text()).toContain("Your balance may be out of date until you're back online.");

    // Back online: read again at once, by itself, and the node checked again.
    online = true;
    dom.window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(reads()).toBeGreaterThanOrEqual(3));
    await settle();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "DUSK_UI_CHECK_NETWORK" }));
    expect(text()).not.toContain("may be out of date");
    expect(dot()).not.toContain("net-status--offline");
    expect(app.querySelector(".balance-amount").textContent).toBe("1.0477 DUSK");
  });
});

describe("a node that stops answering", () => {
  it("says it can't reach the network while the wallet shows, without waiting on a read that hangs, and reads again once it answers", async () => {
    // Lena's and Amélie's: a node that held every request open left the dot green and Home silent for 45 s.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const dom = installFakeDom({ pathname: "/popup.html" });
    dom.document.body.innerHTML = "";
    const pill = dom.document.createElement("button");
    pill.id = "network-pill";
    pill.className = "network-pill";
    const label = dom.document.createElement("span");
    label.className = "network-pill__label";
    pill.appendChild(label);
    const actions = dom.document.createElement("div");
    actions.id = "header-actions";
    const app = dom.document.createElement("div");
    app.id = "app";
    dom.document.body.append(pill, actions, app);

    vi.stubGlobal("navigator", { ...globalThis.navigator, language: "en-US", onLine: true });
    vi.resetModules();
    const { send } = await import("../../wallet/bus.js");
    const NODE = "https://testnet.nodes.dusk.network";
    let silent = false;
    const overview = { hasVault: true, isUnlocked: true, networkName: "Testnet", nodeUrl: NODE, accounts: [ACCOUNT], selectedAccountIndex: 0, txs: [], shieldedSync: { state: "done", notes: 1 } };
    send.mockReset();
    send.mockImplementation(async (message) => {
      if (message.type === "DUSK_UI_OVERVIEW") {
        // A node that holds what it's asked: the read never ends.
        if (silent) return new Promise(() => {});
        return { ...overview, balance: { value: "1047700000" }, shieldedBalance: { value: "0", spendable: "0" }, networkStatus: { nodeStatus: "online", nodeUrl: NODE } };
      }
      // What the wallet's ask of the node found, its time running out while it's silent.
      if (message.type === "DUSK_UI_CHECK_NODE") return { ok: true, networkStatus: { nodeStatus: silent ? "offline" : "online", nodeError: silent ? "signal is aborted without reason" : null, nodeUrl: NODE } };
      return {};
    });
    const asks = () => send.mock.calls.filter(([m]) => m.type === "DUSK_UI_CHECK_NODE").length;
    const reads = () => send.mock.calls.filter(([m]) => m.type === "DUSK_UI_OVERVIEW").length;
    const words = () => {
      const el = dom.document.querySelector(".network-word");
      return el && !el.hidden ? el.textContent : "";
    };
    const dot = () => pill.querySelector(".net-status-dot")?.className ?? "";
    try {
      const { render } = await import("./app.js");
      await render();
      // Asked as it shows: it answers.
      await vi.waitFor(() => expect(asks()).toBe(1));
      await settle();
      expect([words(), app.textContent.includes("may be out of date")]).toEqual(["", false]);

      // The node goes silent: asked again a little on, it's said at once, the balance read last kept.
      silent = true;
      vi.advanceTimersByTime(15_000);
      await vi.waitFor(() => expect(words()).toBe("Can't reach the network"));
      expect(dot()).toContain("net-status--offline");
      expect(app.textContent).toContain("Your balance may be out of date.");
      expect(app.querySelector(".balance-amount").textContent).toBe("1.0477 DUSK");

      // It answers again: the words go and the balance is read again, by itself.
      silent = false;
      const before = reads();
      vi.advanceTimersByTime(15_000);
      await vi.waitFor(() => expect(reads()).toBeGreaterThan(before));
      await vi.waitFor(() => expect(words()).toBe(""));
      expect(dot()).not.toContain("net-status--offline");
      expect(app.textContent).not.toContain("may be out of date");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a node that stops answering while a Refresh waits on it", () => {
  it("says so from what was read already, without the read that hangs, and keeps asking", async () => {
    // Astra's: Refresh pressed as the node went silent left the heartbeat waiting on another read, the warning unsaid
    // and no more asks.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const dom = installFakeDom({ pathname: "/popup.html" });
    dom.document.body.innerHTML = "";
    const pill = dom.document.createElement("button");
    pill.id = "network-pill";
    pill.className = "network-pill";
    const label = dom.document.createElement("span");
    label.className = "network-pill__label";
    pill.appendChild(label);
    const actions = dom.document.createElement("div");
    actions.id = "header-actions";
    const app = dom.document.createElement("div");
    app.id = "app";
    dom.document.body.append(pill, actions, app);

    vi.stubGlobal("navigator", { ...globalThis.navigator, language: "en-US", onLine: true });
    vi.resetModules();
    const { send } = await import("../../wallet/bus.js");
    const NODE = "https://testnet.nodes.dusk.network";
    let silent = false;
    const overview = { hasVault: true, isUnlocked: true, networkName: "Testnet", nodeUrl: NODE, accounts: [ACCOUNT], selectedAccountIndex: 0, txs: [], shieldedSync: { state: "done", notes: 1 } };
    send.mockReset();
    send.mockImplementation(async (message) => {
      if (message.type === "DUSK_UI_OVERVIEW") {
        if (silent) return new Promise(() => {});
        return { ...overview, balance: { value: "1047700000" }, shieldedBalance: { value: "0", spendable: "0" }, networkStatus: { nodeStatus: "online", nodeUrl: NODE } };
      }
      if (message.type === "DUSK_UI_CHECK_NODE") return { ok: true, networkStatus: { nodeStatus: silent ? "offline" : "online", nodeUrl: NODE } };
      return {};
    });
    const asks = () => send.mock.calls.filter(([m]) => m.type === "DUSK_UI_CHECK_NODE").length;
    const words = () => {
      const el = dom.document.querySelector(".network-word");
      return el && !el.hidden ? el.textContent : "";
    };
    try {
      const { render } = await import("./app.js");
      await render();
      await vi.waitFor(() => expect(asks()).toBe(1));
      await settle();

      // The node goes silent as Refresh is pressed: that read never ends.
      silent = true;
      app.querySelector("button.balance-refresh").click();
      await settle();
      vi.advanceTimersByTime(15_000);
      await vi.waitFor(() => expect(words()).toBe("Can't reach the network"));
      expect(app.textContent).toContain("Your balance may be out of date.");
      expect(app.querySelector(".balance-amount").textContent).toBe("1.0477 DUSK");

      // Asked again a little on, the read still waiting.
      vi.advanceTimersByTime(15_000);
      await vi.waitFor(() => expect(asks()).toBe(3));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a node that answers again before the balance does", () => {
  it("says it's back at once, and that the balance may be out of date till one is read", async () => {
    // Astra's: back online, the balance read before the node went silent showed as current while its read still hung.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const dom = installFakeDom({ pathname: "/popup.html" });
    dom.document.body.innerHTML = "";
    const pill = dom.document.createElement("button");
    pill.id = "network-pill";
    pill.className = "network-pill";
    const label = dom.document.createElement("span");
    label.className = "network-pill__label";
    pill.appendChild(label);
    const actions = dom.document.createElement("div");
    actions.id = "header-actions";
    const app = dom.document.createElement("div");
    app.id = "app";
    dom.document.body.append(pill, actions, app);

    vi.stubGlobal("navigator", { ...globalThis.navigator, language: "en-US", onLine: true });
    vi.resetModules();
    const { send } = await import("../../wallet/bus.js");
    const NODE = "https://testnet.nodes.dusk.network";
    // `silent`: the node doesn't answer its check; `held`: the balance reads waiting on it.
    let silent = false;
    let holding = false;
    const held = [];
    const overview = { hasVault: true, isUnlocked: true, networkName: "Testnet", nodeUrl: NODE, accounts: [ACCOUNT], selectedAccountIndex: 0, txs: [], shieldedSync: { state: "done", notes: 1 } };
    const read = (lux) => ({ ...overview, balance: { value: lux }, shieldedBalance: { value: "0", spendable: "0" }, networkStatus: { nodeStatus: "online", nodeUrl: NODE } });
    send.mockReset();
    send.mockImplementation(async (message) => {
      if (message.type === "DUSK_UI_OVERVIEW") return holding ? new Promise((resolve) => held.push(resolve)) : read("1047700000");
      if (message.type === "DUSK_UI_CHECK_NODE") return { ok: true, networkStatus: { nodeStatus: silent ? "offline" : "online", nodeUrl: NODE } };
      return {};
    });
    const reads = () => send.mock.calls.filter(([m]) => m.type === "DUSK_UI_OVERVIEW").length;
    const words = () => {
      const el = dom.document.querySelector(".network-word");
      return el && !el.hidden ? el.textContent : "";
    };
    const dot = () => pill.querySelector(".net-status-dot")?.className ?? "";
    try {
      const { render } = await import("./app.js");
      await render();
      await settle();
      expect(app.textContent).not.toContain("may be out of date");

      // The node goes silent, and holds the balance's reads.
      silent = true;
      holding = true;
      vi.advanceTimersByTime(15_000);
      await vi.waitFor(() => expect(words()).toBe("Can't reach the network"));
      expect(app.textContent).toContain("Your balance may be out of date.");

      // It answers its check again, the balance's read still held: back at once, the balance still maybe out of date.
      silent = false;
      const before = reads();
      vi.advanceTimersByTime(15_000);
      await vi.waitFor(() => expect(reads()).toBeGreaterThan(before));
      await settle();
      expect(words()).toBe("");
      expect(dot()).not.toContain("net-status--offline");
      expect(app.textContent).toContain("Your balance may be out of date.");
      expect(app.querySelector(".balance-amount").textContent).toBe("1.0477 DUSK");

      // A balance read since: shown, and no longer said to be out of date.
      holding = false;
      for (const resolve of held.splice(0)) resolve(read("2000000000"));
      await vi.waitFor(() => expect(app.querySelector(".balance-amount").textContent).toBe("2 DUSK"));
      expect(app.textContent).not.toContain("may be out of date");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("money coming in while the wallet shows", () => {
  // The page with the wallet's Home, its history kept on this device, the
  // archive answering from the recorded Testnet history, and the history and
  // balance read again every `every` milliseconds while the wallet shows.
  async function home(every) {
    const dom = installFakeDom({ pathname: "/popup.html" });
    dom.document.body.innerHTML = "";
    for (const [tag, id, className] of [["button", "network-pill", "network-pill"], ["div", "header-actions", ""], ["div", "app", ""]]) {
      const el = dom.document.createElement(tag);
      el.id = id;
      if (className) el.className = className;
      dom.document.body.appendChild(el);
    }
    vi.stubGlobal("navigator", { ...globalThis.navigator, language: "en-US", onLine: true });
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    const [account] = Object.keys(fixture.accounts);
    const accounts = structuredClone(fixture.accounts);
    const archive = fakeArchive({ accounts });
    vi.resetModules();
    vi.doMock("./views/requests.js", async (importOriginal) => ({ ...(await importOriginal()), LOOK_MS: every }));
    const { send } = await import("../../wallet/bus.js");
    const chain = { lux: 1_047_700_000n };
    send.mockReset();
    send.mockImplementation(async (message) =>
      message.type === "DUSK_UI_OVERVIEW"
        ? {
            hasVault: true,
            isUnlocked: true,
            networkName: "Testnet",
            nodeUrl: fixture.nodeUrl,
            accounts: [account],
            selectedAccountIndex: 0,
            txs: [],
            balance: { value: String(chain.lux) },
            shieldedBalance: { value: "0", spendable: "0" },
            shieldedSync: { state: "done", notes: 1 },
          }
        : {}
    );
    const { state } = await import("./state.js");
    const { render } = await import("./app.js");
    const app = dom.document.getElementById("app");
    // A payment of `lux` from someone else, in the block after the last final one, final now.
    const paid = (lux, origin) => {
      const block = archive.finalized + 1;
      accounts[account].receiver.push({
        block_height: block,
        origin,
        events: [{ target: fixture.accounts[account].receiver[0].events[0].target, topic: "moonlight", reverted: false, data: { sender: fixture.accounts[account].receiver[0].events[0].data.sender, receiver: account, value: String(lux), memo: "", refund_info: null } }],
      });
      archive.finalized = block;
      chain.lux += lux;
    };
    const rows = () => app.querySelectorAll(".tx-row").map((row) => row.textContent);
    return { app, archive, chain, paid, render, rows, send, state };
  }

  afterEach(() => vi.doUnmock("./views/requests.js"));

  it("shows by itself, in the balance and in Activity alike, without a Refresh", async () => {
    // Sofía's: a client paid 0.01 while the app showed Home; for almost three minutes neither the balance nor
    // Activity moved, nothing said so, and Refresh brought the balance but not the payment.
    const view = await home(40);
    try {
      await view.render();
      await vi.waitFor(() => expect(view.rows()).toHaveLength(4), { timeout: 3_000 });
      expect(view.app.querySelector(".balance-amount").textContent).toBe("1.0477 DUSK");

      view.paid(10_000_000n, "c1".repeat(32));

      // Nothing pressed: the balance and Activity both have it.
      await vi.waitFor(() => expect(view.app.querySelector(".balance-amount").textContent).toBe("1.0577 DUSK"), { timeout: 3_000 });
      await vi.waitFor(() => expect(view.rows()).toHaveLength(5), { timeout: 3_000 });
      expect(view.rows()[0]).toContain("+0.01");
    } finally {
      // Off Home, as a popup closed: nothing more is read.
      view.state.route = "options";
    }
  });

  it("has Refresh read the history along with the balance", async () => {
    // Sofía's: Refresh made the balance right; the payment came into Activity only minutes later, after another send.
    const view = await home(60 * 60_000);
    try {
      await view.render();
      await vi.waitFor(() => expect(view.rows()).toHaveLength(4), { timeout: 3_000 });

      view.paid(30_000_000n, "c2".repeat(32));
      view.app.querySelector("button.balance-refresh").click();

      await vi.waitFor(() => expect(view.app.querySelector(".balance-amount").textContent).toBe("1.0777 DUSK"), { timeout: 3_000 });
      await vi.waitFor(() => expect(view.rows()).toHaveLength(5), { timeout: 3_000 });
      expect(view.rows()[0]).toContain("+0.03");
    } finally {
      view.state.route = "options";
    }
  });
});
