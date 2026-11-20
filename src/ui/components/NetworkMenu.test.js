import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installFakeDom, settle } from "../testing/fakeDom.js";
import { createNetworkMenuController } from "./NetworkMenu.js";

let dom;
let pill;
let menu;
let onSelectPreset;

// The header's pill, as popup.html has it.
beforeEach(() => {
  dom = installFakeDom();
  pill = dom.document.createElement("button");
  pill.id = "network-pill";
  pill.className = "network-pill";
  const label = dom.document.createElement("span");
  label.className = "network-pill__label";
  label.textContent = "Testnet";
  pill.appendChild(label);
  dom.document.body.appendChild(pill);
  onSelectPreset = vi.fn(async () => {});
  menu = createNetworkMenuController({ onSelectPreset });
});

afterEach(() => {
  menu.close();
  vi.unstubAllGlobals();
});

const ov = { nodeUrl: "https://testnet.nodes.dusk.network" };
const items = () => dom.document.body.querySelectorAll(".net-menu [role=menuitemradio]");
const item = (name) => items().find((el) => el.querySelector(".net-menu-item-label").textContent === name);

describe("network menu", () => {
  it("checks Custom for any address a network's file doesn't list, with its host, whatever it looks like", () => {
    menu.open(pill, { nodeUrl: "https://testnet.evil.example" });
    // Not Testnet, though its address starts as Testnet's: the last choice, the custom one, with its host.
    expect(item("Testnet").getAttribute("aria-checked")).toBe("false");
    expect(items().map((el) => el.getAttribute("aria-checked"))).toEqual(["false", "false", "false", "false", "true"]);
    expect(items().at(-1).querySelector(".net-menu-item-hint").textContent).toBe("testnet.evil.example");
  });

  it("names the network it's still on when the switch fails or throws", async () => {
    vi.stubGlobal("alert", vi.fn());
    for (const failure of [async () => false, async () => Promise.reject(new Error("offline"))]) {
      onSelectPreset.mockImplementationOnce(failure);
      menu.open(pill, ov);
      item("Mainnet").click();
      await settle();
      expect(pill.textContent).toBe("Testnet");
    }
    expect(alert).toHaveBeenCalledWith("offline");
  });
});
