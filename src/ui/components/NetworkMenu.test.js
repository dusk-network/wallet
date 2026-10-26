import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installFakeDom, press, settle } from "../testing/fakeDom.js";
import { iconSvg } from "./ActionIcon.js";
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
});

const ov = { nodeUrl: "https://testnet.nodes.dusk.network" };
const items = () => dom.document.body.querySelectorAll(".net-menu [role=menuitemradio]");
const item = (name) => items().find((el) => el.querySelector(".net-menu-item-label").textContent === name);

describe("network menu", () => {
  it("is a menu of networks with the current one checked, and focus on it", () => {
    menu.open(pill, ov);
    const list = dom.document.body.querySelector("[role=menu]");
    expect(dom.document.getElementById(list.getAttribute("aria-labelledby")).textContent).toBe("Select network");
    expect(items().map((el) => [el.querySelector(".net-menu-item-label").textContent, el.getAttribute("aria-checked")])).toEqual([
      ["Mainnet", "false"],
      ["Testnet", "true"],
      ["Devnet", "false"],
      ["Local", "false"],
      ["Custom", "false"],
    ]);
    expect(item("Testnet").querySelector(".net-menu-check").innerHTML).toBe(iconSvg("check"));
    expect(dom.document.activeElement).toBe(item("Testnet"));
    expect(items().map((el) => el.getAttribute("tabindex"))).toEqual(Array(5).fill("-1"));
  });

  it("moves with the arrow keys, Home and End, and goes back to the pill on Escape", () => {
    menu.open(pill, ov);
    const at = () => dom.document.activeElement.querySelector(".net-menu-item-label").textContent;
    press(dom.document.activeElement, "ArrowDown");
    expect(at()).toBe("Devnet");
    press(dom.document.activeElement, "End");
    expect(at()).toBe("Custom");
    press(dom.document.activeElement, "ArrowDown");
    expect(at()).toBe("Mainnet");
    press(dom.document.activeElement, "ArrowUp");
    expect(at()).toBe("Custom");
    press(dom.document.activeElement, "Home");
    expect(at()).toBe("Mainnet");

    press(dom.document.activeElement, "Escape");
    expect(menu.isOpen).toBe(false);
    expect(dom.document.activeElement).toBe(pill);
    expect(pill.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Tab, from the pill, so Tab goes on to what follows it", () => {
    menu.open(pill, ov);
    const event = press(dom.document.activeElement, "Tab");
    expect(event).not.toBe(false);
    expect(menu.isOpen).toBe(false);
    expect(dom.document.activeElement).toBe(pill);
  });

  it("spins on the pill, named for the new network, until the switch is done", async () => {
    let done;
    onSelectPreset.mockImplementation(() => new Promise((resolve) => (done = resolve)));
    menu.open(pill, ov);
    item("Mainnet").click();
    await settle();
    expect(onSelectPreset).toHaveBeenCalledWith(expect.objectContaining({ id: "mainnet" }), { ov });
    expect([pill.className, pill.getAttribute("aria-busy"), pill.getAttribute("aria-label"), pill.textContent]).toEqual([
      "network-pill is-switching",
      "true",
      "Switching to Mainnet",
      "Mainnet",
    ]);
    // One switch at a time.
    menu.open(pill, ov);
    expect(menu.isOpen).toBe(false);

    done();
    await settle();
    expect([pill.className, pill.getAttribute("aria-busy"), pill.getAttribute("aria-label")]).toEqual(["network-pill", null, null]);
    expect(dom.document.activeElement).toBe(pill);
  });

  it("doesn't spin for the network it's on, or for Custom, which opens Settings", async () => {
    for (const name of ["Testnet", "Custom"]) {
      menu.open(pill, ov);
      item(name).click();
      expect(pill.classList.contains("is-switching")).toBe(false);
      await settle();
    }
    expect(onSelectPreset).toHaveBeenCalledTimes(2);
  });
});
