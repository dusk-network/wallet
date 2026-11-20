import { CSV_COLUMNS } from "@dusk-network/app-core/export";
import { networks, routes } from "@dusk-network/networks";
import { duskEvmContracts } from "@dusk-network/networks/duskevm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TX_KIND } from "../shared/constants.js";
import { entryOf } from "../shared/fixtures/rows.js";
import { installFakeDom, isShown, settle, visibleText } from "./testing/fakeDom.js";
import { recordedEvm, recordedMigration } from "./testing/recordedEvm.js";
import { activityView } from "./popup/views/activityView.js";
import { txDetailsView } from "./popup/views/txDetails.js";
import { ActivityChangedError, activityKey } from "./popup/activity.js";
import { currencyName, handedExportKey, saveHandedExport } from "./popup/activityExport.js";
import { runtimeGetURL, storageSessionGet, storageSessionRemove, storageSessionSet, tabsCreate } from "../platform/extensionApi.js";
import { listAddressBook } from "../shared/addressBook.js";

// The contacts, read from the wallet when the page hasn't read them yet.
vi.mock("../shared/addressBook.js", () => ({ listAddressBook: vi.fn(async () => []) }));

vi.mock("../platform/extensionApi.js", async (importOriginal) => ({
  ...(await importOriginal()),
  runtimeGetURL: vi.fn((path) => `chrome-extension://wallet/${path}`),
  storageSessionGet: vi.fn(async () => ({})),
  storageSessionRemove: vi.fn(async () => {}),
  storageSessionSet: vi.fn(async () => {}),
  tabsCreate: vi.fn(async () => ({})),
}));

// The profile's verified .dusk name, as the header reads it: none here.
vi.mock("../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: vi.fn(async () => null),
}));

// What the archive answers about each stake with Sozu.
const archive = vi.hoisted(() => ({ query: vi.fn(async () => ({})) }));
vi.mock("../shared/activityHistory.js", async (importOriginal) => ({
  ...(await importOriginal()),
  archiveAt: () => archive,
}));

process.env.TZ = "UTC";
const NOW = new Date("2026-10-23T09:00:00Z");
const NODE = "https://testnet.nodes.dusk.network";

const ACCOUNT = "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const SAVINGS = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const ADDRESS = "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";
const FAUCET = "26JfWKvhYdVY71bdSPVLNJ51Buy4GjimCT7zcsoxNQtydDbdoH2AwZaH8W7rjcAc9riAu39Vw9Lx1w7yrkBgotSjWmUdkSyQuaTKDZWVCKp9g1GxiEnnksv3W3onToB5NsNi";
const EVM = "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F";
const AT = Date.parse("2026-10-23T07:00:30Z");
const SUMMER = Date.parse("2026-08-15T10:00:00Z");

// The wallet's own: a send, and DUSK bridged to DuskEVM.
const LOCAL = [
  { hash: "a1".repeat(32), kind: TX_KIND.TRANSFER, privacy: "public", to: FAUCET, toName: "faucet.dusk", amount: "5000000000", status: "executed", submittedAt: AT, profileIndex: 0 },
  {
    hash: "a2".repeat(32),
    kind: TX_KIND.CONTRACT_CALL,
    contractId: duskEvmContracts(2).bridge,
    fnName: "depositETHToWithValue",
    amount: "0",
    deposit: "500000000",
    bridgeTo: EVM,
    status: "executed",
    submittedAt: AT - 1000,
    profileIndex: 0,
  },
  { hash: "a3".repeat(32), kind: TX_KIND.TRANSFER, direction: "in", from: FAUCET, amount: "1000000000", status: "executed", timestamp: AT - 2000, profileIndex: 0 },
];

// What the archive keeps of the account: older than the page a popup has read.
const WHOLE = [
  { hash: "c1".repeat(32), direction: "out", counterparty: FAUCET, value: "2500000000", fee: "1850000", timestamp: AT, memo: "Factura 33, abril" },
  { hash: "c2".repeat(32), direction: "in", counterparty: FAUCET, payer: false, value: "7000000000", timestamp: SUMMER, blockHeight: 4_600_000 },
  { hash: "c3".repeat(32), direction: "out", counterparty: SAVINGS, value: "1000000000", fee: "1850000", timestamp: SUMMER + 1000, blockHeight: 4_600_001 },
];

let dom;
let saved;
// An EVM chain's RPC with nothing for the person: its head, and no logs.
const rpc = vi.fn(async (_url, init) => {
  const { id, method } = JSON.parse(String(init?.body ?? "{}"));
  const result = method === "eth_blockNumber" ? "0x100" : method === "eth_getLogs" ? [] : null;
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json" } });
});
function page(pathname) {
  dom = installFakeDom({ pathname });
  dom.document.body.className = pathname === "/popup.html" ? "page--popup" : "page--full";
  vi.stubGlobal("history", { state: null, replaceState: vi.fn() });
  vi.stubGlobal("close", vi.fn());
  // The bridge's chains, as app-core reads a migration's side and the person's
  // approvals there for the EVM addresses bridged to: nothing on them here.
  vi.stubGlobal("fetch", rpc);
  // What a download saves: the file.
  saved = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    saved.push({ blob });
    return "blob:activity";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
}

// Mainnet, where DUSK has a price, for the values a file can add.
const ON_MAINNET = { ov: { nodeUrl: "https://nodes.dusk.network", networkName: "Mainnet" }, shielded: { walletId: ACCOUNT, nodeUrl: "https://nodes.dusk.network", entries: [], profileIndex: 0 } };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  archive.query.mockImplementation(async () => ({}));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Activity, drawn again by every render as app.js does, its archive's history
// (`entries`) read only by what asks for it whole.
function setup({ status = null, contacts = [], entries = WHOLE, ov: over = {}, history: historyOver = {}, shielded = { walletId: ACCOUNT, nodeUrl: NODE, entries: [], profileIndex: 0 }, answer, open } = {}) {
  const ov = {
    isUnlocked: true,
    nodeUrl: NODE,
    networkName: "Testnet",
    accounts: [ACCOUNT, SAVINGS],
    addresses: [ADDRESS],
    selectedAccountIndex: 0,
    accountNames: { 0: "Estudio Sofía" },
    txs: LOCAL,
    ...over,
  };
  const read = entries.map((fields) => entryOf(fields, ov.nodeUrl));
  const history = {
    sync: vi.fn(async () => ({})),
    read: vi.fn(async () => ({ entries: read, state: { finalized: 5_000_000, headAt: AT }, complete: true, coveredTo: 0 })),
    needsDetails: vi.fn(() => false),
    fillDetails: vi.fn(async () => {}),
    ...historyOver,
  };
  const state = {
    route: "activity",
    overview: ov,
    addressBook: { loaded: true, items: contacts },
    activity: {
      key: activityKey(ov),
      account: ACCOUNT,
      profileIndex: 0,
      walletId: ACCOUNT,
      nodeUrl: ov.nodeUrl,
      entries: [],
      names: new Map(),
      loaded: true,
      complete: true,
      limit: 50,
      history,
      epoch: Promise.resolve(1),
      // The wallet: the shielded history it answers with, and what's open in it now.
      send: vi.fn(async ({ type }) => (type === "DUSK_UI_OVERVIEW" ? (open ?? ov) : type === "DUSK_UI_STATUS" ? (status ?? { accounts: (open ?? ov).accounts, isUnlocked: (open ?? ov).isUnlocked }) : (answer ?? { result: shielded }))),
    },
  };
  const actions = { render: vi.fn(async () => draw()), showToast: vi.fn() };
  const draw = () => dom.document.body.replaceChildren(...activityView(ov, { state, actions }));
  draw();
  return { ov, state, actions, history };
}

