import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { BRIDGE_CONTRACTS } from "../../shared/bridge.js";
import { TX_KIND } from "../../shared/constants.js";
import { CSV_COLUMNS, CSV_CONTACT_COLUMN, activityCsv, activityCsvFilename } from "./activityCsv.js";

process.env.TZ = "UTC";
beforeAll(() => vi.stubGlobal("navigator", { language: "en-GB" }));
afterAll(() => vi.unstubAllGlobals());

const NODE = "https://testnet.nodes.dusk.network";
const AT = Date.parse("2026-10-23T07:00:30Z");
const FAUCET = "26JfWKvhYdVY71bdSPVLNJ51Buy4GjimCT7zcsoxNQtydDbdoH2AwZaH8W7rjcAc9riAu39Vw9Lx1w7yrkBgotSjWmUdkSyQuaTKDZWVCKp9g1GxiEnnksv3W3onToB5NsNi";
const SENDER = "zFVXTQZfY6gB2rWZFEm4ToWY2NKrpgeswTboWMAe7cjzaqHjsdGuADp8GsYzeruRkP3ZozA34mhWedEHkEiUr73iv8EcK3A192Y5b2uQYxLgprkZ2u8WKZyfDuZiyy4yEuL";
const EVM = "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F";
const hash = (n) => String(n).repeat(64).slice(0, 64);

// Activity's rows, as activity.js merges them.
const ROWS = [
  // Received, from the chain, with a memo someone else wrote.
  { hash: hash(1), source: "archive", nodeUrl: NODE, kind: TX_KIND.TRANSFER, direction: "in", from: SENDER, counterparty: SENDER, amount: "1000000000000", memo: "=HYPERLINK(1), \"rent\"", timestamp: AT, blockHeight: 4658012, success: true, status: "executed" },
  // The wallet's own send, still pending, to a name typed for it.
  { hash: hash(2), source: "local", kind: TX_KIND.TRANSFER, privacy: "public", to: FAUCET, toName: "faucet.dusk", amount: "5000000000", submittedAt: AT, status: "submitted", profileIndex: 0 },
  // A call that failed: nothing moved, the fee paid.
  { hash: hash(3), source: "archive", nodeUrl: NODE, kind: TX_KIND.CONTRACT_CALL, direction: "out", contractId: "00".repeat(32), fnName: "convert", deposit: "2000000000", amount: "2000000000", timestamp: AT, blockHeight: 4658013, success: false, status: "failed", feePaid: "1856398" },
  // DUSK bridged to DuskEVM.
  { hash: hash(4), source: "archive", nodeUrl: NODE, kind: TX_KIND.CONTRACT_CALL, direction: "out", contractId: BRIDGE_CONTRACTS.testnet.bridge, counterparty: BRIDGE_CONTRACTS.testnet.bridge, fnName: "depositETHToWithValue", deposit: "500000000", amount: "500000000", bridgeTo: EVM, timestamp: AT, blockHeight: 4697290, success: true, status: "executed", feePaid: "1985878" },
  // Synced, its details not looked up yet.
  { hash: hash(5), source: "archive", nodeUrl: NODE, kind: TX_KIND.TRANSFER, direction: "out", to: FAUCET, counterparty: FAUCET, amount: "3000000000", blockHeight: 4658014, success: null, status: "unknown" },
  // Shielded, received.
  { hash: hash(6), source: "shielded", kind: TX_KIND.TRANSFER, direction: "in", privacy: "shielded", amount: "3000000000", timestamp: AT, status: "executed" },
];

const lines = (csv) => csv.split("\r\n");

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
      `2026-10-23T07:00:30.000Z,"Fri, 23 Oct 2026, 07:00 UTC",4658012,${hash(1)},in,Public,Received,,${SENDER},1000,,"'=HYPERLINK(1), ""rent""",Completed`,
      `2026-10-23T07:00:30.000Z,"Fri, 23 Oct 2026, 07:00 UTC",,${hash(2)},out,Public,faucet.dusk (Sent),faucet.dusk,${FAUCET},-5,,,Pending`,
      `2026-10-23T07:00:30.000Z,"Fri, 23 Oct 2026, 07:00 UTC",4658013,${hash(3)},out,Public,Call convert (Failed · nothing sent · fee 0.0019 DUSK paid),,${"00".repeat(32)},0,0.001856398,,Failed`,
      `2026-10-23T07:00:30.000Z,"Fri, 23 Oct 2026, 07:00 UTC",4697290,${hash(4)},out,Public,To 0xAB84…C86F (Bridge to DuskEVM),,${EVM},-0.5,0.001985878,,Completed`,
      `,,4658014,${hash(5)},out,Public,Sent,,${FAUCET},-3,,,Not looked up yet`,
      `2026-10-23T07:00:30.000Z,"Fri, 23 Oct 2026, 07:00 UTC",,${hash(6)},in,Shielded,Received (Shielded),,,3,,,Completed`,
    ]);
  });

  it("counts a call's amount and deposit apart in the wallet's own record, the chain's value as it is", () => {
    const CONTRACT = "cd".repeat(32);
    const call = (over) => ({ kind: TX_KIND.CONTRACT_CALL, contractId: CONTRACT, fnName: "pay", status: "submitted", submittedAt: AT, profileIndex: 0, ...over });
    const amountOf = (rows, opts = {}) => lines(activityCsv(rows, { nodeUrl: NODE, own: [SENDER], ...opts })).slice(1).map((l) => l.split(",").at(-4));
    // Sent: 2 DUSK to someone else, and 3 DUSK attached to the call.
    const pending = call({ hash: hash(7), source: "local", to: FAUCET, amount: "2000000000", deposit: "3000000000" });
    expect(amountOf([pending])).toEqual(["-5"]);
    // The amount back to the profile itself, with no recipient or its own: the deposit alone left.
    expect(amountOf([{ ...pending, to: undefined }, { ...pending, to: SENDER }])).toEqual(["-3", "-3"]);
    // The chain's record already says what left in one value, in a call's deposit too.
    const chain = { hash: hash(7), source: "archive", nodeUrl: NODE, kind: TX_KIND.CONTRACT_CALL, direction: "out", contractId: CONTRACT, fnName: "pay", amount: "5000000000", deposit: "5000000000", timestamp: AT, blockHeight: 9, success: true, status: "executed" };
    expect(amountOf([chain])).toEqual(["-5"]);
    // Both: the chain's once it settled, the wallet's own record until then.
    const both = { ...chain, ...pending, source: "both", amount: "2000000000", deposit: "3000000000", success: null, status: "unknown" };
    expect(amountOf([both], { local: [pending] })).toEqual(["-5"]);
    expect(amountOf([{ ...both, deposit: undefined }], { local: [pending] })).toEqual(["-5"]);
    expect(amountOf([{ ...chain, ...pending, source: "both", amount: "5000000000", deposit: "5000000000", success: true, status: "executed" }], { local: [pending] })).toEqual(["-5"]);
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
