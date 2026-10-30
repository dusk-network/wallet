import { duskEvmContracts } from "@dusk-network/networks/duskevm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TX_KIND } from "../../shared/constants.js";
import { rowsOf } from "../../shared/fixtures/rows.js";
import { CSV_COLUMNS, CSV_CONTACT_COLUMN, activityCsv, activityCsvFilename } from "./activityCsv.js";

process.env.TZ = "UTC";
beforeAll(() => vi.stubGlobal("navigator", { language: "en-GB" }));
afterAll(() => vi.unstubAllGlobals());
// A second after the sends: the wallet's own still waits for the chain.
beforeAll(() => vi.useFakeTimers({ now: Date.parse("2026-10-23T07:00:31Z"), toFake: ["Date"] }));
afterAll(() => vi.useRealTimers());

const NODE = "https://testnet.nodes.dusk.network";
const AT = Date.parse("2026-10-23T07:00:30Z");
const FAUCET = "26JfWKvhYdVY71bdSPVLNJ51Buy4GjimCT7zcsoxNQtydDbdoH2AwZaH8W7rjcAc9riAu39Vw9Lx1w7yrkBgotSjWmUdkSyQuaTKDZWVCKp9g1GxiEnnksv3W3onToB5NsNi";
const SENDER = "zFVXTQZfY6gB2rWZFEm4ToWY2NKrpgeswTboWMAe7cjzaqHjsdGuADp8GsYzeruRkP3ZozA34mhWedEHkEiUr73iv8EcK3A192Y5b2uQYxLgprkZ2u8WKZyfDuZiyy4yEuL";
const EVM = "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F";
const hash = (n) => String(n).repeat(64).slice(0, 64);

// Activity's rows, as activity.js merges them, each from its own source.
const rowsOfEach = () => [
  // Received, from the chain, with a memo someone else wrote.
  { entries: [{ hash: hash(1), direction: "in", counterparty: SENDER, payer: false, value: "1000000000000", memo: "=HYPERLINK(1), \"rent\"", timestamp: AT, blockHeight: 4658012 }] },
  // The wallet's own send, still pending, to a name typed for it.
  { txs: [{ hash: hash(2), kind: TX_KIND.TRANSFER, privacy: "public", to: FAUCET, toName: "faucet.dusk", amount: "5000000000", submittedAt: AT, status: "submitted", profileIndex: 0 }] },
  // A call that failed: nothing moved, the fee paid.
  { entries: [{ hash: hash(3), kind: TX_KIND.CONTRACT_CALL, contractId: "00".repeat(32), fnName: "convert", value: "2000000000", timestamp: AT, blockHeight: 4658013, success: false, fee: "1856398" }] },
  // DUSK bridged to DuskEVM.
  {
    entries: [
      {
        hash: hash(4),
        kind: TX_KIND.CONTRACT_CALL,
        contractId: duskEvmContracts(2).bridge,
        counterparty: duskEvmContracts(2).bridge,
        fnName: "depositETHToWithValue",
        value: "500000000",
        bridge: { amount: "500000000", kind: "deposit", to: EVM },
        timestamp: AT,
        blockHeight: 4697290,
        fee: "1985878",
      },
    ],
  },
  // Synced, its details not looked up yet.
  { entries: [{ hash: hash(5), counterparty: FAUCET, value: "3000000000", blockHeight: 4658014, detailsAt: undefined, success: undefined, timestamp: undefined }] },
  // Shielded, received.
  { shielded: [{ hash: hash(6), blockHeight: 4658015, direction: "in", kind: TX_KIND.TRANSFER, value: "3000000000", fee: null, success: true, timestamp: AT }] },
].map((input) => rowsOf(input)[0]);
let ROWS = [];
beforeAll(() => {
  ROWS = rowsOfEach();
});

const lines = (csv) => csv.split("\r\n");

describe("DUSK bridged through a route's account", () => {
  it("is a bridge transfer, the bridge's account its counterparty", async () => {
    const { networks, routes } = await import("@dusk-network/networks");
    const MAINNET = "https://nodes.dusk.network";
    const bsc = routes(networks.mainnet).find((route) => route.kind === "service").account;
    const sent = { hash: hash(8), kind: TX_KIND.TRANSFER, privacy: "public", to: bsc, memo: EVM, amount: "2000000000", submittedAt: AT, status: "executed", profileIndex: 0 };
    const [, row] = lines(activityCsv(rowsOf({ txs: [sent] }, { nodeUrl: MAINNET }), { nodeUrl: MAINNET }));
    expect(row).toBe(`2026-10-23T07:00:30.000Z,"Fri 23 Oct 2026, 07:00 UTC",,${hash(8)},out,Public,To BNB Smart Chain (Bridge),,${bsc},-2,,${EVM},Completed`);
  });
});

