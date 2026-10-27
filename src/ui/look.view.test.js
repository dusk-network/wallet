import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import fixture from "../shared/fixtures/activity-testnet.json";
import { activityEntry, parseHistoryEntry } from "../shared/activityHistory.js";
import { openUrl } from "../platform/index.js";
import { installFakeDom, screenReaderText, settle, visibleText } from "./testing/fakeDom.js";
import { bracketTitle } from "./components/BracketTitle.js";
import { subnav } from "./components/Subnav.js";
import { activityView } from "./popup/views/activityView.js";
import { homeView } from "./popup/views/home.js";
import { txDetailsView } from "./popup/views/txDetails.js";
import { activityKey } from "./popup/activity.js";

// The look the explorer and the web wallet share: heads and labels in the
// ledger's type, the chain's blue on what leads somewhere.

// The token and NFT cards load on their own.
vi.mock("./popup/views/assets.js", () => ({ assetsSectionsView: () => [] }));
vi.mock("./popup/activity.js", async (importOriginal) => ({ ...(await importOriginal()), loadActivityDetail: vi.fn() }));
vi.mock("../platform/index.js", async (importOriginal) => ({ ...(await importOriginal()), openUrl: vi.fn(async () => true) }));
vi.mock("../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: vi.fn(async () => "alice.dusk"),
}));

process.env.TZ = "UTC";
const NOW = new Date("2026-10-23T09:00:00Z");
const [ACCOUNT] = Object.keys(fixture.accounts);

const css = () => readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");
// A rule's body, by its selector as the stylesheet writes it.
const rule = (sheet, selector) => sheet.split("\n}").find((block) => `\n${block}`.includes(`\n${selector} {`)) ?? "";

// An account's synced history, as the popup keeps it (ui/popup/activity.js).
function history(account) {
  const raw = [...fixture.accounts[account].sender, ...fixture.accounts[account].receiver];
  const seen = new Map();
  for (const e of raw) {
    const parsed = parseHistoryEntry(account, e);
    const tx = fixture.details[parsed.hash];
    seen.set(
      parsed.hash,
      activityEntry({
        ...parsed,
        value: parsed.value.toString(),
        timestamp: tx.blockTimestamp * 1000,
        success: !tx.err,
        error: tx.err || undefined,
        fee: String(tx.gasSpent * tx.tx.gasPrice),
        gasSpent: String(tx.gasSpent),
        gasPrice: String(tx.tx.gasPrice),
        gasLimit: String(tx.tx.gasLimit),
        fnName: tx.tx.callData?.fnName,
        contractId: tx.tx.callData?.contractId,
        detailsAt: 1,
      })
    );
  }
  return [...seen.values()].sort((a, b) => b.blockHeight - a.blockHeight);
}