const body = () => dom.document.body;
const panel = () => body().querySelector("#activity-export");
// Export, and Save CSV, its panel's one button: by where they are, not their words.
const exportToggle = () => body().querySelector(".activity-export-toggle");
const saveCsv = () => panel().querySelector("button");
// A figure exactly as written: not inside a longer number, not signed or bounded unless written so, and not followed by
// more digits, letters or a decimal part (1.0025 ≠ 11.0025, 0.005 ≠ −0.005, 2,000,000 ≠ 2,000,000.5, BNB ≠ BNBX).
const exactly = (text) => new RegExp(`(?<![\\d.,+\\-−<>≤≥~])${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\dA-Za-z]|[.,]\\d)`);
const fieldError = () => panel().querySelectorAll(".field-error").filter(isShown).map((el) => el.textContent).join("");

// The file saved, by its columns' names.
async function linesOf(i = 0) {
  const [head, ...rows] = (await saved[i].blob.text()).trim().split("\r\n");
  const columns = head.split(",");
  return rows.map((row) => {
    // Quoted fields, as a memo's comma makes one.
    const fields = [...row.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)].map((m) => m[1].replace(/^"|"$/g, "").replaceAll('""', '"'));
    return Object.fromEntries(columns.map((name, at) => [name, fields[at]]));
  });
}

const choose = (id, on = true) => {
  const box = body().querySelector(`#${id}`);
  box.checked = on;
  box.dispatchEvent(new Event("change"));
};
const pickPeriod = (value) => {
  const select = body().querySelector("#activity-export-period");
  select.value = value;
  select.dispatchEvent(new Event("change"));
};

