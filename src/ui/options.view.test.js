import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RECOVERY_WORDS_MISMATCH } from "@dusk-network/app-core/recovery-words";
import { setAccountName } from "../shared/accountNames.js";
import { clearAddressBook, listAddressBook } from "../shared/addressBook.js";
import { endpointProblem } from "../shared/securityPolicy.js";
import { HOLD_TO_SHOW_TEXT } from "./lib/pageAway.js";
import { accessibleName, fakeEvent, installFakeDom, isShown, screenReaderText, settle, typeInto, visibleText } from "./testing/fakeDom.js";

vi.mock("../shared/accountNames.js", () => ({ setAccountName: vi.fn(async () => {}) }));
vi.mock("../shared/addressBook.js", () => ({ clearAddressBook: vi.fn(async () => {}), listAddressBook: vi.fn(async () => []) }));
// The first profile has a verified .dusk name, as the header shows it.
vi.mock("../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: vi.fn(async (account) => (account.startsWith("26FCH7") ? "alice.dusk" : null)),
  // Whose each .dusk name in a name is: none looked up, unless a test says.
  duskNameOwners: vi.fn(async () => new Map()),
}));

const ACCOUNTS = [
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927",
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz",
];

let dom;

beforeEach(() => {
  dom = installFakeDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// Settings as the extension draws it, where dApps connect; `{ app: true }`
// as the desktop app does, with no extension around it.
async function settings(over = {}, { app = false } = {}) {
  vi.stubGlobal(
    "browser",
    app
      ? undefined
      : {
          runtime: { id: "dusk-wallet", sendMessage: () => {}, getManifest: () => ({ version: "0.3.0" }) },
          tabs: { create: vi.fn(async () => ({})) },
        }
  );
  vi.resetModules();
  const { optionsView } = await import("./popup/views/options.js");
  const ov = {
    isUnlocked: true,
    accounts: ACCOUNTS,
    accountCount: 2,
    selectedAccountIndex: 0,
    nodeUrl: "https://testnet.nodes.dusk.network",
    permissions: [],
    ...over,
  };
  const state = { route: "options", overview: ov };
  const actions = { send: vi.fn(async () => ({})), render: vi.fn(async () => {}), showToast: vi.fn(), renderHeader: vi.fn() };
  const draw = () => dom.document.body.replaceChildren(...optionsView(ov, { state, actions }));
  draw();
  await settle();
  const section = (title) =>
    dom.document.body
      .querySelectorAll(".settings-section")
      .find((s) => {
        const head = s.querySelector(".bracket-title__text");
        return head && screenReaderText(head) === title;
      });
  return { ov, state, actions, draw, section };
}

// A screen's main button, whatever it says: the primary or destructive one shown.
const mainButton = (root) => root.querySelectorAll("button.btn-primary, button.btn-destructive").find(isShown);
// The errors a screen shows.
const shownErrors = (root) => root.querySelectorAll(".field-error").filter(isShown).map((el) => el.textContent).filter(Boolean);
// The error shown under a field, as the field is described by it.
const errorOf = (field) =>
  (field.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => dom.document.getElementById(id))
    .filter((el) => el?.classList.contains("field-error") && isShown(el))
    .map((el) => el.textContent)
    .join("");
// A figure exactly as written: not inside a longer number, not signed or bounded unless written so, and not followed by
// more digits, letters or a decimal part (1.0025 ≠ 11.0025, 0.005 ≠ −0.005, 2,000,000 ≠ 2,000,000.5, BNB ≠ BNBX).
const exactly = (text) => new RegExp(`(?<![\\d.,+\\-−<>≤≥~])${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\dA-Za-z]|[.,]\\d)`);
// A site's row in Settings, connected or earlier, by its host.
const siteRow = (host) => dom.document.body.querySelectorAll(".settings-site").find((row) => visibleText(row.querySelector(".settings-site__host")) === host);
// The row in Security that opens `route`, whatever it's called: each row pressed until one does.
const rowTo = (view, route) =>
  view
    .section("Security")
    .querySelectorAll(".settings-row")
    .find((row) => {
      const from = view.state.route;
      row.click();
      const opens = view.state.route === route;
      view.state.route = from;
      return opens;
    });

describe("profile names", () => {
  const label = (n) => dom.document.body.querySelectorAll("input").find((i) => accessibleName(i) === `Profile ${n} name`);

  it("keep a label typed for one wallet to that wallet: another opened meanwhile saves nothing of it", async () => {
    setAccountName.mockClear();
    const view = await settings();
    typeInto(label(1), "Typed for A");
    // Another window opens wallet B; Settings is drawn again for it.
    Object.assign(view.ov, { accounts: ["B-account-0", "B-account-1"], accountNames: { 0: "Bob" } });
    view.draw();
    expect(label(1).value).toBe("Bob");
    label(1).dispatchEvent(fakeEvent("blur"));
    await settle();
    expect(setAccountName).not.toHaveBeenCalled();
  });

  it("refuse a name with hidden characters, saying so under its field, and save nothing", async () => {
    // Marek's override, which made a contact read as "Profile 2": a profile's own name can't hold one either.
    setAccountName.mockClear();
    const view = await settings();
    const shownError = () => {
      const id = label(2).getAttribute("aria-describedby");
      return id ? dom.document.getElementById(id).textContent : "";
    };
    typeInto(label(2), "\u202eecilA");
    label(2).dispatchEvent(fakeEvent("blur"));
    await settle();
    expect(setAccountName).not.toHaveBeenCalled();
    // Refused for what it hides.
    expect(shownError()).toMatch(/hidden/i);
    expect(view.actions.showToast).not.toHaveBeenCalled();

    typeInto(label(2), "Savings");
    expect(shownError()).toBe("");
    label(2).dispatchEvent(fakeEvent("blur"));
    await settle();
    expect(setAccountName).toHaveBeenCalledWith(ACCOUNTS[0], 1, "Savings");
  });

  // Lena's: Profile 2 named after a contact read as that contact in History.
  it("refuse a name that is, or looks like, another profile's or a contact's, saying whose, and let a profile keep its own", async () => {
    const MARTA = "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";
    listAddressBook.mockResolvedValue([
      { id: "c1", name: "Marta", address: MARTA },
      // A contact saved with the second profile's own account.
      { id: "c2", name: "Spending", address: ACCOUNTS[1] },
    ]);
    setAccountName.mockClear();
    await settings();
    const shownError = (n) => {
      const id = label(n).getAttribute("aria-describedby");
      return id ? dom.document.getElementById(id).textContent : "";
    };
    // Each refused under its field, by whose name it is or looks like.
    for (const [n, typed, whose] of [
      // The first profile goes by its verified .dusk name, the second by its default one.
      [2, "alice.dusk", "alice.dusk"],
      [1, "Profile 2", "Profile 2"],
      // Sofía's: the first profile by its own name too, and its .dusk name in look-alike letters (a Cyrillic а).
      [2, "Profile 1", "Profile 1"],
      [2, "\u0430lice.dusk", "alice.dusk"],
      [2, "Marta", "Marta"],
      // A Cyrillic М.
      [2, "\u041carta", "Marta"],
    ]) {
      typeInto(label(n), typed);
      label(n).dispatchEvent(fakeEvent("blur"));
      await settle();
      expect(shownError(n), typed).toMatch(exactly(whose));
    }
    expect(setAccountName).not.toHaveBeenCalled();

    // Its own name, and the name of a contact saved with its own account, are the profile's to take.
    typeInto(label(2), "Spending");
    label(2).dispatchEvent(fakeEvent("blur"));
    await settle();
    expect([shownError(2), setAccountName.mock.calls.at(-1)]).toEqual(["", [ACCOUNTS[0], 1, "Spending"]]);
    listAddressBook.mockResolvedValue([]);
  });

  // Marek's: Profile 2 named alice.dusk, Wendy's .dusk name, was saved, the question naming another
  // contact; Sofía's: "sofiadesign.dusk cliente" saved without a word, and then read as her;
  // "VVendy" and "Davicl" passed for Wendy and David. Both wallets now ask app-core the same. Round 27:
  // the question came with "Name saved.", nothing left to answer, and a stranger's .dusk name got no word.
  it("ask about a name that is a contact's .dusk name, any other .dusk name, or starts as a profile's, naming whose, save it only on Yes, and refuse look-alikes in letter pairs", async () => {
    const WENDY = "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";
    listAddressBook.mockResolvedValue([
      { id: "w", name: "Wendy", address: WENDY, duskName: "wendy.dusk" },
      { id: "d", name: "David", address: `${WENDY.slice(0, -1)}U` },
    ]);
    setAccountName.mockClear();
    const view = await settings();
    const shownError = (n) => {
      const id = label(n).getAttribute("aria-describedby");
      return id ? dom.document.getElementById(id).textContent : "";
    };
    const question = (n) => label(n).parentNode.querySelectorAll(".contact-note").filter(isShown).map((el) => el.querySelector(".contact-note__words").textContent);
    const yes = (n) => label(n).parentNode.querySelectorAll(".contact-note__yes").find(isShown);
    const name = async (n, typed) => {
      typeInto(label(n), typed);
      label(n).dispatchEvent(fakeEvent("blur"));
      await settle();
    };

    // Asked, naming the contact and its .dusk name, and not saved until it's answered.
    await name(2, "wendy.dusk");
    expect(question(2)).toEqual([expect.stringContaining("Wendy")]);
    expect(question(2)[0]).toContain("wendy.dusk");
    expect(setAccountName).not.toHaveBeenCalled();
    expect(view.actions.showToast).not.toHaveBeenCalled();
    // Yes, save it: saved, once, though the field is left as it's pressed.
    label(2).dispatchEvent(fakeEvent("blur"));
    yes(2).click();
    await settle();
    expect([question(2), setAccountName.mock.calls]).toEqual([[], [[ACCOUNTS[0], 1, "wendy.dusk"]]]);

    // The first profile goes by its verified .dusk name.
    setAccountName.mockClear();
    await name(2, "alice.dusk cliente");
    expect([question(2), setAccountName.mock.calls]).toEqual([[expect.stringContaining("alice.dusk")], []]);
    // A stranger's .dusk name, no contact's: asked too.
    await name(2, "sofiadesign.dusk");
    expect([question(2), setAccountName.mock.calls]).toEqual([[expect.stringContaining("sofiadesign.dusk")], []]);

    setAccountName.mockClear();
    for (const [typed, whose] of [
      ["VVendy", "Wendy"],
      ["Davicl", "David"],
    ]) {
      await name(2, typed);
      expect(shownError(2), typed).toContain(whose);
    }
    expect(setAccountName).not.toHaveBeenCalled();
    listAddressBook.mockResolvedValue([]);
  });

  // Marek's: Yes, save it took sofiadesign.dusk, Sofía's, as his Profile 2's name, and History then gave his own
  // transfers her name. A .dusk name is looked up first: another account's is refused, not asked; this profile's
  // own needs no question. And Dav1d beside David, Wendv beside Wendy, went by.
  it("refuse a .dusk name registered to another account, take this profile's own without asking, and refuse digit and v-for-y look-alikes", async () => {
    const SOFIA = "sEeMSo7oiV2rxo6aZD3H75XGFZD95BtrmgFD3AezyUkC5W9bUyRwqFr6VuybvuvmvX5kTRt4STaSKbE6FEeMGoPDZNaX1LL82rGzN6BDbajY8qJcweu1mp7m1budNv9kgd7";
    const { duskNameOwners } = await import("../shared/duskNames.js");
    const { nameDuskNames } = await import("@dusk-network/app-core/names");
    // As the name service says, of the .dusk names a name holds, read as the wallet reads them.
    duskNameOwners.mockImplementation(async (typed) => {
      const said = new Map();
      for (const dusk of nameDuskNames(typed)) {
        if (dusk === "sofiadesign.dusk") said.set(dusk, { account: SOFIA });
        if (dusk === "mine.dusk") said.set(dusk, { account: ACCOUNTS[1] });
      }
      return said;
    });
    listAddressBook.mockResolvedValue([
      { id: "d", name: "David", address: `${SOFIA.slice(0, -1)}8` },
      { id: "w", name: "Wendy", address: `${SOFIA.slice(0, -1)}9` },
    ]);
    setAccountName.mockClear();
    await settings();
    const shownError = (n) => {
      const id = label(n).getAttribute("aria-describedby");
      return id ? dom.document.getElementById(id).textContent : "";
    };
    const question = (n) => label(n).parentNode.querySelectorAll(".contact-note").filter(isShown).map((el) => el.querySelector(".contact-note__words").textContent);
    const name = async (n, typed) => {
      typeInto(label(n), typed);
      label(n).dispatchEvent(fakeEvent("blur"));
      await settle();
    };
    // Refused, not asked, naming the .dusk name it is or looks like.
    const sofias = [expect.stringContaining("sofiadesign.dusk"), []];
    try {
      await name(2, "sofiadesign.dusk");
      expect([shownError(2), question(2)]).toEqual(sofias);
      expect(duskNameOwners).toHaveBeenLastCalledWith("sofiadesign.dusk", { nodeUrl: "https://testnet.nodes.dusk.network" });
      await name(2, "Dav1d");
      expect(shownError(2)).toContain("David");
      await name(2, "Wendv");
      expect(shownError(2)).toContain("Wendy");
      // Marek's, the round after: "Davld" and "Dav!d" went by, and Sofía's name in small capitals or circled letters
      // was saved without a word, History then calling his own transfers hers.
      for (const typed of ["Davld", "Dav!d"]) {
        await name(2, typed);
        expect(shownError(2), typed).toContain("David");
      }
      for (const typed of ["sofiadesign.\u1d05\u1d1c\ua731\u1d0b", "\u24e2\u24de\u24d5\u24d8\u24d0\u24d3\u24d4\u24e2\u24d8\u24d6\u24dd.dusk"]) {
        await name(2, typed);
        expect([shownError(2), question(2)], typed).toEqual(sofias);
      }
      // Marek's, the round after that: "sofiadesign·dusk", a middle dot, saved without a word, and History then filed
      // his transfers under it, right above Sofía's; so after any point that reads as a full stop.
      for (const point of ["\u00b7", "\u2022", "\uff0e", "\u3002", "\uff61", "\u2027", "\u2219"]) {
        await name(2, `sofiadesign${point}dusk`);
        expect([shownError(2), question(2)], point).toEqual(sofias);
      }
      // R12, Marek's, the round after that again: a dot above, a Braille dot, and a middle dot with a space went by.
      for (const typed of ["sofiadesign\u02d9dusk", "sofiadesign\u2804dusk", "sofiadesign\u00b7 dusk", "sofiadesign \u00b7 dusk"]) {
        await name(2, typed);
        expect([shownError(2), question(2)], typed).toEqual(sofias);
      }
      expect(setAccountName).not.toHaveBeenCalled();
      // This profile's own: saved, nothing asked.
      await name(2, "mine.dusk");
      expect([shownError(2), question(2), setAccountName.mock.calls]).toEqual(["", [], [[ACCOUNTS[0], 1, "mine.dusk"]]]);
    } finally {
      duskNameOwners.mockImplementation(async () => new Map());
      listAddressBook.mockResolvedValue([]);
    }
  });

  // Amélie's: Enter, Enter saved a stranger's account as Lucas in the web wallet, its second Enter on Yes, save it.
  it("never answer the question with Enter: the field keeps the focus, Enter asks again, and only Yes, save it saves", async () => {
    listAddressBook.mockResolvedValue([{ id: "l", name: "Lucas (petit-fils)", address: ACCOUNTS[1].replace(/.$/, "x") }]);
    setAccountName.mockClear();
    await settings();
    const question = () => label(2).parentNode.querySelectorAll(".contact-note").filter(isShown).map((el) => el.querySelector(".contact-note__words").textContent);
    const enter = async () => {
      label(2).focus();
      label(2).dispatchEvent(fakeEvent("keydown", { key: "Enter" }));
      label(2).dispatchEvent(fakeEvent("change"));
      await settle();
    };
    try {
      typeInto(label(2), "Lucas");
      await enter();
      expect(question()).toEqual([expect.stringContaining("Lucas (petit-fils)")]);
      // Not on Yes, save it, where a second Enter would press it.
      expect(dom.document.activeElement).toBe(label(2));
      await enter();
      expect([question().length, setAccountName.mock.calls]).toEqual([1, []]);
      label(2).parentNode.querySelector(".contact-note__yes").click();
      await settle();
      expect(setAccountName.mock.calls).toEqual([[ACCOUNTS[0], 1, "Lucas"]]);
    } finally {
      listAddressBook.mockResolvedValue([]);
    }
  });

  // Amélie's: her profile named Lucas beside her grandson's contact "Lucas (petit-fils)".
  it("ask about a name a contact's starts, or that starts it, word for word, and save it once it's answered", async () => {
    listAddressBook.mockResolvedValue([{ id: "c1", name: "Lucas (petit-fils)", address: "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T" }]);
    setAccountName.mockClear();
    await settings();
    const question = () => label(1).parentNode.querySelectorAll(".contact-note").filter(isShown).map((el) => el.querySelector(".contact-note__words").textContent);
    typeInto(label(1), "Lucas");
    label(1).dispatchEvent(fakeEvent("blur"));
    await settle();
    expect([question(), setAccountName.mock.calls]).toEqual([[expect.stringContaining("Lucas (petit-fils)")], []]);
    // Typed again, the question goes with what it asked of, and the name typed now is saved as any.
    typeInto(label(1), "Luc");
    expect(question()).toEqual([]);
    label(1).dispatchEvent(fakeEvent("blur"));
    await settle();
    expect([question(), setAccountName.mock.calls]).toEqual([[], [[ACCOUNTS[0], 0, "Luc"]]]);
    // Back to Lucas: asked again, and Yes saves it.
    typeInto(label(1), "Lucas");
    label(1).dispatchEvent(fakeEvent("blur"));
    await settle();
    label(1).parentNode.querySelector(".contact-note__yes").click();
    await settle();
    expect([question(), setAccountName.mock.calls.at(-1)]).toEqual([[], [ACCOUNTS[0], 0, "Lucas"]]);
    listAddressBook.mockResolvedValue([]);
  });
});

describe("settings", () => {
  describe("a site's record", () => {
    const DAY = 86_400_000;
    const MINUTE = 60_000;
    const AT = Date.UTC(2031, 0, 15, 12);
    const SITE = "https://app.example";
    const permissions = [{ origin: SITE, walletId: ACCOUNTS[0], accountIndex: 0, lastsMs: 7 * DAY, expiresAt: AT + 7 * DAY }];
    // What it asked, newest first, a minute apart.
    const asked = [
      { at: AT + 3 * MINUTE, what: "contract_call", method: "swap\u202Eyenom", answer: "rejected" },
      { at: AT + 2 * MINUTE, what: "transfer", answer: "approved" },
      { at: AT + MINUTE, what: "sign_message", answer: "closed" },
      { at: AT, what: "connect", answer: "approved" },
      { at: AT - MINUTE, what: "switch_network", answer: "expired" },
      { at: AT - 2 * MINUTE, what: "watch_nft", answer: "cancelled" },
      { at: AT - 3 * MINUTE, what: "transfer", answer: "failed" },
      { at: AT - 4 * MINUTE, what: "transfer", answer: "unconfirmed" },
      { at: AT - 5 * MINUTE, what: "contract_call", method: "depositETHToWithValue", asked: "Bridge to DuskEVM", answer: "approved" },
    ];
    const siteRecords = { [ACCOUNTS[0]]: { [SITE]: { lastUsedAt: AT + 4 * MINUTE, asked } } };

    // By the test's own clock, in UTC: when it was last used, until when it's connected, and what it asked, when and how
    // each was answered. Approved is approved; a payment not sent, or not confirmed, is said as that.
    it("shows what a site asked, when and how it was answered, its hidden characters as codes, and when it was last used and is connected until", async () => {
      vi.stubEnv("TZ", "UTC");
      await settings({ permissions, siteRecords });
      const row = siteRow("app.example");
      const notes = [...row.children].filter((el) => el.classList.contains("settings-site__note")).map(visibleText);
      const note = (label) => notes.find((text) => text.startsWith(label)) ?? "";
      expect(notes).toHaveLength(2);
      expect(note("Last used")).toMatch(exactly("Wed 15 Jan 2031, 12:04 UTC"));
      expect(note("Connected until")).toMatch(exactly("Wed 22 Jan 2031, 12:00 UTC"));
      // Each thing asked, in the record's order.
      const items = row.querySelectorAll(".settings-site__ask");
      const column = (part) => items.map((li) => visibleText(li.querySelector(`.settings-site__${part}`)));
      expect(column("answer")).toEqual([
        "Rejected",
        "Approved",
        "Window closed",
        "Approved",
        "Not answered in time",
        "Ended before an answer",
        "Approved, not sent",
        "Approved, not confirmed",
        "Approved",
      ]);
      expect(column("when")).toEqual([
        "Wed 15 Jan 2031, 12:03 UTC",
        "Wed 15 Jan 2031, 12:02 UTC",
        "Wed 15 Jan 2031, 12:01 UTC",
        "Wed 15 Jan 2031, 12:00 UTC",
        "Wed 15 Jan 2031, 11:59 UTC",
        "Wed 15 Jan 2031, 11:58 UTC",
        "Wed 15 Jan 2031, 11:57 UTC",
        "Wed 15 Jan 2031, 11:56 UTC",
        "Wed 15 Jan 2031, 11:55 UTC",
      ]);
      // Nothing a site chose reads as something else.
      expect(row.textContent).not.toContain("\u202E");
      expect(column("what")[0]).toMatch(/swap.*yenom/);
    });

    it("sets how long from its Details, and new sites' on their own", async () => {
      const view = await settings({ permissions, siteRecords });
      // The site's choice, under its Details; new sites', the one that's no site's.
      const sitesChoice = () => siteRow("app.example").querySelector("details select");
      const newSitesChoice = () => view.section("Connected sites").querySelectorAll("select").find((s) => !s.closest(".settings-site"));
      const choose = (select, value) => {
        select.value = String(value);
        select.dispatchEvent(fakeEvent("change"));
      };
      choose(sitesChoice(), DAY);
      await settle();
      expect(view.actions.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_SET_SITE_LASTS", origin: SITE, siteWallet: ACCOUNTS[0], lastsMs: DAY });
      expect(view.actions.render).toHaveBeenLastCalledWith({ forceRefresh: true });
      choose(sitesChoice(), 0);
      await settle();
      expect(view.actions.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_SET_SITE_LASTS", origin: SITE, siteWallet: ACCOUNTS[0], lastsMs: 0 });

      choose(newSitesChoice(), 30 * DAY);
      await settle();
      expect(view.actions.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_SET_NEW_SITE_LASTS", lastsMs: 30 * DAY });

      // Refused by the wallet: what it said is said.
      view.actions.send.mockResolvedValueOnce({ error: { message: "That site isn't connected any more." } });
      choose(sitesChoice(), DAY);
      await settle();
      expect(view.actions.showToast.mock.lastCall[0]).toBe("That site isn't connected any more.");

      await settings({ newSiteLastsMs: 7 * DAY });
      expect(newSitesChoice().value).toBe(String(7 * DAY));
    });

    it("lists sites no longer connected under Earlier sites, each to forget", async () => {
      const records = {
        [ACCOUNTS[0]]: {
          [SITE]: { lastUsedAt: AT, asked },
          "https://old.example": { lastUsedAt: AT - DAY },
          "https://refused.example": { asked: [{ at: AT, what: "connect", answer: "rejected" }] },
          // Only what it was set to: nothing to list.
          "https://set.example": { lastsMs: DAY },
        },
      };
      const view = await settings({ permissions, siteRecords: records });
      const earlier = view.section("Connected sites").querySelector(".settings-sites-earlier");
      expect(earlier.querySelectorAll(".settings-site__host").map(visibleText).sort()).toEqual(["old.example", "refused.example"]);
      siteRow("old.example").querySelector("button").click();
      await settle();
      expect(view.actions.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_FORGET_SITE_RECORD", origin: "https://old.example", siteWallet: ACCOUNTS[0] });
      expect(view.actions.render).toHaveBeenLastCalledWith({ forceRefresh: true });
      // A site's connection isn't touched by it, and none listed means no list.
      expect(view.actions.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "DUSK_UI_DISCONNECT_ORIGIN" }));
      const none = await settings({ permissions, siteRecords });
      expect(none.section("Connected sites").querySelector(".settings-sites-earlier")).toBeNull();
    });
  });

  it("disconnects one site, or all of them after asking", async () => {
    const permissions = [
      { origin: "https://app.example", accountIndex: 1 },
      { origin: "https://shop.example", accountIndex: 0 },
    ];
    const view = await settings({ permissions });
    const sites = view.section("Connected sites");
    expect(sites.querySelectorAll(".settings-site__host").map(visibleText)).toEqual(["app.example", "shop.example"]);
    // The profile the site sees.
    expect(siteRow("app.example").querySelectorAll("select").find((s) => !s.closest("details")).value).toBe("1");
    siteRow("app.example").querySelector(".settings-site__head button").click();
    await settle();
    expect(view.actions.send).toHaveBeenCalledWith({ type: "DUSK_UI_DISCONNECT_ORIGIN", origin: "https://app.example" });

    // All of them only after a yes, to a question that says how many.
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    sites.querySelector(".settings-disconnect-all").click();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatch(exactly("2 sites"));
    expect(view.actions.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "DUSK_UI_CLEAR_PERMISSIONS" }));
    // A local http:// site by its whole origin, as its approval named it.
    const local = (await settings({ permissions: [{ origin: "http://127.0.0.1:5354", accountIndex: 0 }] })).section("Connected sites");
    expect(local.querySelectorAll(".settings-site__host").map(visibleText)).toEqual(["http://127.0.0.1:5354"]);
  });

  // Chen's and Lena's: two taps, and every wallet was gone, with no password or fingerprint.
  it("asks for the password before a reset, as for removing a wallet, on a screen of its own: Back resets nothing", async () => {
    const view = await settings();
    const browserConfirm = vi.fn(() => true);
    vi.stubGlobal("confirm", browserConfirm);
    const resets = () => view.actions.send.mock.calls.filter(([m]) => m.type === "DUSK_UI_RESET_WALLET");
    view.section("Reset").querySelector("button").click();
    await settle();
    expect([view.state.route, browserConfirm.mock.calls, resets()]).toEqual(["wallet_reset", [], []]);

    const { resetWalletView } = await import("./popup/views/wallets.js");
    const draw = () => dom.document.body.replaceChildren(...resetWalletView(view.ov, { state: view.state, actions: view.actions }));
    draw();
    await settle();
    const body = dom.document.body;
    const password = () => body.querySelector("input[type=password]");
    // Said first: the funds stay on Dusk, and each wallet's recovery phrase is what gets them back.
    expect(visibleText(body.querySelector(".auth-lead"))).toMatch(/recovery phrase/i);
    // Nothing typed: said under the password, and nothing asked of the wallet.
    mainButton(body).click();
    await settle();
    expect(errorOf(password())).not.toBe("");
    expect(resets()).toEqual([]);
    // A wrong one: the wallet says so, under the field.
    view.actions.send.mockImplementation(async (m) => (m.type === "DUSK_UI_RESET_WALLET" && m.password !== "the password" ? { error: { message: "Incorrect password" } } : {}));
    typeInto(password(), "not it");
    mainButton(body).click();
    await settle();
    expect(errorOf(password())).toBe("Incorrect password");
    expect(view.state.route).toBe("wallet_reset");
    typeInto(password(), "the password");
    mainButton(body).click();
    await settle();
    expect(resets().at(-1)[0]).toEqual({ type: "DUSK_UI_RESET_WALLET", password: "the password" });
    expect(view.state.route).toBe("home");

    // Back from it: Settings, nothing reset.
    view.state.route = "wallet_reset";
    const before = resets().length;
    draw();
    body.querySelector(".subnav-back").click();
    expect([view.state.route, resets().length]).toEqual(["options", before]);
  });

  it("takes a fingerprint for a reset in the app where fingerprint unlock is on", async () => {
    const asked = [];
    dom.window.__TAURI_INTERNALS__ = {
      invoke: vi.fn(async (cmd, args) => {
        if (cmd !== "fingerprint") return null;
        asked.push(args.action);
        if (args.action === "status") return { ok: true, available: true, on: true };
        if (args.action === "unlock") return { ok: true, secret: "the password" };
        return { ok: true };
      }),
    };
    vi.stubGlobal("navigator", { ...globalThis.navigator, userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 6; wv) Chrome/156.0 Mobile Safari/537.36" });
    const view = await settings({}, { app: true });
    const { resetWalletView } = await import("./popup/views/wallets.js");
    view.state.route = "wallet_reset";
    dom.document.body.replaceChildren(...resetWalletView(view.ov, { state: view.state, actions: view.actions }));
    // Use fingerprint: the outline button beside Reset wallet.
    const finger = () => dom.document.body.querySelector("button.btn-outline");
    await vi.waitFor(() => expect(isShown(finger())).toBe(true));
    expect(view.actions.send).not.toHaveBeenCalled();
    finger().click();
    await vi.waitFor(() => expect(view.actions.send).toHaveBeenCalledWith({ type: "DUSK_UI_RESET_WALLET", password: "the password" }));
    // The fingerprint as asked, and with every wallet gone, the password it kept gone too.
    expect(asked.filter((action) => action !== "status" && action !== "keyboard")).toEqual(["unlock", "disable"]);
  });

  it("starts each switch of profile, network or wallet before asking the wallet, so a check begun before it can tell", async () => {
    const view = await settings();
    // The popup's context each time the wallet is asked.
    const before = view.state.context;
    const asked = [];
    view.actions.send.mockImplementation(async (message) => {
      asked.push([message.type, view.state.context]);
      return { ok: true };
    });
    vi.stubGlobal("confirm", vi.fn(() => true));

    const profile = dom.document.body.querySelector("select#account");
    profile.value = "1";
    profile.dispatchEvent(fakeEvent("change"));
    await settle();
    typeInto(dom.document.body.querySelectorAll("input").find((i) => accessibleName(i) === "Node URL"), "https://nodes.dusk.network");
    // The node's Save, then Lock at the top.
    dom.document.body.querySelector(".settings-nodes button").click();
    await settle();
    dom.document.body.querySelector(".subnav-actions button").click();
    await settle();
    const { resetWalletView } = await import("./popup/views/wallets.js");
    dom.document.body.replaceChildren(...resetWalletView(view.ov, { state: view.state, actions: view.actions }));
    typeInto(dom.document.body.querySelector("input[type=password]"), "the password");
    mainButton(dom.document.body).click();
    await settle();
    expect(asked.map(([type, context]) => [type, context?.reason])).toEqual([
      ["DUSK_UI_SET_ACCOUNT_INDEX", "switch"],
      ["DUSK_UI_SET_NODE_URL", "switch"],
      ["DUSK_UI_LOCK", "lock"],
      ["DUSK_UI_RESET_WALLET", "switch"],
    ]);
    // Each asked in a context of its own, replaced as its switch started.
    expect(new Set([before, ...asked.map(([, context]) => context)]).size).toBe(5);
  });

  it("offers auto-lock after 5 or 15 minutes, or Off, and keeps a new choice through a redraw", async () => {
    const view = await settings({ autoLockTimeoutMinutes: 15 });
    const select = () => dom.document.body.querySelector("select#auto-lock");
    expect(select().querySelectorAll("option").map((o) => o.value)).toEqual(["5", "15", "0"]);
    expect(select().value).toBe("15");
    select().value = "5";
    select().dispatchEvent({ type: "change", bubbles: true, target: select(), preventDefault() {}, stopPropagation() {} });
    await settle();
    expect(view.actions.send).toHaveBeenCalledWith({ type: "DUSK_UI_SET_AUTO_LOCK", autoLockTimeoutMinutes: 5 });
    // A redraw before the overview is read again still shows 5.
    view.draw();
    expect(select().value).toBe("5");
  });

  it("keeps custom gas under Advanced, off until it's turned on, as the web wallet does", async () => {
    const view = await settings();
    const advanced = dom.document.body.querySelector("details.settings-advanced");
    const toggle = advanced.querySelector("#custom-gas");
    // The note under the switch, its own.
    const note = () => {
      const label = toggle.closest("label");
      const kids = label.parentNode.children;
      return visibleText(kids[kids.indexOf(label) + 1]);
    };
    expect(toggle.checked).toBe(false);
    expect(note()).not.toMatch(/DUSK/);
    toggle.checked = true;
    toggle.dispatchEvent({ type: "change", bubbles: true, target: toggle, preventDefault() {}, stopPropagation() {} });
    await settle();
    expect(view.actions.send).toHaveBeenCalledWith({ type: "DUSK_UI_SET_CUSTOM_GAS", customGas: { limit: "2500000", price: "1" } });
    // The most a transaction then costs, as a most: its gas limit times its price.
    expect(note()).toMatch(exactly("0.0025 DUSK"));
    expect(note()).toMatch(/most|up to|max/i);
  });

  it("saves custom gas as it's typed only once its field is left", async () => {
    const view = await settings({ customGas: { limit: "3000000", price: "2" } });
    const field = (name) => dom.document.body.querySelectorAll("input").find((i) => accessibleName(i) === name);
    typeInto(field("Gas limit"), "4500000");
    typeInto(field("Gas price (LUX)"), "3");
    expect(view.actions.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "DUSK_UI_SET_CUSTOM_GAS" }));

    field("Gas price (LUX)").dispatchEvent(fakeEvent("change"));
    await settle();
    expect(view.actions.send).toHaveBeenCalledWith({ type: "DUSK_UI_SET_CUSTOM_GAS", customGas: { limit: "4500000", price: "3" } });
  });

  it("keeps Delete all contacts under Advanced, asking first", async () => {
    const view = await settings();
    view.state.addressBook = { loaded: true, items: [{ id: "1", name: "Jan (flour)" }] };
    const remove = dom.document.body.querySelector("details.settings-advanced .settings-delete-contacts");
    expect(remove).toBeTruthy();

    vi.stubGlobal("confirm", vi.fn(() => false));
    remove.click();
    await settle();
    expect(clearAddressBook).not.toHaveBeenCalled();

    vi.stubGlobal("confirm", vi.fn(() => true));
    remove.click();
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(clearAddressBook).toHaveBeenCalledTimes(1);
    expect(view.state.addressBook).toMatchObject({ loaded: false, items: null });
  });
});

describe("the network", () => {
  const choose = async (id) => {
    const select = dom.document.body.querySelector("select#network");
    select.value = id;
    select.dispatchEvent(fakeEvent("change"));
    await settle();
    return select;
  };
  const field = (name) => dom.document.body.querySelectorAll("input").find((i) => accessibleName(i) === name);
  // Save, under the node's addresses.
  const saveButton = () => dom.document.body.querySelector(".settings-nodes button");
  const shownText = (el) => el.querySelectorAll("[role=status], [role=alert]").filter(isShown).map((n) => n.textContent);

  it("switches as soon as it's chosen, as the menu at the top does, and says so", async () => {
    const view = await settings({ nodeUrl: "https://nodes.dusk.network" });
    view.actions.send.mockImplementation(async () => ({ ok: true }));
    await choose("testnet");
    expect(view.actions.send).toHaveBeenCalledWith({
      type: "DUSK_UI_SET_NODE_URL",
      nodeUrl: "https://testnet.nodes.dusk.network",
      proverUrl: "https://testnet.provers.dusk.network",
      archiverUrl: "https://testnet.nodes.dusk.network",
    });
    expect(view.actions.showToast).toHaveBeenCalledWith(expect.stringContaining("Testnet"));
    expect(view.actions.render).toHaveBeenCalledWith({ forceRefresh: true });
    expect(view.state.context?.reason).toBe("switch");
  });

  it("names the network it's still on when the switch fails, and says why under the choice", async () => {
    const view = await settings({ nodeUrl: "https://nodes.dusk.network" });
    view.actions.send.mockImplementation(async () => ({ error: { message: "Couldn't reach the node" } }));
    const select = await choose("testnet");
    expect(select.value).toBe("mainnet");
    expect(shownText(view.section("Network"))).toEqual(["Couldn't reach the node"]);
    expect(view.actions.showToast).not.toHaveBeenCalled();
  });

  it("is Custom while its prover or archiver is someone else's, and the network chosen again puts its own back", async () => {
    const view = await settings({ nodeUrl: "https://testnet.nodes.dusk.network", proverUrl: "https://testnet.provers.dusk.network", archiverUrl: "https://hostile-node.example" });
    expect(dom.document.body.querySelector("select#network").value).toBe("custom");
    view.actions.send.mockImplementation(async () => ({ ok: true }));
    await choose("testnet");
    expect(view.actions.send).toHaveBeenCalledWith({
      type: "DUSK_UI_SET_NODE_URL",
      nodeUrl: "https://testnet.nodes.dusk.network",
      proverUrl: "https://testnet.provers.dusk.network",
      archiverUrl: "https://testnet.nodes.dusk.network",
    });
  });

  it("refuses plain http to another computer, as a site's switch does, and takes it on this one", async () => {
    const testnet = { nodeUrl: "https://testnet.nodes.dusk.network", proverUrl: "https://testnet.provers.dusk.network", archiverUrl: "https://testnet.nodes.dusk.network" };
    const saved = (view) => view.actions.send.mock.calls.filter(([m]) => m.type === "DUSK_UI_SET_NODE_URL");
    for (const [name, typed, what, why] of [
      ["Prover URL", "http://hostile-node.example", "prover", /\bprover URL must start with https:\/\//],
      ["Archiver URL", "http://192.168.1.20:8080", "archiver", /\barchiver URL must start with https:\/\//],
      ["Node URL", "https://user:pass@node.example", "node", /\bInvalid node URL\b/],
    ]) {
      const view = await settings(testnet);
      typeInto(field(name), typed);
      saveButton().click();
      await settle();
      // Why, as the one alert under the addresses: which address, and what it needs. Nothing saved.
      const alerts = view.section("Network").querySelectorAll("[role=alert]").filter(isShown).map((n) => n.textContent);
      expect(alerts, typed).toEqual([expect.stringMatching(why)]);
      // As the wallet's own rule says it (securityPolicy.js).
      expect(alerts, typed).toEqual([endpointProblem(typed, what)]);
      expect(saved(view)).toEqual([]);
    }

    const view = await settings(testnet);
    view.actions.send.mockImplementation(async () => ({ ok: true }));
    const sends = () => saved(view);
    typeInto(field("Prover URL"), "http://127.0.0.1:8080");
    saveButton().click();
    await settle();
    expect(sends()).toEqual([[expect.objectContaining({ nodeUrl: "https://testnet.nodes.dusk.network", proverUrl: "http://127.0.0.1:8080" })]]);
  });

  it("asks before using a saved node on another chain than it was added with, and stays as it was without a yes", async () => {
    const view = await settings({ nodeUrl: "https://my-node.example", proverUrl: "https://my-node.example", archiverUrl: "https://my-node.example" });
    const question = "my-node.example now says it's on Mainnet (chain 1), not Testnet (chain 2). Use it on Mainnet (chain 1) from now on? What you sign there will count there.";
    const refused = { error: { message: "my-node.example now says it's on Mainnet (chain 1), not Testnet (chain 2). To use it anyway, save it in Settings.", data: { chainChanged: { pinned: 2, answered: 1, question } } } };
    view.actions.send.mockImplementation(async (message) => (message.acceptChain ? { ok: true } : refused));
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    saveButton().click();
    await settle();
    expect(confirm).toHaveBeenCalledWith(question);
    expect(view.actions.send).toHaveBeenCalledTimes(1);
    expect(shownText(view.section("Network"))).toContain(refused.error.message);

    confirm.mockReturnValue(true);
    saveButton().click();
    await settle();
    expect(view.actions.send).toHaveBeenLastCalledWith(expect.objectContaining({ acceptChain: 1 }));
  });
});

describe("wallets", () => {
  const W2 = ["w2acct0LongEnoughToShortenAtTheEnd000000", "w2acct1LongEnoughToShortenAtTheEnd111111"];
  // Each test's own: a rename changes them.
  const fresh = () => [
    { key: "k1", n: 1, name: "", walletId: ACCOUNTS[0], accounts: ACCOUNTS, accountNames: {}, active: true },
    { key: "k2", n: 2, name: "Savings", walletId: W2[0], accounts: W2, accountNames: { 1: "Rainy day" }, active: false },
  ];
  // Settings drawn again on render, as the popup does.
  const drawn = async (over) => {
    const view = await settings(over);
    view.actions.render.mockImplementation(async () => view.draw());
    return view;
  };

  it("names each connected site's wallet, and disconnects a site from its own wallet", async () => {
    const permissions = [
      { origin: "https://app.example", walletId: ACCOUNTS[0], accountIndex: 0 },
      { origin: "https://shop.example", walletId: W2[0], accountIndex: 1 },
    ];
    const view = await drawn({ wallets: fresh(), permissions });
    const walletOf = (host) => visibleText(siteRow(host).querySelector(".settings-site__wallet"));
    expect(walletOf("app.example")).toBe("Wallet 1");
    // Another wallet's site: that wallet, Savings, then the profile it sees there.
    expect(walletOf("shop.example")).toMatch(/^Savings\b.*\bRainy day$/);
    // The open wallet's site changes profile here; another's doesn't.
    const profileChoice = (host) => siteRow(host).querySelectorAll("select").find((s) => !s.closest("details"));
    expect([Boolean(profileChoice("app.example")), Boolean(profileChoice("shop.example"))]).toEqual([true, false]);

    vi.stubGlobal("confirm", vi.fn(() => true));
    const disconnect = (host) => siteRow(host).querySelector(".settings-site__head button").click();
    disconnect("shop.example");
    await settle();
    expect(view.actions.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_DISCONNECT_ORIGIN", origin: "https://shop.example", siteWallet: W2[0] });
    disconnect("app.example");
    await settle();
    expect(view.actions.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_DISCONNECT_ORIGIN", origin: "https://app.example" });
    dom.document.body.querySelector(".settings-disconnect-all").click();
    await settle();
    expect(view.actions.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_CLEAR_PERMISSIONS", siteWallets: [ACCOUNTS[0], W2[0]] });
  });
});


// The app on a phone: Auto-lock's Immediately, and fingerprint unlock, as phone wallets have them.
describe("security in the app on a phone", () => {
  const onPhone = ({ available = true, on = false, enroll = false, notices = () => false } = {}) => {
    const asked = [];
    dom.window.__TAURI_INTERNALS__ = {
      invoke: vi.fn(async (cmd, args) => {
        // The phone's notices: whether they may show, and Android's question.
        if (cmd === "notices") {
          if (args.action === "ask") asked.push(["notices: ask"]);
          return { allowed: notices(args.action) };
        }
        if (cmd !== "fingerprint") return null;
        asked.push([args.action, args.args?.secret]);
        return args.action === "status" ? { ok: true, available, on, enroll } : { ok: true };
      }),
    };
    vi.stubGlobal("navigator", { ...globalThis.navigator, userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 6; wv) AppleWebKit/537.36 Chrome/156.0 Mobile Safari/537.36" });
    return { asked };
  };
  const finger = () => dom.document.body.querySelector("#fingerprint-unlock");
  // Turn on, under the password that turns it on.
  const turnOn = () => dom.document.body.querySelector(".settings-fingerprint-ask button");

  it("turns fingerprint unlock on with the password, checked first, then a fingerprint; and off at once", async () => {
    const { asked } = onPhone();
    const view = await settings({}, { app: true });
    await vi.waitFor(() => expect(isShown(finger())).toBe(true));
    expect(finger().checked).toBe(false);
    finger().checked = true;
    finger().dispatchEvent(fakeEvent("change"));
    const pwd = dom.document.body.querySelector("#fingerprint-password");
    expect(isShown(pwd)).toBe(true);

    // A wrong password: said, and no fingerprint asked.
    view.actions.send.mockImplementation(async (m) => (m.type === "DUSK_UI_CHECK_PASSWORD" && m.password !== "right one" ? { error: { message: "Incorrect password" } } : {}));
    typeInto(pwd, "wrong one");
    turnOn().click();
    await settle();
    expect(dom.document.body.querySelector("#fingerprint-error").textContent).not.toBe("");
    expect(asked.map(([action]) => action)).toEqual(["status"]);

    typeInto(pwd, "right one");
    turnOn().click();
    await vi.waitFor(() => expect(asked.at(-1)).toEqual(["enable", "right one"]));

    finger().checked = false;
    finger().dispatchEvent(fakeEvent("change"));
    await vi.waitFor(() => expect(asked.at(-1)).toEqual(["disable", undefined]));
  });

  // Astra's: Turn on pressed, the switch off and on while the password was checked, and Turn on again:
  // two turnings on, each making the Keystore key anew, could leave neither working.
  it("starts one turning on at a time, whatever's switched or pressed while one is under way", async () => {
    const { asked } = onPhone();
    const view = await settings({}, { app: true });
    await vi.waitFor(() => expect(isShown(finger())).toBe(true));
    const checked = Promise.withResolvers();
    view.actions.send.mockImplementation(async (m) => (m.type === "DUSK_UI_CHECK_PASSWORD" ? checked.promise : {}));
    const flip = (on) => {
      finger().checked = on;
      finger().dispatchEvent(fakeEvent("change"));
    };
    flip(true);
    typeInto(dom.document.body.querySelector("#fingerprint-password"), "right one");
    turnOn().click();
    // While the password is checked: off and on again, and Turn on again.
    flip(false);
    flip(true);
    const again = dom.document.body.querySelector("#fingerprint-password");
    if (again) typeInto(again, "right one");
    turnOn()?.click();
    checked.resolve({});
    await settle();
    await vi.waitFor(() => expect(asked.filter(([action]) => action === "enable")).toHaveLength(1));
    await settle();
    expect(asked.filter(([action]) => action === "enable" || action === "disable")).toEqual([["enable", "right one"]]);
  });

  // Sofía's: no notice when a client paid her with the app in the background, and Settings had nothing for notices.
  // Then Chen's and Sofía's: a friend's payment was noticed after 14 and 9 minutes, and only Settings said it could.
  it("has Tell me when money comes in, on while notices are allowed, saying Android checks about every 15 minutes, and turns it off and on", async () => {
    let allowed = true;
    const { asked } = onPhone({ notices: () => allowed });
    const view = await settings({}, { app: true });
    const { INCOMING_NOTE } = await import("./popup/views/options.js");
    const toggle = () => dom.document.body.querySelector("#incoming-notices");
    await vi.waitFor(() => expect(toggle().checked).toBe(true));
    // How often Android looks for money that came in: every 15 minutes.
    const note = dom.document.body.querySelector("#incoming-note").textContent;
    expect(note).toMatch(exactly("15 minutes"));
    expect(note).toBe(INCOMING_NOTE);

    toggle().checked = false;
    toggle().dispatchEvent(fakeEvent("change"));
    await vi.waitFor(() => expect(view.actions.send).toHaveBeenCalledWith({ type: "DUSK_UI_SET_INCOMING_NOTICES", on: false }));
    expect(view.ov.incomingNotices).toBe(false);

    // On again with notices not allowed: Android's question, and a no leaves it off, with nothing sent.
    allowed = false;
    view.actions.send.mockClear();
    toggle().checked = true;
    toggle().dispatchEvent(fakeEvent("change"));
    await vi.waitFor(() => expect(asked).toContainEqual(["notices: ask"]));
    await settle();
    expect([toggle().checked, view.actions.send.mock.calls]).toEqual([false, []]);
    // A yes: on.
    allowed = true;
    toggle().checked = true;
    toggle().dispatchEvent(fakeEvent("change"));
    await vi.waitFor(() => expect(view.actions.send).toHaveBeenCalledWith({ type: "DUSK_UI_SET_INCOMING_NOTICES", on: true }));
    expect(toggle().checked).toBe(true);
  });

  // Chen's: no way in the app to see the recovery words again, or to change the password.
  it("offers the recovery phrase and a new password in the app, each behind the password", async () => {
    onPhone({ on: false });
    const view = await settings({}, { app: true });
    expect(isShown(view.section("Security").querySelector(".settings-change-password"))).toBe(true);
    const phraseRow = rowTo(view, "recovery_phrase");
    expect(phraseRow).toBeTruthy();
    phraseRow.click();
    await settle();
    expect(view.state.route).toBe("recovery_phrase");

    const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    view.actions.send.mockImplementation(async (m) =>
      m.type === "DUSK_UI_RECOVERY_PHRASE" ? (m.password === "the password" ? { ok: true, result: MNEMONIC } : { error: { message: "Incorrect password" } }) : {}
    );
    const { recoveryPhraseView } = await import("./popup/views/wallets.js");
    dom.document.body.replaceChildren(...recoveryPhraseView(view.ov, { state: view.state, actions: view.actions }));
    const body = dom.document.body;
    const password = () => body.querySelector("input[type=password]");
    expect(body.querySelector(".srp-grid")).toBeNull();
    typeInto(password(), "not it");
    mainButton(body).click();
    await settle();
    expect(errorOf(password())).toBe("Incorrect password");
    expect(body.querySelector(".srp-grid")).toBeNull();
    typeInto(password(), "the password");
    mainButton(body).click();
    await settle();
    expect(body.querySelectorAll(".srp-word-text").map((w) => w.textContent)).toEqual(MNEMONIC.split(" "));
    expect(view.actions.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_RECOVERY_PHRASE", password: "the password" });
    // Marek's: words in clear stayed in Android's app switcher and Firefox's tab list. Hidden the moment the page is
    // hidden, left or loses the focus, and with Hide; shown again only with Reveal.
    const blurred = () => body.querySelector(".srp-grid").classList.contains("srp-grid--blur");
    // Hide, or Reveal, beside them.
    const toggle = () => body.querySelector(".phrase-tools button");
    // Back, Hide and Done, and nothing to copy them with.
    expect([blurred(), body.querySelectorAll("button").length]).toEqual([false, 3]);
    for (const away of [
      () => {
        dom.document.visibilityState = "hidden";
        dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      },
      () => dom.window.dispatchEvent(fakeEvent("pagehide")),
      () => dom.window.dispatchEvent(fakeEvent("blur")),
      () => toggle().click(),
    ]) {
      dom.document.visibilityState = "visible";
      away();
      expect(blurred()).toBe(true);
      dom.document.visibilityState = "visible";
      dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      dom.window.dispatchEvent(fakeEvent("focus"));
      expect(blurred()).toBe(true);
      toggle().click();
      expect(blurred()).toBe(false);
    }
    // Done.
    mainButton(body).click();
    expect(view.state.route).toBe("options");
  });

  // Marek's: in Firefox for Android the app switcher took its picture before the page heard it was leaving.
  it("shows the recovery phrase in Firefox for Android only while Hold to show words is held", async () => {
    const view = await settings();
    vi.stubGlobal("navigator", { ...globalThis.navigator, userAgent: "Mozilla/5.0 (Android 15; Mobile; rv:159.0) Gecko/159.0 Firefox/159.0" });
    const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    view.actions.send.mockImplementation(async (m) => (m.type === "DUSK_UI_RECOVERY_PHRASE" ? { ok: true, result: MNEMONIC } : {}));
    const { recoveryPhraseView } = await import("./popup/views/wallets.js");
    dom.document.body.replaceChildren(...recoveryPhraseView(view.ov, { state: view.state, actions: view.actions }));
    const body = dom.document.body;
    typeInto(body.querySelector("input[type=password]"), "the password");
    mainButton(body).click();
    await settle();
    const blurred = () => body.querySelector(".srp-grid").classList.contains("srp-grid--blur");
    const hold = body.querySelectorAll("button").find((b) => b.textContent === HOLD_TO_SHOW_TEXT);
    expect(blurred()).toBe(true);
    hold.click();
    expect(blurred()).toBe(true);
    hold.dispatchEvent(fakeEvent("pointerdown", { button: 0, pointerId: 1 }));
    expect(blurred()).toBe(false);
    hold.dispatchEvent(fakeEvent("pointercancel", { pointerId: 1 }));
    expect(blurred()).toBe(true);
  });

  // Amélie's, the seventh time: a way to check the paper, typing the words and hearing they match. Then
  // Nandini's and Amélie's: one word wrong, or three made up, put the whole phrase on screen.
  it("checks three of the recovery words behind the password, in the extension too, and says no more than that they don't match", async () => {
    const view = await settings();
    rowTo(view, "check_words").click();
    await settle();
    expect(view.state.route).toBe("check_words");

    const MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    const asked = [];
    view.actions.send.mockImplementation(async (m) => {
      if (m.type !== "DUSK_UI_CHECK_RECOVERY_WORDS") return {};
      asked.push(m.words ? m.words.map(([place]) => place) : "count");
      if (m.password !== "the password") return { error: { message: "Incorrect password" } };
      if (!m.words) return { ok: true, count: 12 };
      const words = MNEMONIC.split(" ");
      return { ok: true, match: m.words.every(([place, word]) => words[place - 1] === word) };
    });
    const { checkWordsView } = await import("./popup/views/wallets.js");
    const draw = () => dom.document.body.replaceChildren(...checkWordsView(view.ov, { state: view.state, actions: view.actions }));
    draw();
    const body = dom.document.body;
    const password = () => body.querySelector("input[type=password]");
    const boxes = () => body.querySelectorAll("input").filter((i) => /^Word \d+$/.test(accessibleName(i)));
    typeInto(password(), "not it");
    mainButton(body).click();
    await settle();
    expect(errorOf(password())).toBe("Incorrect password");
    expect(boxes()).toEqual([]);
    typeInto(password(), "the password");
    mainButton(body).click();
    await settle();
    // Three of its twelve words, by their places, as Import's boxes are.
    expect(boxes()).toHaveLength(3);
    const places = boxes().map((i) => Number(accessibleName(i).slice(5)));
    expect(places.every((p) => p >= 1 && p <= 12)).toBe(true);
    for (const input of boxes()) expect([input.getAttribute("autocomplete"), input.getAttribute("spellcheck")]).toEqual(["off", "false"]);
    // Lena's: a whole word in the first box and Enter checked at once, two boxes empty, saying they don't match.
    // Enter goes on to the next box, and Check waits till every box holds a word.
    const check = mainButton(body);
    boxes()[0].focus();
    typeInto(boxes()[0], MNEMONIC.split(" ")[places[0] - 1]);
    boxes()[0].dispatchEvent(fakeEvent("keydown", { key: "Enter" }));
    await settle();
    expect([check.disabled, asked]).toEqual([true, ["count", "count"]]);
    check.click();
    await settle();
    expect(shownErrors(body)).toEqual([]);
    for (const input of boxes()) typeInto(input, MNEMONIC.split(" ")[Number(accessibleName(input).slice(5)) - 1]);
    expect(check.disabled).toBe(false);
    check.click();
    await settle();
    // They match: nothing said against them, no Show my recovery words, and no word of the phrase shown.
    expect([shownErrors(body), body.querySelector(".words-show"), body.querySelector(".srp-grid"), boxes()]).toEqual([[], null, null, []]);
    expect(asked).toEqual(["count", "count", places]);
    // Done, its one button: back to Settings.
    mainButton(body).click();
    expect(view.state.route).toBe("options");

    // Again: one word wrong, then three made up. Said, and nothing else: no word of the phrase.
    draw();
    typeInto(password(), "the password");
    mainButton(body).click();
    await settle();
    const again = boxes().map((i) => Number(accessibleName(i).slice(5)));
    for (const typed of [again.map((p, i) => (i === 0 ? "zoo" : MNEMONIC.split(" ")[p - 1])), ["kiwi", "lemon", "cabin"]]) {
      boxes().forEach((input, i) => typeInto(input, typed[i]));
      mainButton(body).click();
      await settle();
      expect([shownErrors(body), body.querySelector(".srp-grid"), boxes()]).toEqual([[expect.stringMatching(/\bdoesn['’]t match\b/i)], null, []]);
      expect(shownErrors(body)).toEqual([RECOVERY_WORDS_MISMATCH]);
      // Try again: the same three, empty, with nothing asked of the wallet till Check.
      const before = asked.length;
      mainButton(body).click();
      expect(boxes().map((i) => Number(accessibleName(i).slice(5)))).toEqual(again);
      expect(boxes().map((i) => i.value)).toEqual(["", "", ""]);
      expect(asked).toHaveLength(before);
    }

    // Show my recovery words, apart: the recovery phrase, behind the password again.
    for (const input of boxes()) typeInto(input, "zoo");
    mainButton(body).click();
    await settle();
    view.actions.render.mockClear();
    body.querySelector(".words-show").click();
    await settle();
    expect(view.state.route).toBe("recovery_phrase");
    expect(view.actions.render).toHaveBeenCalled();
    view.actions.send.mockImplementation(async (m) =>
      m.type === "DUSK_UI_RECOVERY_PHRASE" ? (m.password === "the password" ? { ok: true, result: MNEMONIC } : { error: { message: "Incorrect password" } }) : {}
    );
    const { recoveryPhraseView } = await import("./popup/views/wallets.js");
    body.replaceChildren(...recoveryPhraseView(view.ov, { state: view.state, actions: view.actions }));
    expect(body.querySelector(".srp-grid")).toBeNull();
    typeInto(password(), "the password");
    mainButton(body).click();
    await settle();
    expect(body.querySelectorAll(".srp-word-text").map((w) => w.textContent)).toEqual(MNEMONIC.split(" "));
  });

  it("shows no recovery phrase in Settings outside the app", async () => {
    const view = await settings();
    // Its rows are there, the check among them, and none opens the recovery phrase.
    expect(rowTo(view, "check_words")).toBeTruthy();
    expect(rowTo(view, "recovery_phrase")).toBeUndefined();
  });

  it("offers no fingerprint unlock on a phone that can't guard the password with one", async () => {
    const { asked } = onPhone({ available: false });
    await settings({}, { app: true });
    await vi.waitFor(() => expect(asked).toEqual([["status", undefined]]));
    await settle();
    expect(isShown(finger())).toBe(false);
  });
});
