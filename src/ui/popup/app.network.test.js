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
