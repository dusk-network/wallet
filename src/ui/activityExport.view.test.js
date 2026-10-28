import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BRIDGE_CONTRACTS } from "../shared/bridge.js";
import { TX_KIND } from "../shared/constants.js";
import { accessibleName, installFakeDom, settle, visibleText } from "./testing/fakeDom.js";
import { activityView } from "./popup/views/activityView.js";
import { activityKey } from "./popup/activity.js";
import { CSV_COLUMNS } from "./popup/activityCsv.js";
import { HANDED_EXPORT_KEY, saveHandedExport } from "./popup/activityExport.js";
import { runtimeGetURL, storageSessionGet, storageSessionRemove, storageSessionSet, tabsCreate } from "../platform/extensionApi.js";

vi.mock("../platform/extensionApi.js", async (importOriginal) => ({
  ...(await importOriginal()),
  runtimeGetURL: vi.fn((path) => `chrome-extension://wallet/${path}`),
  storageSessionGet: vi.fn(async () => ({})),
  storageSessionRemove: vi.fn(async () => {}),
  storageSessionSet: vi.fn(async () => {}),
  tabsCreate: vi.fn(async () => ({})),
}));

process.env.TZ = "UTC";
const NOW = new Date("2026-10-23T09:00:00Z");
const NODE = "https://testnet.nodes.dusk.network";
const ACCOUNT = "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const FAUCET = "26JfWKvhYdVY71bdSPVLNJ51Buy4GjimCT7zcsoxNQtydDbdoH2AwZaH8W7rjcAc9riAu39Vw9Lx1w7yrkBgotSjWmUdkSyQuaTKDZWVCKp9g1GxiEnnksv3W3onToB5NsNi";
const EVM = "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F";
const AT = Date.parse("2026-10-23T07:00:30Z");

