import { networks } from "@dusk-network/networks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BRIDGE_CONTRACTS } from "../shared/bridge.js";
import releases from "../shared/dusk-domains-releases.json";
import { TX_KIND } from "../shared/constants.js";
import { installFakeDom, settle, visibleText } from "./testing/fakeDom.js";
import { txDetailsView } from "./popup/views/txDetails.js";

const HASH = "ab".repeat(32);
const NODE = "https://testnet.nodes.dusk.network";

let dom;

beforeEach(() => {
  dom = installFakeDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Renders a transaction's details as the popup does.
function details(tx, { contacts = [] } = {}) {
  const state = { route: "tx", txDetailHash: HASH, txDetailFrom: "home", addressBook: { loaded: true, items: contacts } };
  const actions = { render: vi.fn(async () => {}), showToast: vi.fn() };
  const ov = { nodeUrl: NODE, txs: [{ hash: HASH, nodeUrl: NODE, ...tx }] };
  dom.document.body.replaceChildren(...txDetailsView(ov, { state, actions }));
  const body = dom.document.body;
  return {
    name: visibleText(body.querySelector(".tx-hero-name")),
    lead: body.querySelector(".tx-hero-lead"),
    status: visibleText(body.querySelector(".tx-hero-status")),
    note: body.querySelector(".tx-hero-note") ? visibleText(body.querySelector(".tx-hero-note")) : "",
    rows: body.querySelectorAll(".tx-detail > .group > .kv").map(visibleText),
    body,
  };
}

describe("transaction details", () => {
  it("names the type once, and adds a note only where the status needs one", () => {
    const shield = { kind: TX_KIND.SHIELD, amount: "1000000000", profileIndex: 0 };
    let view = details({ ...shield, status: "mempool" });
    expect([view.name, view.lead, view.status, view.note]).toEqual([
      "Shield",
      null,
      "Pending",
      "Still waiting to go through. Don't retry yet.",
    ]);
    // Where it moved, from the profile's public balance to its shielded one.
    expect(view.rows.slice(0, 2)).toEqual(["FromProfile 1 · Public", "ToProfile 1 · Shielded"]);

    view = details({ ...shield, status: "unknown" });
    expect([view.status, view.note]).toEqual(["Not confirmed", "The wallet stopped waiting for a result. That doesn't mean it failed."]);
    view = details({ ...shield, status: "removed", privacy: "shielded" });
    expect([view.status, view.note]).toEqual([
      "Dropped",
      "The network dropped it before it ran, so no fee was charged. The 1 DUSK stayed in your wallet. Shielded funds may still be reserved locally.",
    ]);
    view = details({ ...shield, status: "submitted" });
    expect([view.status, view.note]).toEqual(["Pending", "Waiting for a block, usually about 10 seconds."]);
    // Completed says it all.
    view = details({ ...shield, status: "executed" });
    expect([view.status, view.note]).toEqual(["Completed", ""]);
  });

  it("names the contract a call went to under Technical details only, with Copy, and offers no Add token or Import NFT", async () => {
    const contractId = "cd".repeat(32);
    const view = details({
      kind: TX_KIND.CONTRACT_CALL,
      contractId: `0x${contractId}`,
      fnName: "transfer",
      status: "executed",
    });
    expect(view.name).toBe("Call transfer");
    expect(view.body.querySelector(".tx-hero-addr")).toBeNull();
    const contract = view.body.querySelectorAll(".tx-tech .kv").find((row) => row.querySelector(".kv-label").textContent === "Contract");
    // As every Dusk app writes a contract ID: without 0x.
    expect(visibleText(contract)).toBe("Contractcdcdcd…cdcdcd");
    const copy = contract.querySelector("button");
    expect(copy.getAttribute("aria-label")).toBe("Copy contract ID");
    copy.click();
    await settle();
    expect(dom.clipboard.writeText).toHaveBeenCalledWith(contractId);
    expect(view.body.querySelector(".tx-assets")).toBeNull();
    expect(view.body.querySelectorAll("button").map((b) => b.textContent)).not.toEqual(expect.arrayContaining(["Add token"]));
    expect(view.body.querySelectorAll("button").map((b) => b.textContent)).not.toEqual(expect.arrayContaining(["Import NFT"]));
  });

  it("names a call's contract as the network's file does, in the title and beside its ID", () => {
    const { pool } = networks.testnet.sozu.fallbacks;
    const view = details({ kind: TX_KIND.CONTRACT_CALL, contractId: pool, fnName: "exchange_rate", status: "executed" });
    expect([visibleText(view.lead), view.name]).toEqual(["Sozu pool", "Call exchange_rate"]);
    const contract = view.body.querySelectorAll(".tx-tech .kv").find((row) => row.querySelector(".kv-label").textContent === "Contract");
    expect(visibleText(contract)).toBe(`ContractSozu pool · ${pool.slice(0, 6)}…${pool.slice(-6)}`);
  });

  it("says what a Dusk Domains call did, on its own network", () => {
    // The testnet release's store contract, where names are registered.
    const STORE = releases.testnet.contracts.find((c) => c.role === "store").contractId;
    const register = details({ kind: TX_KIND.CONTRACT_CALL, contractId: STORE, fnName: "register", deposit: "10000000000", status: "executed" });
    expect([visibleText(register.lead), register.name]).toEqual(["Dusk Domains", "Registered a .dusk name"]);
    expect(visibleText(register.body.querySelector(".tx-hero-amount"))).toBe("−10 DUSK");
    // By the name it registered, once read; its contract under Technical details alone.
    const named = details({ kind: TX_KIND.CONTRACT_CALL, contractId: STORE, fnName: "register", registeredName: "alice.dusk", status: "executed" });
    expect([named.name, named.body.querySelector(".tx-hero-addr")]).toEqual(["Registered alice.dusk", null]);
    const commit = details({ kind: TX_KIND.CONTRACT_CALL, contractId: STORE, fnName: "commit", status: "executed" });
    expect(commit.name).toBe("Reserved a .dusk name");
    // The same contract ID through a custom node is any contract.
    const ov = { nodeUrl: "https://node.example", txs: [{ hash: HASH, nodeUrl: "https://node.example", kind: TX_KIND.CONTRACT_CALL, contractId: STORE, fnName: "register", status: "executed" }] };
    dom.document.body.replaceChildren(...txDetailsView(ov, { state: { route: "tx", txDetailHash: HASH, addressBook: { loaded: true, items: [] } }, actions: {} }));
    expect(visibleText(dom.document.body.querySelector(".tx-hero-name"))).toBe("Call register");
  });

  it("says where a deposit to DuskEVM went, read from the call the wallet approved", () => {
    const evm = "0x5A3d8e1B7c2f4A6b9e0D1C3f5A7b9C2D4e6F8a01";
    const deposit = {
      kind: TX_KIND.CONTRACT_CALL,
      contractId: BRIDGE_CONTRACTS.testnet.bridge,
      fnName: "depositETHToWithValue",
      amount: "0",
      deposit: "500000000",
      status: "executed",
    };
    const view = details({ ...deposit, bridgeTo: evm });
    // "To" the DuskEVM address, Copy beside it, and in full with Copy in the rows.
    expect([visibleText(view.lead), view.name]).toEqual(["Bridge to DuskEVM", "To 0x5A3d…8a01"]);
    expect(view.body.querySelector(".tx-hero-name .mono").textContent).toBe("0x5A3d…8a01");
    expect(view.body.querySelector(".tx-hero-name").getAttribute("title")).toBe(evm);
    expect(view.body.querySelector(".tx-hero-name-line button").getAttribute("aria-label")).toBe("Copy DuskEVM address");
    expect(view.body.querySelector(".tx-hero-addr")).toBeNull();
    expect(view.rows).toContain(`DuskEVM recipient${evm}Copy`);
    expect(view.body.querySelector(".tx-evm-recipient button").getAttribute("aria-label")).toBe("Copy DuskEVM address");
    // Without it, no recipient row; the bridge's contract is under Technical details.
    const old = details(deposit);
    expect(old.body.querySelector(".tx-hero-addr")).toBeNull();
    expect(old.rows.filter((r) => r.startsWith("DuskEVM recipient"))).toEqual([]);
  });

  it("leads with a saved contact's own name, its .dusk name beside the address", () => {
    const to = "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";
    const send = { kind: TX_KIND.TRANSFER, direction: "out", to, toName: "wallet-both.dusk", amount: "500000000", status: "executed" };
    const view = details(send, { contacts: [{ name: "Jan (flour)", address: to }] });
    expect(view.name).toBe("Jan (flour)");
    expect(visibleText(view.body.querySelector(".tx-hero-addr"))).toBe(`wallet-both.dusk · ${to.slice(0, 6)}…${to.slice(-6)}`);
    // Without the contact, the .dusk name leads.
    expect(details(send).name).toBe("wallet-both.dusk");
  });

  it("shows the exact fee under Technical details, the summary's rounded", () => {
    const send = { kind: TX_KIND.TRANSFER, amount: "1000000000", status: "executed", feePaid: "1856398", gasSpent: "1856398", gasPrice: "1", gasLimit: "2500000" };
    const view = details(send);
    expect(view.rows).toContain("Network fee0.0019 DUSK");
    const tech = view.body.querySelectorAll(".tx-tech .kv").map(visibleText);
    expect(tech).toContain("Exact fee0.001856398 DUSK");
    expect(tech).toContain("Gas used1,856,398 of 2,500,000");
    // None charged, none shown.
    expect(details({ ...send, feePaid: "0" }).body.querySelectorAll(".tx-tech .kv").map(visibleText).filter((r) => r.startsWith("Exact fee"))).toEqual([]);
  });

  it("names the site a transaction came from, and none for the wallet's own", () => {
    const send = { kind: TX_KIND.TRANSFER, amount: "1000000000", status: "executed" };
    expect(details({ ...send, origin: "https://shop.example" }).rows).toContain("Siteshop.example");
    expect(details({ ...send, origin: "http://127.0.0.1:5354" }).rows).toContain("Sitehttp://127.0.0.1:5354");
    for (const origin of ["Wallet", undefined]) {
      expect(details({ ...send, origin }).rows.filter((r) => r.startsWith("Site")), String(origin)).toEqual([]);
    }
  });

  it("says when a transaction isn't in Activity, and still opens it in the explorer", () => {
    const state = { route: "tx", txDetailHash: "ef".repeat(32), txDetailFrom: "home" };
    dom.document.body.replaceChildren(...txDetailsView({ nodeUrl: NODE, txs: [] }, { state, actions: {} }));
    expect(visibleText(dom.document.body)).toBe(
      "← BackTransactionThis transaction isn't in your activity.Transaction IDefefef…efefefView in Dusk explorer"
    );
  });
});
