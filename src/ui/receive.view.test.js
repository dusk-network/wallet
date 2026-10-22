import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lookupPrimaryName, lookupShieldedName } from "../shared/duskNames.js";
import { installFakeDom, isShown, settle } from "./testing/fakeDom.js";
import { receiveView } from "./popup/views/receive.js";

vi.mock("../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: vi.fn(),
  lookupShieldedName: vi.fn(),
}));

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const ADDRESS =
  "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";

const overview = {
  nodeUrl: "https://testnet.nodes.dusk.network",
  accounts: [ACCOUNT],
  addresses: [ADDRESS],
  selectedAccountIndex: 0,
};

let dom;

beforeEach(() => {
  dom = installFakeDom();
  lookupPrimaryName.mockReset();
  lookupShieldedName.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function receive(tab) {
  const state = { receive: { tab, requestOpen: false, amountDusk: "", memo: "" } };
  dom.document.body.replaceChildren(...receiveView(overview, { state, actions: { render: vi.fn(async () => {}) } }));
  await settle();
  const note = dom.document.body.querySelector(".receive-name-note");
  const card = dom.document.body.querySelector(".receive-chip");
  return { note, card, shown: isShown(note) ? note.textContent : "" };
}

describe("receive", () => {
  it("says who reaches the public account through its name, under the card", async () => {
    lookupPrimaryName.mockResolvedValue("alice.dusk");
    const { note, card, shown } = await receive("public");
    expect(shown).toBe("People who send to alice.dusk reach this public account.");
    const row = note.parentNode.children;
    expect(row.indexOf(note)).toBe(row.indexOf(card) + 1);
    expect(card.querySelector(".receive-chip-name").textContent).toBe("alice.dusk");
  });

  it("says the name also lists the shielded address when its record is that address", async () => {
    lookupShieldedName.mockResolvedValue("alice.dusk");
    const { shown } = await receive("shielded");
    expect(lookupShieldedName).toHaveBeenCalledWith(ACCOUNT, ADDRESS, { nodeUrl: overview.nodeUrl });
    expect(shown).toBe("alice.dusk also lists this address, so people can choose to pay you privately.");
  });

  it("shows no line without a name to show", async () => {
    lookupPrimaryName.mockResolvedValue(null);
    lookupShieldedName.mockResolvedValue(null);
    expect((await receive("public")).shown).toBe("");
    // The shielded tab names nothing when the name's record isn't this address.
    expect((await receive("shielded")).shown).toBe("");
  });
});
