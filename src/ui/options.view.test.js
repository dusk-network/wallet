import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installFakeDom, isShown, visibleText } from "./testing/fakeDom.js";

vi.mock("../shared/accountNames.js", () => ({ setAccountName: vi.fn(async () => {}) }));

const ACCOUNTS = [
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927",
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz",
];

let dom;

beforeEach(() => {
  dom = installFakeDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Settings as the extension draws it, where dApps connect.
async function settings(over = {}) {
  vi.stubGlobal("browser", {
    runtime: { id: "dusk-wallet", sendMessage: () => {}, getManifest: () => ({ version: "0.3.0" }) },
  });
  vi.resetModules();
  const { optionsView } = await import("./popup/views/options.js");
  const ov = {
    isUnlocked: true,
    accounts: ACCOUNTS,
    accountCount: 2,
    selectedAccountIndex: 0,
    nodeUrl: "https://testnet.nodes.dusk.network",
    permissions: [],
    ...over,
  };
  const actions = { send: vi.fn(async () => ({})), render: vi.fn(async () => {}), showToast: vi.fn() };
  dom.document.body.replaceChildren(...optionsView(ov, { state: { route: "options" }, actions }));
  const section = (title) =>
    dom.document.body
      .querySelectorAll(".settings-section")
      .find((s) => s.querySelector(".bracket-title__text").textContent === title);
  const shownButtons = (el) => el.querySelectorAll("button").filter(isShown).map((b) => b.textContent);
  return { section, shownButtons };
}

describe("settings", () => {
  it("lets the section title name the network, and shows a preset's hint only where it adds to the name", async () => {
    let view = await settings();
    const network = view.section("Network");
    expect(network.querySelectorAll("label").map((l) => l.textContent)).toEqual(["Node URL", "Prover URL", "Archiver URL"]);
    expect(network.querySelector("select#network").getAttribute("aria-label")).toBe("Network");
    // Testnet says it all.
    expect(network.querySelectorAll(".muted").filter(isShown)).toEqual([]);

    view = await settings({ nodeUrl: "https://devnet.nodes.dusk.network" });
    expect(view.section("Network").querySelectorAll(".muted").filter(isShown).map((el) => el.textContent)).toEqual([
      "Experimental",
    ]);
  });

  it("names each profile once, above its name field", async () => {
    const view = await settings();
    const inputs = view.section("Profile").querySelectorAll("input");
    expect(inputs.map((i) => [i.getAttribute("aria-label"), i.getAttribute("placeholder")])).toEqual([
      ["Profile 1 name", "Label, only on this device"],
      ["Profile 2 name", "Label, only on this device"],
    ]);
  });

  it("lists connected sites above Clear connected sites, which shows only with sites", async () => {
    let view = await settings();
    let data = view.section("Data");
    expect(visibleText(data)).toContain("ContactsManage");
    expect(visibleText(data)).toContain("Connected sitesNone");
    expect(view.shownButtons(data)).toEqual(["Manage", "Reset wallet"]);

    view = await settings({ permissions: [{ origin: "https://app.example", accountIndex: 1 }] });
    data = view.section("Data");
    expect(visibleText(data)).toContain("Connected siteshttps://app.example");
    expect(data.querySelector('select[aria-label="Profile for https://app.example"]').value).toBe("1");
    expect(view.shownButtons(data)).toEqual(["Manage", "Clear connected sites", "Reset wallet"]);
  });
});