// The wallet's own: a send, and DUSK bridged to DuskEVM.
const LOCAL = [
  { hash: "a1".repeat(32), kind: TX_KIND.TRANSFER, privacy: "public", to: FAUCET, toName: "faucet.dusk", amount: "5000000000", status: "executed", submittedAt: AT, profileIndex: 0 },
  {
    hash: "a2".repeat(32),
    kind: TX_KIND.CONTRACT_CALL,
    contractId: BRIDGE_CONTRACTS.testnet.bridge,
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

let dom;
let saved;
function page(pathname) {
  dom = installFakeDom({ pathname });
  dom.document.body.className = pathname === "/popup.html" ? "page--popup" : "page--full";
  vi.stubGlobal("history", { state: null, replaceState: vi.fn() });
  vi.stubGlobal("close", vi.fn());
  // What a download saves: the link's file name and the file.
  saved = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    saved.push({ blob });
    return "blob:activity";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  dom.document.addEventListener("click", (e) => {
    if (e.target?.localName === "a" && e.target.getAttribute("download")) saved.at(-1).name = e.target.getAttribute("download");
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Activity, drawn again by every render as app.js does.
function setup({ contacts = [] } = {}) {
  const ov = { isUnlocked: true, nodeUrl: NODE, networkName: "Testnet", accounts: [ACCOUNT], selectedAccountIndex: 0, txs: LOCAL };
  const state = {
    route: "activity",
    addressBook: { loaded: true, items: contacts },
    activity: { key: activityKey(ov), account: ACCOUNT, nodeUrl: NODE, entries: [], names: new Map(), loaded: true, complete: true, limit: 50 },
  };
  const actions = { render: vi.fn(async () => draw()), showToast: vi.fn() };
  const draw = () => dom.document.body.replaceChildren(...activityView(ov, { state, actions }));
  draw();
  return { state, actions };
}

const body = () => dom.document.body;
const button = (name) => body().querySelectorAll("button").find((b) => visibleText(b).trim() === name || accessibleName(b) === name);
const csvLines = async (i = 0) => (await saved[i].blob.text()).split("\r\n");

describe("Activity's Export", () => {
  it("opens under the head: the contact names choice, what the file holds, and Save CSV", () => {
    page("/full.html");
    setup();
    const toggle = button("Export");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(body().querySelector("#activity-export")).toBeNull();
    toggle.click();
    expect(button("Export").getAttribute("aria-expanded")).toBe("true");
    const panel = body().querySelector("#activity-export");
    expect(visibleText(panel)).toBe(
      "Include my contact names in the export, in their own column" +
        "An export holds the rows listed, with memos and .dusk names, and dates in UTC and local time." +
        "Save CSV"
    );
    // Before the list and its filters.
    expect(body().querySelector(".activity-page").children[0]).toBe(panel);
  });

  it("saves the rows listed in the full view, the user's contact names only when asked", async () => {
    page("/full.html");
    const { state, actions } = setup({ contacts: [{ name: "Faucet (test)", address: FAUCET }] });
    button("Export").click();
    button("Save CSV").click();
    await settle();
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe("dusk-activity-testnet-profile-1-2026-10-23.csv");
    expect(saved[0].blob.type).toBe("text/csv;charset=utf-8");
    const [head, ...rows] = await csvLines();
    expect(head).toBe(CSV_COLUMNS.join(","));
    expect(rows).toHaveLength(3);
    expect(rows.join("\n")).not.toContain("Faucet (test)");
    expect(rows[1]).toContain(`To 0xAB84…C86F (Bridge to DuskEVM),,${EVM},-0.5,`);
    expect(actions.showToast).toHaveBeenCalledWith("CSV saved");
    expect(body().querySelector("#activity-export")).toBeNull();

    // Sent only, with the contact names.
    button("Sent").click();
    button("Export").click();
    const box = body().querySelector("#activity-export-contacts");
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    expect(state.activityExport.withContacts).toBe(true);
    button("Save CSV").click();
    await settle();
    const [head2, ...sent] = await csvLines(1);
    expect(head2.endsWith(",Your contact name")).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[0].endsWith(",Faucet (test)")).toBe(true);
  });

  it("is off with no rows listed, and says which rows aren't looked up yet", () => {
    page("/full.html");
    const { state } = setup();
    state.activityFilter = "staking";
    button("Export").click();
    expect(button("Save CSV").disabled).toBe(true);
    // A synced row without its details.
    state.activityFilter = "all";
    state.activity.entries = [{ hash: "b1".repeat(32), blockHeight: 7, direction: "in", kind: TX_KIND.TRANSFER, counterparty: FAUCET, value: 5n, success: null }];
    button("Export").click();
    button("Export").click();
    expect(visibleText(body().querySelector("#activity-export"))).toContain('A row has no date or fee yet. The export marks it "Not looked up yet".');
  });

  it("hands the popup's file to a new full view tab, which saves it once", async () => {
    page("/popup.html");
    setup();
    button("Export").click();
    expect(visibleText(body().querySelector("#activity-export"))).toContain("The file is saved from a new tab.");
    button("Save CSV").click();
    await settle();
    // The popup saves nothing itself: the file goes to the tab it opens.
    expect(saved).toHaveLength(0);
    const [[items]] = storageSessionSet.mock.calls;
    const handed = items[HANDED_EXPORT_KEY];
    expect(handed).toMatchObject({ filename: "dusk-activity-testnet-profile-1-2026-10-23.csv" });
    expect(handed.csv.split("\r\n")).toHaveLength(4);
    expect(runtimeGetURL).toHaveBeenCalledWith(`full.html?route=activity&save=${handed.id}`);
    expect(tabsCreate).toHaveBeenCalledWith({ url: `chrome-extension://wallet/full.html?route=activity&save=${handed.id}` });
    expect(close).toHaveBeenCalled();

    // The tab: it saves the file, forgets it, and takes the request off its address.
    page("/full.html");
    vi.stubGlobal("location", { pathname: "/full.html", search: `?route=activity&save=${handed.id}` });
    storageSessionGet.mockResolvedValueOnce({ [HANDED_EXPORT_KEY]: handed });
    await expect(saveHandedExport()).resolves.toBe(handed.filename);
    expect(saved.map((s) => s.name)).toEqual([handed.filename]);
    expect(await csvLines()).toEqual(handed.csv.split("\r\n"));
    expect(storageSessionRemove).toHaveBeenCalledWith(HANDED_EXPORT_KEY);
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/full.html?route=activity");

    // Opened without one: nothing. With one gone: it says so.
    vi.stubGlobal("location", { pathname: "/full.html", search: "?route=activity" });
    await expect(saveHandedExport()).resolves.toBeNull();
    vi.stubGlobal("location", { pathname: "/full.html", search: "?save=old" });
    await expect(saveHandedExport()).rejects.toThrow("The export isn't here any more. Export it again.");
    expect(saved).toHaveLength(1);
  });

  it("keeps nothing handed over when the tab couldn't open", async () => {
    page("/popup.html");
    const { actions } = setup();
    tabsCreate.mockRejectedValueOnce(new Error("Couldn't open a tab"));
    button("Export").click();
    button("Save CSV").click();
    await settle();
    expect(storageSessionRemove).toHaveBeenCalledWith(HANDED_EXPORT_KEY);
    expect(close).not.toHaveBeenCalled();
    expect(actions.showToast).toHaveBeenCalledWith("Couldn't open a tab", 2500);
  });
});

describe("DUSK bridged to DuskEVM in Activity", () => {
  it("shows under Sent, To its DuskEVM address, with Copy", async () => {
    page("/full.html");
    const { state } = setup();
    button("Sent").click();
    expect(state.activityFilter).toBe("sent");
    const rows = body().querySelectorAll(".tx-row");
    expect(rows.map(visibleText)).toEqual(["faucet.duskSent · 07:00−5 DUSK", "To 0xAB84…C86FBridge to DuskEVM · 07:00−0.5 DUSK"]);
    const name = rows[1].querySelector(".tx-name");
    expect([name.querySelector(".mono").textContent, name.getAttribute("title")]).toEqual(["0xAB84…C86F", EVM]);
    const copy = rows[1].querySelector("button.tx-copy");
    expect(accessibleName(copy)).toBe("Copy DuskEVM address");
    copy.click();
    await settle();
    expect(dom.clipboard.writeText).toHaveBeenLastCalledWith(EVM);
    button("Received").click();
    expect(body().querySelectorAll(".tx-row").map(visibleText)).toEqual(["26JfWK…B5NsNiReceived · 07:00+1 DUSK"]);
  });
});
