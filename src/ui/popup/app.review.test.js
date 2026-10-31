import { afterEach, describe, expect, it, vi } from "vitest";

import { accessibleName, fakeEvent, installFakeDom, settle } from "../testing/fakeDom.js";

vi.mock("../../wallet/bus.js", () => ({ send: vi.fn() }));
// Deposits' arrivals, read as the popup draws: held for wallet B, to stop a
// redraw where the overview names B and the DOM is still A's.
const arrivals = vi.hoisted(() => ({ gate: null, heldFor: "" }));
vi.mock("../../shared/bridgeArrival.js", async (importOriginal) => ({
  ...(await importOriginal()),
  loadArrivals: vi.fn(async (walletId) => {
    if (arrivals.gate && walletId === arrivals.heldFor) await arrivals.gate.promise;
  }),
}));

const A =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const B =
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const TO =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck929";
const wallet = (account, key) => ({
  hasVault: true,
  isUnlocked: true,
  networkName: "Testnet",
  nodeUrl: "https://testnet.nodes.dusk.network",
  accounts: [account],
  accountCount: 1,
  selectedAccountIndex: 0,
  balance: { value: "1500000000000" },
  shieldedBalance: { value: "0", spendable: "0" },
  txs: [],
  walletKey: key,
  wallets: [
    { key: "wa", n: 1, name: "", walletId: A, accounts: [A], accountNames: {}, active: key === "wa" },
    { key: "wb", n: 2, name: "", walletId: B, accounts: [B], accountNames: {}, active: key === "wb" },
  ],
});

afterEach(() => {
  vi.unstubAllGlobals();
  arrivals.gate = null;
});

const flush = async () => {
  for (let i = 0; i < 8; i++) await settle();
};

// The popup on `route` with wallet A open; `t.open` is what the wallet's
// overview says, `t.deliver` the wallet's own messages to the popup.
async function popupOn(route, extra = {}) {
  const dom = installFakeDom({ pathname: "/popup.html" });
  dom.document.body.innerHTML = "";
  const header = dom.document.createElement("div");
  header.id = "header-actions";
  const app = dom.document.createElement("div");
  app.id = "app";
  dom.document.body.append(header, app);
  let onMessage = null;
  vi.stubGlobal("browser", {
    runtime: { id: "dusk-wallet", sendMessage: () => {}, onMessage: { addListener: (fn) => (onMessage = fn) } },
  });
  vi.resetModules();
  const { send } = await import("../../wallet/bus.js");
  const t = { dom, app, send, open: wallet(A, "wa") };
  send.mockReset();
  send.mockImplementation(async (message) => {
    if (message.type === "DUSK_UI_OVERVIEW") return t.open;
    if (message.type === "DUSK_UI_GET_CACHED_GAS_PRICE") return { ok: true, result: { min: "1", median: "1", max: "1" } };
    if (message.type === "DUSK_UI_SEND_TX") return { ok: true, result: { hash: "ab".repeat(32) } };
    return { ok: true, result: null };
  });
  const { state } = await import("./state.js");
  Object.assign(state, { route, ...extra });
  const { render } = await import("./app.js");
  await render();
  await flush();
  return Object.assign(t, { state, render, deliver: (message) => onMessage(message), asked: (type) => send.mock.calls.map(([m]) => m).filter((m) => m.type === type) });
}

describe("a Review drawn for wallet A, with wallet B opened in another window", () => {
  it("sends nothing from the old Confirm pressed while the popup reads B but still shows A", async () => {
    const t = await popupOn("confirm", {
      addressBook: { loaded: true, items: [] },
      draft: { to: TO, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" },
    });
    const { app, send, state } = t;
    const confirm = app.querySelectorAll("button").find((b) => b.textContent === "Confirm");
    expect(confirm).toBeTruthy();

    // Wallet B opens in another window. The popup reads its overview, then
    // waits on B's arrivals before drawing: A's Review is still the screen.
    t.open = wallet(B, "wb");
    arrivals.gate = Promise.withResolvers();
    arrivals.heldFor = B;
    t.deliver({ type: "DUSK_UI_WALLET_CHANGED" });
    await flush();
    expect(state.overview.accounts[0]).toBe(B);
    expect(app.contains(confirm)).toBe(true);

    confirm.click();
    await flush();
    arrivals.gate.resolve();
    await flush();

    expect(send.mock.calls.map(([m]) => m).filter((m) => m.type === "DUSK_UI_SEND_TX")).toEqual([]);
    expect([state.route, state.sent?.phase, state.sent?.error]).toEqual(["sent", "not_sent", "The network, profile or wallet changed meanwhile."]);
  });
});

describe("a screen's own actions, after another wallet opened", () => {
  it("name the wallet the screen was drawn for, so the wallet refuses them for another", async () => {
    const t = await popupOn("options");
    const select = t.app.querySelectorAll("select").find((el) => accessibleName(el) === "Active profile");
    expect(select).toBeTruthy();
    select.value = "0";
    select.dispatchEvent(fakeEvent("change"));
    await flush();
    expect(t.asked("DUSK_UI_SET_ACCOUNT_INDEX")).toEqual([expect.objectContaining({ index: 0, walletId: A })]);
  });

  it("closes the profile menu that lists the wallet before", async () => {
    const t = await popupOn("home");
    t.dom.document.body.querySelector("#header-actions .account-chip").click();
    await flush();
    expect(t.dom.document.body.querySelector(".acct-menu")).toBeTruthy();
    t.open = wallet(B, "wb");
    t.deliver({ type: "DUSK_UI_WALLET_CHANGED" });
    await flush();
    expect(t.dom.document.body.querySelector(".acct-menu")).toBeNull();
  });
});