describe("Activity's Export", () => {
  it("saves the whole of the profile's history, read first, in Koinly's columns", async () => {
    page("/full.html");
    const { actions, history } = setup();
    exportToggle().click();
    saveCsv().click();
    await settle();
    expect(history.sync).toHaveBeenCalled();
    expect(saved).toHaveLength(1);
    expect(saved[0].blob.type).toBe("text/csv;charset=utf-8");
    const text = await saved[0].blob.text();
    // Koinly's universal columns, written here; as an extra check, app-core's (CSV_COLUMNS).
    expect(text.split("\r\n")[0]).toBe(
      "Date,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency,Net Worth Amount,Net Worth Currency,Tag,Description,TxHash,Account Name,Account,Counterparty Name,Counterparty,Internal Transfer,Memo"
    );
    expect(text.split("\r\n")[0]).toBe(CSV_COLUMNS.join(","));
    const lines = await linesOf();
    // All of it, oldest first, whatever the page shows or the filters pick.
    const sent = lines.find((l) => l.TxHash === "c1".repeat(32));
    expect(sent).toMatchObject({
      Date: "2026-10-23 07:00:30",
      "Sent Amount": "2.5",
      "Sent Currency": "DUSK",
      "Fee Amount": "0.00185",
      "Fee Currency": "DUSK",
      "Net Worth Amount": "",
      Description: "Factura 33, abril",
      "Account Name": "Estudio Sofía",
      Account: ACCOUNT,
      Counterparty: FAUCET,
      Memo: "Factura 33, abril",
    });
    expect(lines.map((l) => l.Date)).toEqual([...lines.map((l) => l.Date)].sort());
    // Saved, and how many lines it has; with the shielded activity synced, nothing said of it still coming.
    expect(actions.showToast.mock.calls.at(-1)[0]).toMatch(exactly(String(lines.length)));
    expect(actions.showToast.mock.calls.at(-1)[0]).not.toMatch(/shielded/i);
  });

  it("marks a transfer between the person's own profiles, which isn't income", async () => {
    page("/full.html");
    setup();
    exportToggle().click();
    saveCsv().click();
    await settle();
    const own = (await linesOf()).find((l) => l.TxHash === "c3".repeat(32));
    expect(own).toMatchObject({ "Counterparty Name": "Profile 2", "Internal Transfer": "yes", Tag: "", Description: "Transfer to own profile Profile 2" });
  });

  it("names another wallet's profile as the person's own too", async () => {
    page("/full.html");
    setup({
      ov: { accounts: [ACCOUNT], addresses: [ADDRESS], wallets: [{ key: "w1", n: 1, active: true, accounts: [ACCOUNT] }, { key: "w2", n: 2, name: "Savings", accounts: [SAVINGS], accountNames: { 0: "Rainy day" } }] },
    });
    exportToggle().click();
    saveCsv().click();
    await settle();
    expect((await linesOf()).find((l) => l.TxHash === "c3".repeat(32))).toMatchObject({ "Counterparty Name": "Savings · Rainy day", "Internal Transfer": "yes" });
  });

  it("holds a quarter, and says when there's nothing in it", async () => {
    page("/full.html");
    setup();
    exportToggle().click();
    pickPeriod("2026-3");
    expect(body().querySelector("#activity-export-period").value).toBe("2026-3");
    saveCsv().click();
    await settle();
    expect((await linesOf()).map((l) => l.TxHash)).toEqual(["c2".repeat(32), "c3".repeat(32)]);

    exportToggle().click();
    pickPeriod("2025-1");
    saveCsv().click();
    await settle();
    expect(saved).toHaveLength(1);
    expect(fieldError()).not.toBe("");
    // Still open, to pick another.
    expect(saveCsv().disabled).toBe(false);
  });

  it("holds any dates, both days whole, and says what's wrong with them", async () => {
    page("/full.html");
    setup();
    exportToggle().click();
    pickPeriod("dates");
    const day = (id, value) => {
      const input = body().querySelector(`#${id}`);
      input.value = value;
      input.dispatchEvent(new Event("input"));
    };
    saveCsv().click();
    await settle();
    expect(fieldError()).not.toBe("");
    day("activity-export-from", "2026-10-23");
    day("activity-export-to", "2026-10-01");
    saveCsv().click();
    await settle();
    expect(fieldError()).not.toBe("");
    expect(saved).toHaveLength(0);
    day("activity-export-to", "2026-10-23");
    day("activity-export-from", "2026-10-23");
    saveCsv().click();
    await settle();
    expect(saved).toHaveLength(1);
    expect((await linesOf()).map((l) => l.TxHash)).toContain("c1".repeat(32));
    expect((await linesOf()).map((l) => l.TxHash)).not.toContain("c2".repeat(32));
  });

  it("adds the user's contact names only when asked, reading them first, and says so when it can't", async () => {
    page("/full.html");
    const { state, actions } = setup({ contacts: [{ name: "Marta", address: FAUCET }] });
    exportToggle().click();
    saveCsv().click();
    await settle();
    expect((await linesOf()).find((l) => l.TxHash === "c1".repeat(32))["Counterparty Name"]).toBe("");

    exportToggle().click();
    choose("activity-export-contacts");
    expect(state.activityExport.withContacts).toBe(true);
    saveCsv().click();
    await settle();
    expect((await linesOf(1)).find((l) => l.TxHash === "c1".repeat(32))["Counterparty Name"]).toBe("Marta");

    // The page's own read of the contacts is still out: it waits for them.
    state.addressBook = { loaded: false, loading: true, items: null };
    const read = Promise.withResolvers();
    listAddressBook.mockReturnValueOnce(read.promise);
    exportToggle().click();
    saveCsv().click();
    await settle();
    expect(saved).toHaveLength(2);
    expect(saveCsv().disabled).toBe(true);
    read.resolve([{ id: "1", name: "Marta", address: FAUCET }]);
    await settle();
    expect(saved).toHaveLength(3);

    // They can't be read: nothing saved, and it says so.
    listAddressBook.mockRejectedValueOnce(new Error("Wallet locked"));
    exportToggle().click();
    saveCsv().click();
    await settle();
    expect(saved).toHaveLength(3);
    expect(fieldError()).not.toBe("");
    // Said saved for the three files alone.
    expect(actions.showToast).toHaveBeenCalledTimes(3);
  });

  it("reads what isn't kept yet, with the details of what it has none of", async () => {
    page("/full.html");
    let runs = 0;
    const { history } = setup({
      history: {
        sync: vi.fn(async () => {
          runs += 1;
        }),
        read: vi.fn(async ({ limit }) => ({
          entries: limit === 1 ? [] : WHOLE.map((fields) => entryOf(fields, NODE)),
          state: { finalized: 5_000_000 },
          complete: runs >= 3,
          coveredTo: 0,
        })),
        needsDetails: vi.fn((entry) => entry.hash === "c2".repeat(32)),
      },
    });
    exportToggle().click();
    saveCsv().click();
    await settle();
    expect(history.sync).toHaveBeenCalledTimes(3);
    expect(history.fillDetails.mock.calls[0][0].map((e) => e.hash)).toEqual(["c2".repeat(32)]);
    expect(saved).toHaveLength(1);
  });

  describe("with a wallet that changes while the file is made", () => {
    const OTHER_WALLET = FAUCET;
    const THEIRS = { hash: "e1".repeat(32), kind: "transfer", direction: "out", value: "9000000000", fee: "1000000", success: true, timestamp: AT, blockHeight: 4_650_000 };
    // What a read the wallet changed under says, written here: the wallet changed, so nothing was saved; not that the
    // node failed. As an extra check, the app's own words.
    const CHANGED = new ActivityChangedError().message;
    const expectChanged = () => {
      expect(fieldError()).toMatch(/wallet changed/i);
      expect(fieldError()).toMatch(/nothing was saved/i);
      expect(fieldError()).not.toMatch(/\bnode\b/i);
      expect(fieldError()).toBe(CHANGED);
    };
    const exporting = async (options) => {
      page("/full.html");
      setup(options);
      exportToggle().click();
      saveCsv().click();
      await settle();
    };

    it.each([
      ["another wallet's, on the same profile", { walletId: OTHER_WALLET, nodeUrl: NODE }],
      ["another network's, for the same wallet", { walletId: ACCOUNT, nodeUrl: "https://nodes.dusk.network" }],
    ])("takes no shielded history that's %s, and saves nothing", async (_, of) => {
      await exporting({ shielded: { ...of, profileIndex: 0, entries: [THEIRS] } });
      expect(saved).toEqual([]);
      expectChanged();
    });

    it("saves nothing when the wallet says its read stopped as another opened", async () => {
      await exporting({
        answer: { error: { message: "The wallet changed while its shielded history was read" } },
        open: { isUnlocked: true, nodeUrl: NODE, accounts: [OTHER_WALLET], selectedAccountIndex: 0 },
      });
      expect(saved).toEqual([]);
      expectChanged();
    });

    it.each([
      ["another wallet", { isUnlocked: true, nodeUrl: NODE, accounts: [OTHER_WALLET], selectedAccountIndex: 0 }],
      ["another profile", { isUnlocked: true, nodeUrl: NODE, accounts: [ACCOUNT, SAVINGS], selectedAccountIndex: 1 }],
      ["another network", { isUnlocked: true, nodeUrl: "https://nodes.dusk.network", accounts: [ACCOUNT, SAVINGS], selectedAccountIndex: 0 }],
      ["a locked wallet", { isUnlocked: false }],
    ])("saves nothing when it's %s by the time the file is made", async (_, open) => {
      await exporting({ open });
      expect(saved).toEqual([]);
      expectChanged();
    });

    it("saves nothing when the wallet locks during the overview that checks it", async () => {
      // The overview's status was taken before its balance reads: only the wallet's status is as of now.
      await exporting({ status: { accounts: [], isUnlocked: false } });
      expect(saved).toEqual([]);
      expectChanged();
    });

    it("says so of a read that stopped as the wallet changed, not that the node failed", async () => {
      await exporting({
        history: { sync: vi.fn(async () => { throw new Error("Another run started this history over"); }) },
        open: { isUnlocked: true, nodeUrl: NODE, accounts: [OTHER_WALLET], selectedAccountIndex: 0 },
      });
      expect(saved).toEqual([]);
      expectChanged();
    });

    it("saves its own shielded history as ever, with nothing changed", async () => {
      await exporting({ shielded: { walletId: ACCOUNT, nodeUrl: NODE, profileIndex: 0, entries: [THEIRS] } });
      expect((await linesOf()).map((line) => line.TxHash)).toContain(THEIRS.hash);
    });
  });

  it("saves nothing half read: a history it can't have whole says so", async () => {
    page("/full.html");
    // Said, written here: the whole history couldn't be read, so nothing was saved; not that the wallet changed.
    const expectHalfRead = () => {
      expect(fieldError()).toMatch(/whole history/i);
      expect(fieldError()).toMatch(/nothing was saved/i);
      expect(fieldError()).not.toMatch(/wallet changed/i);
    };
    setup({ history: { sync: vi.fn(async () => Promise.reject(new Error("offline"))) } });
    exportToggle().click();
    saveCsv().click();
    await settle();
    expect(saved).toHaveLength(0);
    expectHalfRead();

    setup({ history: { read: vi.fn(async () => ({ entries: [], state: {}, complete: false, coveredTo: 0 })) } });
    exportToggle().click();
    saveCsv().click();
    await settle();
    expect(saved).toHaveLength(0);
    expectHalfRead();
  });

  it("says what it left out, and that shielded activity is still coming", async () => {
    page("/full.html");
    const { actions } = setup({ shielded: { walletId: ACCOUNT, nodeUrl: NODE, entries: [], profileIndex: 0, pending: true }, entries: [...WHOLE, { hash: "c9".repeat(32), direction: "in", counterparty: FAUCET, payer: false, value: "5", detailsAt: 0, timestamp: null, success: null }] });
    exportToggle().click();
    saveCsv().click();
    await settle();
    const said = actions.showToast.mock.calls.at(-1)[0];
    // The one line left out, and the shielded activity still to come.
    expect(said).toMatch(exactly("1"));
    expect(said).toMatch(/shielded/i);
  });

  it("adds each payment's value in euros only when asked, from prices near its time, asking for no account", async () => {
    page("/full.html");
    // A browser in a region that pays in euros.
    vi.stubGlobal("navigator", { ...globalThis.navigator, language: "nl-NL" });
    const asked = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        // The bridge's chains, read for the DuskEVM address the profile bridged to.
        if (init?.body) return rpc(url, init);
        asked.push(String(url));
        // Hourly prices of the 88 days this asks for, with one payment's hour missing.
        const from = Number(new URL(url).searchParams.get("from")) * 1000;
        const to = Number(new URL(url).searchParams.get("to")) * 1000;
        const prices = [];
        for (let at = Math.ceil(from / 3_600_000) * 3_600_000; at <= to; at += 3_600_000) if (Math.abs(at - SUMMER) > 12 * 3_600_000) prices.push([at, 0.25]);
        return { ok: true, status: 200, json: async () => ({ prices }) };
      })
    );
    const { actions } = setup(ON_MAINNET);
    exportToggle().click();
    saveCsv().click();
    await settle();
    expect(asked).toEqual([]);
    expect((await linesOf()).every((l) => l["Net Worth Amount"] === "" && l["Net Worth Currency"] === "")).toBe(true);

    exportToggle().click();
    choose("activity-export-value");
    saveCsv().click();
    await settle();
    const lines = await linesOf(1);
    expect(lines.find((l) => l.TxHash === "c1".repeat(32))).toMatchObject({ "Net Worth Amount": "0.62500000", "Net Worth Currency": "EUR" });
    // No price near that time: its columns stay empty, and it says how many lines have none.
    expect(lines.find((l) => l.TxHash === "c2".repeat(32))).toMatchObject({ "Net Worth Amount": "", "Net Worth Currency": "" });
    expect(actions.showToast.mock.calls.at(-1)[0]).toMatch(exactly("2"));
    for (const url of asked) {
      expect(url).toContain("https://api.coingecko.com/api/v3/coins/dusk-network/market_chart/range?vs_currency=eur&from=");
      expect(url).not.toContain(ACCOUNT);
    }
    // A window of prices is read once.
    expect(new Set(asked).size).toBe(asked.length);
  });

  it("says a price that can't be read leaves the columns empty, and saves the file all the same", async () => {
    page("/full.html");
    vi.stubGlobal("navigator", { ...globalThis.navigator, language: "de-DE" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })));
    const { actions } = setup({ ...ON_MAINNET, entries: WHOLE.slice(0, 1) });
    exportToggle().click();
    choose("activity-export-value");
    saveCsv().click();
    await settle();
    expect(saved).toHaveLength(1);
    // Said: lines with no value in euros, the currency named, written here; as an extra check, by the app's own name for it.
    expect(actions.showToast.mock.calls.at(-1)[0]).toMatch(exactly("euro"));
    expect(actions.showToast.mock.calls.at(-1)[0]).toContain(currencyName("EUR", 1));
  });

  // Lena's German browser got dollars on the web wallet, and Wei's Singapore phone US dollars: the region's own, where CoinGecko has it.
  it.each([
    ["en-SG", "sgd"],
    ["ro-RO", "usd"],
  ])("adds values in the currency of the browser's region where CoinGecko prices DUSK in it, else in US dollars: %s", async (language, vs) => {
    page("/full.html");
    vi.stubGlobal("navigator", { ...globalThis.navigator, language });
    const asked = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (init?.body) return rpc(url, init);
        asked.push(String(url));
        return { ok: false, status: 429, json: async () => ({}) };
      })
    );
    setup({ ...ON_MAINNET, entries: WHOLE.slice(0, 1) });
    exportToggle().click();
    choose("activity-export-value");
    saveCsv().click();
    await settle();
    expect(asked.length).toBeGreaterThan(0);
    for (const url of asked) expect(url).toContain(`vs_currency=${vs}&from=`);
  });

  // Amélie's: a testnet export, euros ticked, gave test DUSK a euro value in a file for her tax return.
  it("gives test DUSK no value: none to add on Testnet, and none in the file, ticked on Mainnet before or not", async () => {
    page("/full.html");
    vi.stubGlobal("navigator", { ...globalThis.navigator, language: "fr-FR" });
    const asked = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => (init?.body ? rpc(url, init) : (asked.push(String(url)), { ok: true, status: 200, json: async () => ({ prices: [[SUMMER, 0.25]] }) }))));
    const { state } = setup();
    exportToggle().click();
    // Ticked before, as on Mainnet: Testnet's file has none all the same.
    state.activityExport.fiat = true;
    expect(body().querySelector("#activity-export-value")).toBeNull();
    saveCsv().click();
    await settle();
    expect(asked).toEqual([]);
    expect((await linesOf()).every((l) => l["Net Worth Amount"] === "" && l["Net Worth Currency"] === "")).toBe(true);
  });

  it("starts the file with a BOM only for Excel", async () => {
    page("/full.html");
    setup();
    const firstBytes = async (i) => [...new Uint8Array(await saved[i].blob.arrayBuffer()).slice(0, 3)];
    exportToggle().click();
    saveCsv().click();
    await settle();
    expect(await firstBytes(0)).toEqual([0x44, 0x61, 0x74]);
    exportToggle().click();
    choose("activity-export-excel");
    saveCsv().click();
    await settle();
    expect(await firstBytes(1)).toEqual([0xef, 0xbb, 0xbf]);
  });

  // DUSK this profile sent to BNB Smart Chain, to an EVM address there: the address it knows as the person's.
  const bridgedTo = (to, timestamp, hash = "b0".repeat(32)) => {
    const out = routes(networks.mainnet).find((r) => r.id === "dusk-to-bsc");
    return { hash, direction: "out", counterparty: out.account, value: "2000000000", fee: "1850000", memo: to, timestamp, blockHeight: 5_600_000 };
  };
  // The bridge's chains, as app-core reads a migration's side and the person's approvals there: BNB Smart Chain's as
  // recorded, and Ethereum's with nothing for the person.
  const onChains = (url, recorded) => {
    const bsc = recordedEvm(url, recorded);
    return async (input, init) => (String(input?.url ?? input) === url ? bsc.fetch(input, init) : rpc(input, init));
  };
  const paidThere = (lines) => lines.filter((l) => l["Sent Currency"] === "BNB").map((l) => [l.TxHash, l["Sent Amount"], l.Tag, l["Account Name"], l.Account]);

  // Nandini's: the payout's details said what its migration paid on BNB Smart Chain, to the wei, and the file left
  // it out without a word. Sofía's and Lena's: a migration someone else sent to the profile, from an EVM address that
  // isn't theirs, was booked as their cost.
  it("books what a migration paid on its own chain, to the wei of the payout's details, where it came from an address this profile bridged to, and no one else's", async () => {
    const route = routes(networks.mainnet).find((r) => r.id === "bsc-to-dusk");
    const { approval, migration, owner, payout } = recordedMigration;
    const paidOut = { hash: payout.hash, direction: "in", counterparty: route.payoutAccount, payer: false, value: payout.value, memo: migration, timestamp: payout.at, blockHeight: 5_684_134 };
    const MAINNET = "https://nodes.dusk.network";
    const onMainnet = (entries) => setup({ entries, ov: { nodeUrl: MAINNET, networkName: "Mainnet", txs: [] }, shielded: { walletId: ACCOUNT, nodeUrl: MAINNET, entries: [], profileIndex: 0 } });

    // Migrated to the profile from an address it never bridged to: the payout alone, and that chain isn't asked.
    page("/full.html");
    const chain = vi.fn(recordedEvm(route.chain.rpcUrl).fetch);
    vi.stubGlobal("fetch", chain);
    const stranger = onMainnet([paidOut]);
    exportToggle().click();
    saveCsv().click();
    await vi.waitFor(() => expect(stranger.actions.showToast).toHaveBeenCalled());
    expect(paidThere(await linesOf())).toEqual([]);
    expect((await linesOf()).find((l) => l.TxHash === payout.hash)?.["Received Amount"]).toBe("1041.53106263");
    expect(chain).not.toHaveBeenCalled();
    // Its one line, and no fees said to be in the file from that address.
    const told = stranger.actions.showToast.mock.calls.at(-1)[0];
    expect(told).toMatch(exactly("1"));
    expect(told).not.toMatch(exactly("0x4E4B…FF46"));

    // From the address the profile bridged DUSK to before: booked.
    page("/full.html");
    const { actions, ov } = onMainnet([bridgedTo(owner, payout.at - 86_400_000), paidOut]);
    const exportAll = async () => {
      exportToggle().click();
      saveCsv().click();
      await vi.waitFor(() => expect(actions.showToast).toHaveBeenCalled());
      const toast = actions.showToast.mock.calls.at(-1)[0];
      actions.showToast.mockClear();
      return { lines: await linesOf(saved.length - 1), toast };
    };

    // BNB Smart Chain's RPC can't be read: the payout alone, and the toast says what's missing.
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    const down = await exportAll();
    expect(paidThere(down.lines)).toEqual([]);
    expect(down.lines.find((l) => l.TxHash === payout.hash)?.["Received Amount"]).toBe("1041.53106263");
    // The one migration's fee missing, on its chain, and no fees said to be in the file.
    expect(down.toast).toMatch(exactly("1"));
    expect(down.toast).toContain("BNB Smart Chain");
    expect(down.toast).not.toMatch(exactly("0x4E4B…FF46"));
    // Nor its approvals and revokes there, or on Ethereum: maybe in another profile's file.
    expect(down.toast).toMatch(/profile/);

    // Read: the approval and the migration, each a cost of its own, in BNB, from the address that paid it.
    vi.stubGlobal("fetch", onChains(route.chain.rpcUrl));
    const up = await exportAll();
    expect(paidThere(up.lines)).toEqual([
      [approval, "0.0000023109", "cost", "BNB Smart Chain", owner],
      [migration, "0.00000243765", "cost", "BNB Smart Chain", owner],
    ]);
    // Nothing said to be unread, nor in another profile's file.
    expect(up.toast).not.toMatch(/\bread\b/);
    expect(up.toast).not.toMatch(/profile/);
    // Nandini's: it named none of the EVM addresses whose fees it has. And how far back its approvals were read, on their chain.
    expect(up.toast).toMatch(exactly("0x4E4B…FF46"));
    expect(up.toast).toContain("BNB Smart Chain");

    // Together, to the wei, what the payout's details say it paid there.
    const wei = (text) => {
      const [whole, fraction = ""] = text.split(".");
      return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
    };
    const booked = up.lines.filter((l) => l["Sent Currency"] === "BNB").reduce((sum, l) => sum + wei(l["Sent Amount"]), 0n);
    const detailState = { route: "tx", txDetailHash: payout.hash, txDetailFrom: "activity", addressBook: { loaded: true, items: [] } };
    const tx = { hash: payout.hash, nodeUrl: MAINNET, status: "executed", kind: TX_KIND.TRANSFER, direction: "in", from: route.payoutAccount, amount: payout.value, memo: migration };
    // The details' fee on BNB Smart Chain, its row found by its label: the amount alone, apart from what it counts.
    const detailFee = () => {
      dom.document.body.replaceChildren(...txDetailsView({ ...ov, txs: [tx] }, { state: detailState, actions: { render: async () => {}, showToast: vi.fn() } }));
      const row = body()
        .querySelectorAll(".tx-detail > .group > .kv")
        .find((kv) => {
          const label = kv.querySelector(".kv-label").textContent;
          return label.includes("BNB Smart Chain") && /fee/i.test(label);
        });
      return row?.querySelector(".kv-value > span").childNodes.filter((node) => node.nodeType === 3).map((node) => node.data).join("");
    };
    detailFee();
    await vi.waitFor(() => expect(detailFee()).toBeDefined());
    expect(detailFee()).toBe("0.00000474855 BNB");
    expect(booked).toBe(wei(detailFee().split(" ")[0]));

    // An address the profile sent DUSK to on DuskEVM is the person's too.
    page("/full.html");
    vi.stubGlobal("fetch", onChains(route.chain.rpcUrl));
    const deposit = { hash: "d5".repeat(32), kind: TX_KIND.CONTRACT_CALL, contractId: duskEvmContracts(2).bridge, fnName: "depositETHToWithValue", amount: "0", deposit: "500000000", bridgeTo: owner, status: "executed", submittedAt: payout.at - 86_400_000, profileIndex: 0 };
    const viaDuskEvm = setup({ entries: [paidOut], ov: { nodeUrl: MAINNET, networkName: "Mainnet", txs: [deposit] }, shielded: { walletId: ACCOUNT, nodeUrl: MAINNET, entries: [], profileIndex: 0 } });
    exportToggle().click();
    saveCsv().click();
    await vi.waitFor(() => expect(viaDuskEvm.actions.showToast).toHaveBeenCalled());
    expect(paidThere(await linesOf()).map(([hash]) => hash)).toEqual([approval, migration]);
  });

  // In the web wallet's words: a wallet with no other profile has no other profile's file for fees to be in.
  it("says fees it couldn't read on their chains are just that, where the wallet has no other profile", async () => {
    const route = routes(networks.mainnet).find((r) => r.id === "bsc-to-dusk");
    const { migration, owner, payout } = recordedMigration;
    const MAINNET = "https://nodes.dusk.network";
    const paidOut = { hash: payout.hash, direction: "in", counterparty: route.payoutAccount, payer: false, value: payout.value, memo: migration, timestamp: payout.at, blockHeight: 5_684_134 };
    const toastWith = async (accounts) => {
      page("/full.html");
      vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
      const { actions } = setup({ entries: [bridgedTo(owner, payout.at - 86_400_000), paidOut], ov: { nodeUrl: MAINNET, networkName: "Mainnet", txs: [], accounts }, shielded: { walletId: ACCOUNT, nodeUrl: MAINNET, entries: [], profileIndex: 0 } });
      exportToggle().click();
      saveCsv().click();
      await vi.waitFor(() => expect(actions.showToast).toHaveBeenCalled());
      return actions.showToast.mock.calls.at(-1)[0];
    };
    // Fees not read, said either way; another profile's file named only where the wallet has one.
    const alone = await toastWith([ACCOUNT]);
    expect(alone).toMatch(/\bread\b/);
    expect(alone).not.toMatch(/profile/);
    expect(await toastWith([ACCOUNT, SAVINGS])).toMatch(/profile/);
  });

  it("puts a migration's fees in the period of their own day, though its payout came the day after", async () => {
    // Codex's: a 30 September fee was left out of Q3, and put in Q4 with its payout.
    vi.setSystemTime(new Date("2026-11-10T09:00:00Z"));
    page("/full.html");
    const route = routes(networks.mainnet).find((r) => r.id === "bsc-to-dusk");
    const { approval, migration, owner, payout } = recordedMigration;
    const nextDay = Date.UTC(2026, 10, 6, 0, 30);
    // Bridged to before the period, the address is the person's in it too.
    const entries = [bridgedTo(owner, Date.UTC(2026, 9, 20)), { hash: payout.hash, direction: "in", counterparty: route.payoutAccount, payer: false, value: payout.value, memo: migration, timestamp: nextDay, blockHeight: 5_684_134 }];
    const MAINNET = "https://nodes.dusk.network";
    const { actions } = setup({ entries, ov: { nodeUrl: MAINNET, networkName: "Mainnet", txs: [] }, shielded: { walletId: ACCOUNT, nodeUrl: MAINNET, entries: [], profileIndex: 0 } });
    vi.stubGlobal("fetch", onChains(route.chain.rpcUrl));
    exportToggle().click();
    pickPeriod("dates");
    for (const id of ["activity-export-from", "activity-export-to"]) {
      const input = body().querySelector(`#${id}`);
      input.value = "2026-11-05";
      input.dispatchEvent(new Event("input"));
    }
    saveCsv().click();
    await vi.waitFor(() => expect(actions.showToast).toHaveBeenCalled());
    // The approval and the migration of 5 November, and not the payout of the 6th.
    expect((await linesOf()).map((l) => [l.TxHash, l["Sent Currency"] || l["Received Currency"], l.Account])).toEqual([
      [approval, "BNB", owner],
      [migration, "BNB", owner],
    ]);
  });

  // Nandini's: the extension's file left out every revoke, and every approval no migration spent, that the web
  // wallet's had, 140 lines against 160. Both book each once, in the file of the profile its migration paid; one of an
  // address that never migrated, in the file of the profile that bridged DUSK to it first, as the archive says.
  it("books a revoke and an approval no migration spent, and an address's that never migrated where the archive says it was bridged to first", async () => {
    const route = routes(networks.mainnet).find((r) => r.id === "bsc-to-dusk");
    const service = routes(networks.mainnet).find((r) => r.id === "dusk-to-bsc");
    const { approval, migration, owner, payout } = recordedMigration;
    const [{ address: token, topics: [approvalTopic, , spender] }] = recordedMigration.logs;
    const other = "0x5a17a4f8c6a3b16a9d9e0f2c3b4d5e6f7a8b9c0d";
    const [revoke, unused, othersApproval] = ["e1", "e2", "e3"].map((byte) => `0x${byte.repeat(32)}`);
    // After the migration, on BNB Smart Chain: the owner revokes the contract's approval, and approves it again; the
    // other address approves it, and never migrates.
    const recorded = structuredClone(recordedMigration);
    const migrated = 0x7dbaa77;
    for (const [hash, from, block, allowance] of [
      [revoke, owner, migrated + 0x40, 0n],
      [unused, owner, migrated + 0x80, 10n ** 21n],
      [othersApproval, other, migrated + 0xc0, 10n ** 21n],
    ]) {
      const blockNumber = `0x${block.toString(16)}`;
      const blockTimestamp = `0x${(0x6aec991c + block - migrated).toString(16)}`;
      const log = { address: token, topics: [approvalTopic, `0x${from.slice(2).padStart(64, "0")}`, spender], data: `0x${allowance.toString(16).padStart(64, "0")}`, blockNumber, blockTimestamp, transactionHash: hash, logIndex: "0x1", removed: false };
      recorded.logs.push(log);
      recorded.receipts[hash] = { blockNumber, from, to: token, gasUsed: "0xb48a", effectiveGasPrice: "0x2faf080", logs: [log], status: "0x1", transactionHash: hash };
      recorded.transactions[hash] = { blockNumber, from, hash, to: token, value: "0x0" };
      recorded.blocks[blockNumber] = { number: blockNumber, timestamp: blockTimestamp };
    }
    const paidOut = { hash: payout.hash, direction: "in", counterparty: route.payoutAccount, payer: false, value: payout.value, memo: migration, timestamp: payout.at, blockHeight: 5_684_134 };
    const toOther = bridgedTo(other, payout.at - 43_200_000, "b2".repeat(32));
    // The archive's memo index: the transfers out to BNB Smart Chain that named the other address, by whom.
    const hex = (text) => [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const memoIndex = (answer) =>
      archive.query.mockImplementation(async (query) => {
        if (!query.includes("transactionsByMemo")) return {};
        if (answer instanceof Error) throw answer;
        const json = answer.map(([origin, sender, block_height]) => ({ origin, block_height, events: [{ target: networks.mainnet.contracts.transfer, topic: "moonlight", data: { sender, receiver: service.account, memo: hex(other) } }] }));
        return Object.fromEntries([...query.matchAll(/(m\d+): transactionsByMemo/g)].map(([, alias]) => [alias, { json }]));
      });
    const MAINNET = "https://nodes.dusk.network";
    const exportOnce = async () => {
      page("/full.html");
      vi.stubGlobal("fetch", onChains(route.chain.rpcUrl, recorded));
      const { actions } = setup({ entries: [bridgedTo(owner, payout.at - 86_400_000), toOther, paidOut], ov: { nodeUrl: MAINNET, networkName: "Mainnet", txs: [] }, shielded: { walletId: ACCOUNT, nodeUrl: MAINNET, entries: [], profileIndex: 0 } });
      exportToggle().click();
      saveCsv().click();
      await vi.waitFor(() => expect(actions.showToast).toHaveBeenCalled());
      const lines = await linesOf();
      return { lines: paidThere(lines), byHash: Object.fromEntries(lines.map((l) => [l.TxHash, l])), toast: actions.showToast.mock.calls.at(-1)[0] };
    };
    const owners = [
      [approval, "0.0000023109", "cost", "BNB Smart Chain", owner],
      [migration, "0.00000243765", "cost", "BNB Smart Chain", owner],
      [revoke, "0.0000023109", "cost", "BNB Smart Chain", owner],
      [unused, "0.0000023109", "cost", "BNB Smart Chain", owner],
    ];

    // This profile bridged to the other address first, Profile 2 after: its approval is this file's.
    memoIndex([
      [toOther.hash, ACCOUNT, 5_600_000],
      ["b9".repeat(32), SAVINGS, 5_600_100],
    ]);
    const first = await exportOnce();
    expect(first.lines).toEqual([...owners, [othersApproval, "0.0000023109", "cost", "BNB Smart Chain", other]]);
    expect([first.byHash[revoke].Description, first.byHash[unused].Description]).toEqual(["Network fee on BNB Smart Chain: approval for migrations to Dusk revoked", "Network fee on BNB Smart Chain: approval for a migration to Dusk, not used yet"]);
    // A transfer out to BNB Smart Chain sends what reached it there, and pays the bridge's fee with the network's.
    expect(first.byHash[toOther.hash]).toMatchObject({ "Sent Amount": "1", "Sent Currency": "DUSK", "Fee Amount": "1.00185", Description: `To BNB Smart Chain, bridge fee 1 DUSK · ${other}` });
    // The addresses whose fees the file has: both; and whose file each is, known: none said to be another profile's.
    expect(first.toast).toMatch(exactly("0x4E4B…FF46"));
    expect(first.toast).toMatch(exactly("0x5A17…9c0d"));
    expect(first.toast).not.toMatch(/profile/);

    // Profile 2 bridged to it first: Profile 2's file has it, and this one doesn't.
    memoIndex([
      ["b8".repeat(32), SAVINGS, 5_599_000],
      [toOther.hash, ACCOUNT, 5_600_000],
    ]);
    const second = await exportOnce();
    expect(second.lines).toEqual(owners);
    expect(second.toast).toMatch(exactly("0x4E4B…FF46"));
    expect(second.toast).not.toMatch(exactly("0x5A17…9c0d"));
    expect(second.toast).not.toMatch(/profile/);

    // Whose it is can't be read: in no file, and the toast says it may be in another profile's.
    memoIndex(new Error("archive down"));
    const unread = await exportOnce();
    expect(unread.lines).toEqual(owners);
    expect(unread.toast).toMatch(/profile/);

    // Known here only by a deposit to DuskEVM, which the memo index doesn't list: the first profile by its account,
    // Profile 2, may be the one to book it, and the toast says so.
    memoIndex([]);
    const deposit = { hash: "d6".repeat(32), kind: TX_KIND.CONTRACT_CALL, contractId: duskEvmContracts(2).bridge, fnName: "depositETHToWithValue", amount: "0", deposit: "500000000", bridgeTo: other, status: "executed", submittedAt: payout.at - 43_200_000, profileIndex: 0 };
    page("/full.html");
    vi.stubGlobal("fetch", onChains(route.chain.rpcUrl, recorded));
    const viaDuskEvm = setup({ entries: [bridgedTo(owner, payout.at - 86_400_000), paidOut], ov: { nodeUrl: MAINNET, networkName: "Mainnet", txs: [deposit] }, shielded: { walletId: ACCOUNT, nodeUrl: MAINNET, entries: [], profileIndex: 0 } });
    exportToggle().click();
    saveCsv().click();
    await vi.waitFor(() => expect(viaDuskEvm.actions.showToast).toHaveBeenCalled());
    expect(paidThere(await linesOf())).toEqual(owners);
    expect(viaDuskEvm.actions.showToast.mock.calls.at(-1)[0]).toMatch(/profile/);
  });

  it("makes a stake with Sozu a trade of DUSK for stDUSK, with its deposit fee, as the pool's event says it", async () => {
    page("/full.html");
    const pool = networks.testnet.sozu.fallbacks.pool;
    // What the pool's deposit event holds: amount, fee, stake and supply, as
    // little-endian u64s, then the account it names, a key, to 8 bytes.
    const u64 = (n) => {
      const bytes = [];
      let left = BigInt(n);
      for (let i = 0; i < 8; i += 1) {
        bytes.push(Number(left & 0xffn).toString(16).padStart(2, "0"));
        left >>= 8n;
      }
      return bytes.join("");
    };
    const hash = "d1".repeat(32);
    archive.query.mockImplementation(async () => ({
      h0: { json: [{ origin: hash, events: [{ target: pool, topic: "deposit", data: `${[100_000_000_000n, 250_000_000n, 2_000_000_000_000n, 1_000_000_000_000n].map(u64).join("")}01${"ab".repeat(193)}${"00".repeat(6)}` }] }] },
    }));
    setup({ entries: [{ hash, kind: TX_KIND.CONTRACT_CALL, contractId: pool, counterparty: pool, fnName: "sozu_stake", value: "100000000000", fee: "5000000", timestamp: AT, blockHeight: 4_700_000 }] });
    exportToggle().click();
    saveCsv().click();
    await settle();
    expect((await linesOf()).find((l) => l.TxHash === hash)).toMatchObject({
      "Sent Amount": "100",
      "Sent Currency": "DUSK",
      "Received Amount": "49.875",
      "Received Currency": "stDUSK",
      "Fee Amount": "0.005",
      Description: "Staked with Sozu, deposit fee 0.25 DUSK, 1 stDUSK = 2 DUSK",
    });
  });

  it("hands what the popup asks to a new full view tab, which makes the file once", async () => {
    page("/popup.html");
    setup();
    exportToggle().click();
    pickPeriod("2026-3");
    choose("activity-export-contacts");
    saveCsv().click();
    await settle();
    // The popup saves nothing itself: what's asked goes to the tab it opens.
    expect(saved).toHaveLength(0);
    const [[items]] = storageSessionSet.mock.calls;
    const [key] = Object.keys(items);
    const handed = items[key];
    // Kept under its own ID, written here; as an extra check, the app's own key for it.
    expect(key).toBe(`dusk_activity_export_v1:${handed.id}`);
    expect(key).toBe(handedExportKey(handed.id));
    expect(handed.choices).toMatchObject({ period: "2026-3", withContacts: true, fiat: false, excel: false });
    expect(runtimeGetURL).toHaveBeenCalledWith(`full.html?route=activity&save=${handed.id}`);
    expect(tabsCreate).toHaveBeenCalledWith({ url: `chrome-extension://wallet/full.html?route=activity&save=${handed.id}` });
    expect(close).toHaveBeenCalled();

    // The tab: it makes the file, forgets what was asked, and takes the request off its address.
    page("/full.html");
    vi.stubGlobal("location", { pathname: "/full.html", search: `?route=activity&save=${handed.id}` });
    storageSessionGet.mockImplementationOnce(async (asked) => (asked === key ? { [key]: handed } : {}));
    const tab = setup();
    await expect(saveHandedExport({ state: tab.state, render: tab.actions.render, showToast: tab.actions.showToast })).resolves.toBe(true);
    // Once, and the quarter asked for.
    expect(saved).toHaveLength(1);
    expect((await linesOf()).map((l) => l.TxHash)).toEqual(["c2".repeat(32), "c3".repeat(32)]);
    expect(storageSessionRemove).toHaveBeenCalledWith(key);
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/full.html?route=activity");
    expect(tab.state.activityExport.open).toBe(false);

    // Opened without one: nothing. With one gone: it says so.
    vi.stubGlobal("location", { pathname: "/full.html", search: "?route=activity" });
    await expect(saveHandedExport({ state: tab.state })).resolves.toBe(false);
    vi.stubGlobal("location", { pathname: "/full.html", search: "?save=old" });
    await expect(saveHandedExport({ state: tab.state })).rejects.toThrow();
    expect(saved).toHaveLength(1);
  });

  it("keeps two exports at once apart: each tab does its own and removes only its own", async () => {
    // Two session storages' worth of handovers, in memory.
    const kept = {};
    storageSessionSet.mockImplementation(async (items) => Object.assign(kept, items));
    storageSessionGet.mockImplementation(async (key) => (key in kept ? { [key]: kept[key] } : {}));
    storageSessionRemove.mockImplementation(async (key) => {
      delete kept[key];
    });
    page("/popup.html");
    setup();
    exportToggle().click();
    pickPeriod("2026-3");
    saveCsv().click();
    await settle();
    setup();
    exportToggle().click();
    pickPeriod("2026-4");
    saveCsv().click();
    await settle();
    const handed = Object.values(kept);
    expect(handed).toHaveLength(2);
    expect(new Set(handed.map((h) => h.id)).size).toBe(2);
    expect(Object.keys(kept).sort()).toEqual(handed.map((h) => `dusk_activity_export_v1:${h.id}`).sort());
    expect(Object.keys(kept).sort()).toEqual(handed.map((h) => handedExportKey(h.id)).sort());

    // The first export's tab: its file, Q3's, and the second export's still there.
    const [first, second] = handed;
    const Q3 = ["c2".repeat(32), "c3".repeat(32)];
    page("/full.html");
    vi.stubGlobal("location", { pathname: "/full.html", search: `?route=activity&save=${first.id}` });
    await saveHandedExport({ state: setup().state });
    expect((await linesOf(0)).map((l) => l.TxHash)).toEqual(Q3);
    expect(Object.keys(kept)).toEqual([`dusk_activity_export_v1:${second.id}`]);
    // The second's: Q4's.
    vi.stubGlobal("location", { pathname: "/full.html", search: `?route=activity&save=${second.id}` });
    await saveHandedExport({ state: setup().state });
    expect(saved).toHaveLength(2);
    const q4 = (await linesOf(1)).map((l) => l.TxHash);
    expect(q4).toContain("c1".repeat(32));
    expect(q4.filter((hash) => Q3.includes(hash))).toEqual([]);
    expect(kept).toEqual({});
    // An address that isn't an export's ID asks nothing.
    storageSessionGet.mockClear();
    vi.stubGlobal("location", { pathname: "/full.html", search: "?save=../vault" });
    await expect(saveHandedExport({ state: setup().state })).rejects.toThrow();
    expect(storageSessionGet).not.toHaveBeenCalled();
    storageSessionSet.mockImplementation(async () => {});
    storageSessionGet.mockImplementation(async () => ({}));
    storageSessionRemove.mockImplementation(async () => {});
  });

  it("keeps nothing handed over when the tab couldn't open", async () => {
    page("/popup.html");
    setup();
    tabsCreate.mockRejectedValueOnce(new Error("Couldn't open a tab"));
    exportToggle().click();
    saveCsv().click();
    await settle();
    const [[items]] = storageSessionSet.mock.calls;
    expect(storageSessionRemove).toHaveBeenCalledWith(Object.keys(items)[0]);
    expect(close).not.toHaveBeenCalled();
    expect(fieldError()).toBe("Couldn't open a tab");
  });

  it("asks for an unlock first, in a tab that opened locked", async () => {
    page("/full.html");
    const id = "00000000-0000-4000-8000-000000000002";
    const key = `dusk_activity_export_v1:${id}`;
    vi.stubGlobal("location", { pathname: "/full.html", search: `?route=activity&save=${id}` });
    storageSessionGet.mockImplementationOnce(async () => ({ [key]: { id, choices: { period: "all" } } }));
    const tab = setup({ ov: { isUnlocked: false } });
    await saveHandedExport({ state: tab.state, render: tab.actions.render });
    expect(saved).toHaveLength(0);
    // Said: unlock first.
    expect(tab.state.activityExport.error).toMatch(/unlock/i);
  });
});

