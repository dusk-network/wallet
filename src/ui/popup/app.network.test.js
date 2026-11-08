import { afterEach, describe, expect, it, vi } from "vitest";

import { installFakeDom, settle } from "../testing/fakeDom.js";

vi.mock("../../wallet/bus.js", () => ({ send: vi.fn() }));
vi.mock("../../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: vi.fn(async () => null),
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
