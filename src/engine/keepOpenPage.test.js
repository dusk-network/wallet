import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installFakeDom } from "../ui/testing/fakeDom.js";
import { clockText } from "../ui/lib/time.js";

const ext = vi.hoisted(() => ({ last: null, tabs: [], created: [], updated: [] }));
vi.mock("../platform/extensionApi.js", () => ({
  runtimeSendMessage: vi.fn(async (message) => (message.type === "DUSK_UI_LAST_SEND" ? { ok: true, result: ext.last } : null)),
  runtimeGetURL: (p) => `moz-extension://wallet/${p}`,
  tabsQuery: vi.fn(async () => ext.tabs),
  tabsCreate: vi.fn(async (props) => (ext.created.push(props), { id: 9 })),
  tabsUpdate: vi.fn(async (id, props) => (ext.updated.push([id, props]), { id })),
  tabsRemove: vi.fn(async () => {}),
  windowsGet: vi.fn(async () => ({})),
  windowsUpdate: vi.fn(async () => ({})),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.assign(ext, { last: null, tabs: [], created: [], updated: [] });
});

// The tab's page as engine.html has it.
function page() {
  const { document } = installFakeDom({ pathname: "/engine.html" });
  const make = (tag, className, text = "") => Object.assign(document.createElement(tag), { className, textContent: text });
  const line = make("p", "engine-last");
  line.hidden = true;
  const open = make("button", "btn-primary engine-open", "Open the wallet");
  document.body.append(make("p", "engine-note", "Dusk Wallet runs in this tab. Closing it locks the wallet."), line, open);
  return { document, line, open };
}

describe("the tab the wallet runs in, in Firefox", () => {
  // Chen's on Firefox for Android: closing the wallet's tab right after a send left only "Keep open · Dusk Wallet",
  // a black page with one grey line and no button. The payment had gone, and nothing said so or led back.
  it("always offers Open the wallet, in its page as the add-on ships it", async () => {
    const html = await readFile(path.resolve(process.cwd(), "public", "engine.html"), "utf8");
    expect(html).toMatch(/<button class="btn-primary engine-open" type="button">Open the wallet<\/button>/);
    expect(html).toMatch(/<p class="engine-last" role="status" hidden><\/p>/);
  });

  it("opens the wallet's own tab, or a new one where it was closed", async () => {
    const { startKeepOpenPage } = await import("./keepOpenPage.js");
    const { open } = page();
    startKeepOpenPage();
    open.click();
    await vi.waitFor(() => expect(ext.created).toEqual([{ url: "moz-extension://wallet/full.html" }]));

    // The wallet's tab still open: that one, brought to the front.
    ext.tabs = [{ id: 4, url: "moz-extension://wallet/popup.html", windowId: 1 }];
    open.click();
    await vi.waitFor(() => expect(ext.updated).toEqual([[4, { url: "moz-extension://wallet/full.html", active: true }]]));
  });

  it("says plainly whether the last payment went out, and nothing where there's none", async () => {
    vi.useFakeTimers({ toFake: ["setInterval"] });
    const { LAST_SEND_EVERY_MS, startKeepOpenPage } = await import("./keepOpenPage.js");
    const { line } = page();
    const at = new Date(2026, 10, 12, 19, 52).getTime();
    startKeepOpenPage();
    await vi.waitFor(() => expect(line.hidden).toBe(true));
    const says = async (state) => {
      ext.last = { at, state };
      vi.advanceTimersByTime(LAST_SEND_EVERY_MS);
      await vi.waitFor(() => expect(line.hidden).toBe(false));
      const text = line.textContent;
      line.hidden = true;
      return text;
    };
    const time = clockText(at);
    expect(await says("executed")).toBe(`Your payment at ${time} went through.`);
    expect(await says("submitted")).toBe(`Your payment at ${time} went out and is on its way.`);
    expect(await says("unknown")).toBe(`Your payment at ${time} went out and is on its way.`);
    expect(await says("waiting")).toBe(`Your payment at ${time} hasn't gone out yet. It goes out once the network answers.`);
    expect(await says("not_sent")).toBe(`Your payment at ${time} wasn't sent.`);
    // Handed over as the connection went: neither sent nor not, till the node's asked.
    expect(await says("unclear")).toBe(`Your payment at ${time} may have gone out already. The wallet checks once the network answers.`);
    expect(await says("failed")).toBe(`Your payment at ${time} didn't go through.`);
  });
});