describe("A token in Activity's Export", () => {
  const TOKEN = "ab".repeat(32);
  const ASSET = { type: "DRC20", op: "transfer", symbol: "TKN", name: "Token", decimals: 9, driver: "drc20", valueUnits: "123456789100", to: FAUCET };
  // The wallet's record of a token's transfer, kept settled for what the chain's row lacks.
  const record = { hash: "b7".repeat(32), kind: TX_KIND.CONTRACT_CALL, privacy: "public", contractId: TOKEN, fnName: "transfer", amount: "0", deposit: "0", status: "executed", settled: true, submittedAt: AT, profileIndex: 0, asset: ASSET };
  // The chain's row of it: that the contract was called, with nothing moved.
  const called = { hash: record.hash, kind: "contract_call", direction: "out", counterparty: TOKEN, contractId: TOKEN, fnName: "transfer", value: "0", fee: "1850000", timestamp: AT, blockHeight: 4_650_000 };
  const lineOf = async (hash) => (await linesOf()).find((line) => line.TxHash === hash);

  it("is what it moved, to whom, in the file's own columns, with its fee, as the chain and the wallet say it", async () => {
    page("/full.html");
    setup({ ov: { txs: [record] }, entries: [called] });
    exportToggle().click();
    saveCsv().click();
    await settle();
    expect(await lineOf(record.hash)).toMatchObject({
      "Sent Amount": "123.4567891",
      "Sent Currency": "TKN",
      "Fee Amount": "0.00185",
      "Fee Currency": "DUSK",
      Tag: "",
      Counterparty: FAUCET,
      Description: `Transfer of TKN, contract ${TOKEN}`,
    });
  });

  it("goes by the user's contact name for its recipient, only when asked", async () => {
    page("/full.html");
    setup({ ov: { txs: [record] }, entries: [called], contacts: [{ name: "Faucet shop", address: FAUCET }] });
    exportToggle().click();
    choose("activity-export-contacts");
    saveCsv().click();
    await settle();
    expect((await lineOf(record.hash))["Counterparty Name"]).toBe("Faucet shop");
  });

  it("marks one to another of the person's profiles, which isn't income", async () => {
    page("/full.html");
    setup({ ov: { txs: [{ ...record, asset: { ...ASSET, to: SAVINGS } }] }, entries: [called] });
    exportToggle().click();
    saveCsv().click();
    await settle();
    expect(await lineOf(record.hash)).toMatchObject({ Counterparty: SAVINGS, "Internal Transfer": "yes", "Sent Currency": "TKN" });
  });
});