let dom;
beforeEach(() => {
  dom = installFakeDom();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  openUrl.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const VIEWS = { activity: activityView, home: homeView, tx: txDetailsView };

// The popup on `route`, drawn again by every render as app.js does.
function setup(route = "home") {
  const ov = { isUnlocked: true, nodeUrl: fixture.nodeUrl, accounts: [ACCOUNT], selectedAccountIndex: 0, txs: [] };
  const state = {
    route,
    addressBook: { loaded: true, items: [] },
    activity: { key: activityKey(ov), account: ACCOUNT, nodeUrl: fixture.nodeUrl, entries: history(ACCOUNT), names: new Map(), loaded: true, complete: true, limit: 50 },
  };
  const draw = () => dom.document.body.replaceChildren(...VIEWS[state.route](ov, { state, actions }));
  const actions = { render: vi.fn(async () => draw()), showToast: vi.fn(), send: vi.fn() };
  draw();
  return { state, draw };
}

const body = () => dom.document.body;
const blue = () => body().querySelectorAll(".chain-link");

describe("a section's head", () => {
  it("reads as [ ACTIVITY ], its brackets drawn and not read", () => {
    const head = bracketTitle({ text: "Activity" });
    expect(head.localName).toBe("h2");
    expect(visibleText(head)).toBe("[Activity]");
    expect(screenReaderText(head)).toBe("Activity");
    expect(head.querySelectorAll(".bracket-title__bracket").map((b) => [b.textContent, b.getAttribute("aria-hidden")])).toEqual([
      ["[", "true"],
      ["]", "true"],
    ]);
  });

  it("is in the ledger's type, in Söhne Mono, with brackets in the muted text colour", async () => {
    const sheet = await css();
    const head = rule(sheet, ".bracket-title");
    expect(head).toContain("font-family: var(--font-mono);");
    expect(head).toContain("letter-spacing: var(--ledger-tracking);");
    expect(head).toContain("text-transform: uppercase;");
    expect(rule(sheet, ".bracket-title__bracket")).toContain("color: var(--text-muted);");
    // Söhne Mono, the extension's own, as the web wallet and the explorer set it.
    expect(sheet).toMatch(/--font-mono: "Soehne Mono", ui-monospace,/);
  });
});

describe("a head with a link beside it", () => {
  it("sets the two on one baseline, as See all beside [ ACTIVITY ]", async () => {
    const head = rule(await css(), ".section-head");
    expect(head).toContain("align-items: baseline;");
    expect(head).not.toContain("align-items: center;");
    setup("home");
    const row = body().querySelector(".home-activity .section-head");
    expect(row.children.map((child) => child.className)).toEqual(["bracket-title", "see-all chain-link"]);
  });
});

describe("a sub-page's title", () => {
  it("stays plain, without brackets, in the text font", async () => {
    const title = subnav({ title: "Staking", onBack: () => {} }).querySelector(".subnav-title");
    expect(title.localName).toBe("h1");
    expect(title.textContent).toBe("Staking");
    expect(title.children).toHaveLength(0);
    const plain = rule(await css(), ".subnav-title");
    expect(plain).not.toContain("text-transform");
    expect(plain).not.toContain("--font-mono");
  });
});

describe("the labels of balances and stakes", () => {
  it("are in the ledger's type; day groups keep sentence case", async () => {
    const sheet = await css();
    for (const label of [".balance-label__text", ".balance-split-label", ".stake-lbl"]) {
      const body = rule(sheet, label);
      expect(body, label).toContain("font-family: var(--font-mono);");
      expect(body, label).toContain("font-size: var(--ledger-size);");
      expect(body, label).toContain("text-transform: uppercase;");
    }
    expect(rule(sheet, "h2.tx-day-label")).not.toContain("text-transform");
    setup("activity");
    expect(body().querySelectorAll("h2.tx-day-label").map((day) => day.textContent)[0]).toBe("Yesterday");
  });
});

describe("the chain's blue", () => {
  it("is only on what leads somewhere: See all, the explorer and a transaction's ID", async () => {
    const view = setup("home");
    // Home: See all, which opens Activity. A row opens its details: a row, not a link.
    expect(blue().map(visibleText)).toEqual(["See all"]);
    expect(body().querySelectorAll(".tx-row .chain-link")).toHaveLength(0);
    blue()[0].click();
    await settle();
    expect(view.state.route).toBe("activity");

    // Activity: the account on Dusk's explorer.
    expect(blue().map(visibleText)).toEqual(["View in Dusk explorer"]);
    blue()[0].click();
    await settle();
    expect(openUrl).toHaveBeenCalledTimes(1);

    // A transaction's details: its ID, which opens it on the explorer. Copy acts, so it isn't blue.
    Object.assign(view.state, { route: "tx", txDetailHash: view.state.activity.entries[0].hash, txDetailFrom: "home" });
    view.draw();
    expect(blue().map((el) => el.className)).toEqual(["text-btn tx-id chain-link"]);
    blue()[0].click();
    await settle();
    expect(openUrl).toHaveBeenCalledTimes(2);
  });

  it("is set only through .chain-link, on buttons that aren't disabled", async () => {
    const sheet = await css();
    const blocks = sheet.split("\n}").filter((block) => block.includes("var(--chain-blue)"));
    expect(blocks).toHaveLength(1);
    const selectors = blocks[0]
      .slice(0, blocks[0].indexOf("{"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(",")
      .map((selector) => selector.trim());
    expect(selectors).toEqual(["button.chain-link:not(:disabled)", "button.chain-link:not(:disabled):hover"]);
  });
});
