import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";

import fixture from "../../shared/fixtures/activity-testnet.json";
import { fakeArchive } from "../../shared/fixtures/fakeArchive.js";
import { installFakeDom, isShown, settle, visibleText } from "../testing/fakeDom.js";

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
    expect(label.textContent).toBe("Testnet");
    // What the wallet said, passed on.
    expect(dom.document.body.querySelector(".toast")?.textContent).toContain("Couldn't reach the node");
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
    // The line under the network's name while the node can't be reached (header.js), and its dot.
    const words = () => {
      const el = dom.document.querySelector(".network-word");
      return el && !el.hidden ? el.textContent : "";
    };
    const offline = () => (pill.querySelector(".net-status-dot")?.className ?? "").includes("net-status--offline");
    // The balance shown, and what's said of it under it (home.js balance-stale): that it may be out of date, never
    // that it's current; "" where nothing is said.
    const balance = () => app.querySelector(".balance-amount").textContent;
    // The note as the screen shows it: "" while it's hidden or not there.
    const note = () => {
      const el = app.querySelector(".balance-stale");
      return el && isShown(el) ? visibleText(el) : "";
    };
    const maybeOutOfDate = () => {
      expect(note()).toMatch(/may be out of date/i);
      expect(note()).not.toMatch(/\bcurrent\b|up to date/i);
    };
    try {
      const { render } = await import("./app.js");
      await render();
      await settle();
      expect([balance(), note()]).toEqual(["1.0477 DUSK", ""]);

      // The node goes silent, and holds the balance's reads: said, of the network, not of the browser, and the
      // balance read last kept, said to be maybe out of date.
      silent = true;
      holding = true;
      vi.advanceTimersByTime(15_000);
      await vi.waitFor(() => expect(words()).toMatch(/network/i));
      expect([offline(), balance()]).toEqual([true, "1.0477 DUSK"]);
      maybeOutOfDate();

      // It answers its check again, the balance's read still held: back at once, the balance still maybe out of date.
      silent = false;
      const before = reads();
      vi.advanceTimersByTime(15_000);
      await vi.waitFor(() => expect(reads()).toBeGreaterThan(before));
      await settle();
      expect([words(), offline(), balance()]).toEqual(["", false, "1.0477 DUSK"]);
      maybeOutOfDate();

      // A balance read since: shown, and no longer said to be out of date.
      holding = false;
      for (const resolve of held.splice(0)) resolve(read("2000000000"));
      await vi.waitFor(() => expect(balance()).toBe("2 DUSK"));
      expect(note()).toBe("");
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
    // Activity's rows on Home, each by its amount with its sign ("+0.01 DUSK"), "" for one without.
    const amounts = () => app.querySelectorAll(".tx-row").map((row) => row.querySelector(".tx-amount")?.textContent ?? "");
    const balance = () => app.querySelector(".balance-amount").textContent;
    return { amounts, app, archive, balance, chain, paid, render, send, state };
  }

  afterEach(() => vi.doUnmock("./views/requests.js"));

  it("shows by itself, in the balance and in Activity alike, without a Refresh", async () => {
    // Sofía's: a client paid 0.01 while the app showed Home; for almost three minutes neither the balance nor
    // Activity moved, nothing said so, and Refresh brought the balance but not the payment.
    const view = await home(40);
    try {
      await view.render();
      await vi.waitFor(() => expect(view.amounts()).toHaveLength(4), { timeout: 3_000 });
      expect(view.balance()).toBe("1.0477 DUSK");
      expect(view.amounts()).not.toContain("+0.01 DUSK");

      view.paid(10_000_000n, "c1".repeat(32));

      // Nothing pressed: the balance and Activity both have it, as money that came in.
      await vi.waitFor(() => expect(view.balance()).toBe("1.0577 DUSK"), { timeout: 3_000 });
      await vi.waitFor(() => expect(view.amounts()).toHaveLength(5), { timeout: 3_000 });
      expect(view.amounts().filter((amount) => amount === "+0.01 DUSK")).toHaveLength(1);
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
      await vi.waitFor(() => expect(view.amounts()).toHaveLength(4), { timeout: 3_000 });
      expect(view.amounts()).not.toContain("+0.03 DUSK");

      view.paid(30_000_000n, "c2".repeat(32));
      view.app.querySelector("button.balance-refresh").click();

      await vi.waitFor(() => expect(view.balance()).toBe("1.0777 DUSK"), { timeout: 3_000 });
      await vi.waitFor(() => expect(view.amounts()).toHaveLength(5), { timeout: 3_000 });
      expect(view.amounts().filter((amount) => amount === "+0.03 DUSK")).toHaveLength(1);
    } finally {
      view.state.route = "options";
    }
  });
});