describe("Activity's CSV", () => {
  it("has the web wallet's History columns, by the same names", () => {
    expect(CSV_COLUMNS).toEqual([
      "Date (UTC)",
      "Date (local)",
      "Block",
      "Transaction ID",
      "Direction",
      "Type",
      "What",
      "Counterparty name",
      "Counterparty",
      "Amount (DUSK)",
      "Fee paid (DUSK)",
      "Memo",
      "Status",
    ]);
    expect(lines(activityCsv([]))).toEqual([CSV_COLUMNS.join(",")]);
  });

  it("writes each row as the web wallet does: exact amounts, a minus for what left, a failed one's fee alone", () => {
    const [, ...rows] = lines(activityCsv(ROWS, { nodeUrl: NODE }));
    expect(rows).toEqual([
      `2026-10-23T07:00:30.000Z,"Fri 23 Oct 2026, 07:00 UTC",4658012,${hash(1)},in,Public,Received,,${SENDER},1000,,"'=HYPERLINK(1), ""rent""",Completed`,
      `2026-10-23T07:00:30.000Z,"Fri 23 Oct 2026, 07:00 UTC",,${hash(2)},out,Public,faucet.dusk (Sent),faucet.dusk,${FAUCET},-5,,,Pending`,
      `2026-10-23T07:00:30.000Z,"Fri 23 Oct 2026, 07:00 UTC",4658013,${hash(3)},out,Public,Call convert (Failed · nothing sent · fee 0.0019 DUSK paid),,${"00".repeat(32)},0,0.001856398,,Failed`,
      `2026-10-23T07:00:30.000Z,"Fri 23 Oct 2026, 07:00 UTC",4697290,${hash(4)},out,Public,To 0xAB84…C86F (Bridge to DuskEVM),,${EVM},-0.5,0.001985878,,Completed`,
      `,,4658014,${hash(5)},out,Public,Sent,,${FAUCET},-3,,,Not looked up yet`,
      `2026-10-23T07:00:30.000Z,"Fri 23 Oct 2026, 07:00 UTC",4658015,${hash(6)},in,Shielded,Received (Shielded),,,3,,,Completed`,
    ]);
  });

  it("writes a contract a site called by its ID as every Dusk app does, without the 0x the site sent", () => {
    const CONTRACT = "cd".repeat(32);
    const call = { hash: hash(8), kind: TX_KIND.CONTRACT_CALL, contractId: `0x${CONTRACT.toUpperCase()}`, fnName: "pay", status: "submitted", submittedAt: AT, profileIndex: 0 };
    const counterparty = lines(activityCsv(rowsOf({ txs: [call] }), { nodeUrl: NODE }))[1].split(",").at(-5);
    expect(counterparty).toBe(CONTRACT);
  });

  it("adds the user's contact names in a column of their own only when asked, never in the words", () => {
    const contactName = (address) => ({ [FAUCET]: "Faucet (test)", [SENDER]: "@landlord" })[address] ?? "";
    const without = activityCsv(ROWS, { nodeUrl: NODE, contactName });
    expect(without).not.toContain("Faucet (test)");
    expect(without).not.toContain(CSV_CONTACT_COLUMN);

    const [head, ...rows] = lines(activityCsv(ROWS, { nodeUrl: NODE, contactName, withContacts: true }));
    expect(head).toBe([...CSV_COLUMNS, "Your contact name"].join(","));
    // The last column: the contact's name, a formula never; none for an EVM address.
    expect(rows.map((row) => row.slice(row.lastIndexOf(",") + 1))).toEqual(["'@landlord", "Faucet (test)", "", "", "Faucet (test)", ""]);
    expect(rows[1]).toContain(",faucet.dusk (Sent),faucet.dusk,");
  });

  it("is named for the network, the profile and the day", () => {
    const day = new Date(2026, 9, 28, 23, 30);
    expect(activityCsvFilename({ networkName: "Testnet", profileIndex: 0 }, day)).toBe("dusk-activity-testnet-profile-1-2026-10-28.csv");
    expect(activityCsvFilename({ networkName: "Mainnet", profileIndex: 1 }, day)).toBe("dusk-activity-mainnet-profile-2-2026-10-28.csv");
    expect(activityCsvFilename({ networkName: "My node / 1", profileIndex: "x" }, day)).toBe("dusk-activity-my-node-1-profile-1-2026-10-28.csv");
    expect(activityCsvFilename({}, day)).toBe("dusk-activity-wallet-profile-1-2026-10-28.csv");
  });
});
