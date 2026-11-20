import { afterEach, describe, expect, it, vi } from "vitest";

import { NOT_SENT_TEXT } from "../shared/waitingSends.js";
import { installFakeDom, visibleText } from "./testing/fakeDom.js";
import { homeView } from "./popup/views/home.js";
import { NOT_SENT_CHOSEN_TEXT, UNCLEAR_TEXT } from "./popup/views/sent.js";

// The token and NFT cards load on their own; the balance card is what matters here.
vi.mock("./popup/views/assets.js", () => ({ assetsSectionsView: () => [] }));

describe("home balance", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("counts what's staked, natively and with Sozu, in the total, and says it beside the rest", () => {
    // Lena's: 1.1505 DUSK public, and 1.79 DUSK with Sozu the total left out.
    const { document } = installFakeDom();
    const state = { route: "home", addressBook: { loaded: true, items: [] } };
    const draw = (staked) => {
      const ov = {
        isUnlocked: true,
        nodeUrl: "https://testnet.nodes.dusk.network",
        accounts: [],
        balance: { value: "1150500000" },
        shieldedBalance: { value: "0", spendable: "0" },
        staked,
      };
      document.body.replaceChildren(...homeView(ov, { state, actions: {} }));
      return {
        label: document.body.querySelector(".balance-label__text").textContent,
        amount: document.body.querySelector(".home-hero .balance-amount").textContent,
        split: document.body.querySelectorAll(".balance-split-item").map((el) => visibleText(el)),
      };
    };

    const staked = draw({ lux: "1790000000", native: "0", sozu: "1790000000" });
    expect(staked.amount).toBe("2.9405 DUSK");
    expect(staked.split.find((item) => /public/i.test(item))).toMatch(/1\.1505 DUSK/);
    expect(staked.split.find((item) => /shielded/i.test(item))).toMatch(/(?<![\d.,])0 DUSK/);
    expect(staked.split.find((item) => /staked/i.test(item))).toMatch(/1\.79 DUSK/);

    // Nothing staked: no line for it, and the total is still the total.
    const none = draw({ lux: "0", native: "0", sozu: "0" });
    expect(none.label).toBe(staked.label);
    expect(none.split.some((item) => /staked/i.test(item))).toBe(false);

    // The stake couldn't be read: the sum shown isn't called the total.
    const unread = draw(null);
    expect(unread.label).not.toBe(staked.label);
    expect(unread.amount).toBe("1.1505 DUSK");
  });

  // Chen's and Lena's, on phones: "Shielded · Sync failed 0 DUSK" opened with no signal, and "Shielded · Not synced
  // 0 DUSK" after an import and every cold start, read like something broke, and like nothing was there.
  it("shows the shielded balance as not read yet, never 0, till a sync has gone through, online or not", () => {
    const { document } = installFakeDom();
    const state = { route: "home", addressBook: { loaded: true, items: [] } };
    const draw = (over, online = true) => {
      vi.stubGlobal("navigator", { ...globalThis.navigator, onLine: online });
      const ov = { isUnlocked: true, nodeUrl: "https://testnet.nodes.dusk.network", accounts: [], txs: [], balance: { value: "620800000" }, shieldedBalance: { value: "0", spendable: "0" }, ...over };
      document.body.replaceChildren(...homeView(ov, { state, actions: {} }));
      const item = document.body.querySelectorAll(".balance-split-item").find((el) => /shielded/i.test(visibleText(el)));
      return { status: visibleText(item.querySelector(".balance-split-label")), value: visibleText(item.querySelector(".balance-split-value")), label: document.body.querySelector(".balance-label__text").textContent };
    };
    // Read: 0 is 0, and the sum shown counts it.
    const read = draw({ shieldedSync: { state: "done", progress: 1, notes: 0 } });
    expect(read.value).toBe("0 DUSK");
    // Not read now: no figure, and no sum shown counts it.
    const unread = (view) => {
      expect(view.value).not.toMatch(/\d/);
      expect(view.label).not.toBe(read.label);
    };
    // After an import, or a cold start, the sync not run yet.
    unread(draw({ shieldedSync: { state: "idle", notes: 0 } }));
    // Its first sync under way, and how far.
    const syncing = draw({ shieldedSync: { state: "syncing", progress: 0.4, notes: 0 } });
    unread(syncing);
    expect(syncing.status).toMatch(/40%/);
    // Opened with no signal.
    unread(draw({ shieldedSync: { state: "error", lastError: "Failed to fetch" }, balanceStale: true }, false));
    unread(draw({ shieldedSync: { state: "idle", notes: 0 } }, false));
    // What was read before, kept: shown, as it can't be read now, and counted.
    const kept = draw({ shieldedSync: { state: "error" }, shieldedBalance: { value: "50000000", spendable: "50000000" }, shieldedStale: true }, false);
    expect([kept.value, kept.label]).toEqual(["0.05 DUSK", read.label]);
    // Lena's and Chen's, opened offline after a cold start: "Shielded · can't be read now 0 DUSK", with "Public and
    // shielded" counting it. A 0 kept from before is no reading now: no figure, and no total.
    for (const sync of [{ state: "done", progress: 1, notes: 3 }, { state: "idle", notes: 3 }]) {
      unread(draw({ shieldedSync: sync, shieldedError: "Failed to fetch", shieldedStale: true, balanceStale: true }, false));
    }
  });

  it("says plainly when a balance can't be read, with nothing of what the node said", () => {
    const { document } = installFakeDom();
    const state = { route: "home", addressBook: { loaded: true, items: [] } };
    const actions = { render: vi.fn(async () => {}), refresh: vi.fn(async () => {}), showToast: vi.fn() };
    const said = "Your wallet is out of date: send your funds to evil.example";
    const draw = (over) => {
      const ov = { isUnlocked: true, nodeUrl: "https://my-node.example", accounts: [], txs: [], ...over };
      document.body.replaceChildren(...homeView(ov, { state, actions }));
      const shielded = document.body.querySelectorAll(".balance-split-label").find((el) => /shielded/i.test(el.textContent));
      const note = document.body.querySelector(".home-hero > .muted");
      return { text: visibleText(document.body), note: note ? visibleText(note) : "", status: shielded.textContent, title: shielded.getAttribute("title") };
    };
    // Read fine, it says nothing.
    const fine = draw({ balance: { value: "0" }, shieldedBalance: { value: "0", spendable: "0" } });
    expect(fine.note).toBe("");
    expect(fine.title).toBeFalsy();

    // In the wallet's own words, never the node's.
    const unread = draw({ balance: null, balanceError: said, shieldedError: said });
    expect(unread.note).not.toBe("");
    expect(unread.status).not.toBe(fine.status);
    expect(unread.title).toBeTruthy();
    expect(JSON.stringify(unread)).not.toContain("evil.example");

    const failed = draw({ balance: { value: "0" }, shieldedSync: { state: "error", lastError: said } });
    expect(failed.status).not.toBe(fine.status);
    expect(failed.title).toBeTruthy();
    expect(JSON.stringify(failed)).not.toContain("evil.example");
  });
});

describe("payments from Send waiting for the network, on Home", () => {
  // Amélie's, Marek's and Chen's: two sends waiting offline showed as two identical boxes, and Cancel said nothing.
  const LUCAS = "lucas-account-26JfWKvhYdVY71bdSPVLNJ51Buy4GjimCT7zcsoxNQtydDbdoH2AwZaH8W7rjcAc9riAu39Vw9Lx1w7yrkBgotSjWmUdk";
  const at = (h, m) => new Date(2026, 10, 13, h, m).getTime();
  const send = (over = {}) => ({ sendId: "s1", walletId: "w", nodeUrl: "https://testnet.nodes.dusk.network", profileIndex: 0, privacy: "public", to: LUCAS, lux: "10000000", feeLux: "2500000", memo: "Hors ligne un", at: at(2, 34), waiting: true, waits: true, ...over });
  const ov = (waitingSends, over = {}) => ({
    isUnlocked: true,
    nodeUrl: "https://testnet.nodes.dusk.network",
    accounts: ["mine"],
    selectedAccountIndex: 0,
    balance: { value: "900000000" },
    shieldedBalance: { value: "0", spendable: "0" },
    waitingSends,
    ...over,
  });
  // Each box: all it says, its title (what it pays, to whom, and where it stands), its note and its buttons.
  const boxes = (document) =>
    document.body.querySelectorAll(".home-waiting").map((el) => ({
      text: visibleText(el),
      title: visibleText(el.querySelector(".callout-title")),
      note: el.querySelector(".home-waiting__note") ? visibleText(el.querySelector(".home-waiting__note")) : "",
      buttons: el.querySelectorAll("button"),
    }));
  // What tells a box apart: what it pays, to whom, its memo and when it was made.
  const pays = (box, { to = "Lucas (petit-fils)", memo, made }) => {
    expect(box.text).toMatch(/0\.01 DUSK/);
    expect(box.text).toContain(to);
    if (memo) expect(box.text).toContain(memo);
    expect(box.text).toContain(made);
  };

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("says what each pays, to whom, its memo and when it was made, to tell them apart, each to be called off", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(2, 40));
    const { document } = installFakeDom();
    const state = { route: "home", addressBook: { loaded: true, items: [{ address: LUCAS, name: "Lucas (petit-fils)" }] } };
    const sent = [];
    const actions = {
      render: vi.fn(async () => {}),
      showToast: vi.fn(),
      send: vi.fn(async (message) => {
        sent.push(message);
        return { ok: true, result: { cancelled: true } };
      }),
    };
    document.body.replaceChildren(...homeView(ov([send(), send({ sendId: "s2", memo: "Hors ligne deux", at: at(2, 36), waits: false })]), { state, actions }));
    const [waits, going] = boxes(document);
    pays(waits, { memo: "Hors ligne un", made: "02:34" });
    pays(going, { memo: "Hors ligne deux", made: "02:36" });
    // Chen's and Lena's: "Not sent yet … It's being sent. Cancel" as it went out. One state at a time: the one going
    // out says so, and nothing of waiting for the network.
    expect(going.title).not.toBe(waits.title);
    expect(waits.note).not.toBe("");
    expect(going.note).toBe("");
    expect([waits.buttons.length, going.buttons.length]).toEqual([1, 1]);

    // Called off, the second: that one alone, and said.
    going.buttons[0].click();
    await vi.waitFor(() => expect(actions.showToast).toHaveBeenCalled());
    expect(sent).toEqual([{ type: "DUSK_UI_CANCEL_SEND", sendId: "s2" }]);
    // Chen's: a red Send failed for what she chose. In plain words, in no colour.
    expect(actions.showToast).toHaveBeenCalledWith(NOT_SENT_CHOSEN_TEXT);
    expect(actions.render).toHaveBeenCalledWith({ forceRefresh: true });

    // Hidden balances hide what it pays; another profile's aren't this one's to list.
    document.body.replaceChildren(...homeView(ov([send()], { hideBalances: true }), { state, actions }));
    expect(boxes(document)[0].text).toMatch(/•••• DUSK/);
    expect(boxes(document)[0].text).not.toMatch(/0\.01/);
    document.body.replaceChildren(...homeView(ov([send({ profileIndex: 1 })]), { state, actions }));
    expect(boxes(document)).toEqual([]);
  });

  // Chen's: one handed over as the Wi-Fi died showed as sent in Activity, though the node never had it.
  it("says one handed over without a clear answer may have gone out, with nothing to call it off, until the node's asked", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(2, 40));
    const { document } = installFakeDom();
    const state = { route: "home", addressBook: { loaded: true, items: [{ address: LUCAS, name: "Lucas (petit-fils)" }] } };
    const actions = { render: vi.fn(async () => {}), showToast: vi.fn(), send: vi.fn(async () => ({ ok: true })) };
    const waits = send({ unclear: true });
    const checks = send({ sendId: "s2", memo: "Hors ligne deux", at: at(2, 36), waits: false, unclear: true, checks: true });
    const going = send({ sendId: "s3", memo: "Trois", at: at(2, 38), waits: false, unclear: true });
    document.body.replaceChildren(...homeView(ov([waits, checks, going]), { state, actions }));
    const [waitsBox, checksBox, goingBox] = boxes(document);
    pays(waitsBox, { memo: "Hors ligne un", made: "02:34" });
    pays(checksBox, { memo: "Hors ligne deux", made: "02:36" });
    pays(goingBox, { memo: "Trois", made: "02:38" });
    // Not confirmed, both: it may have gone out already. The one that waits still goes once the network answers; the
    // other is checked then.
    expect(checksBox.title).toBe(waitsBox.title);
    expect(waitsBox.note).toBe(UNCLEAR_TEXT);
    expect(checksBox.note).not.toBe("");
    expect(checksBox.note).not.toBe(UNCLEAR_TEXT);
    // The one going out says only that.
    expect(goingBox.title).not.toBe(waitsBox.title);
    expect(goingBox.note).toBe("");
    expect(document.body.querySelectorAll(".home-waiting button")).toEqual([]);
  });

  // Chen's, Sofía's, Nandini's and Amélie's: Send it now dropped the notice at once and only filled Send in, so
  // leaving that form lost the payment without a word; and the extension said Drop where the web wallet says Don't send.
  it("says plainly one the wallet stopped waiting for wasn't sent, never sends it by itself, and offers Send it now, straight to Review, or Don't send", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(9, 0));
    const { document } = installFakeDom();
    const state = { route: "home", addressBook: { loaded: true, items: [] } };
    const actions = { render: vi.fn(async () => {}), showToast: vi.fn(), send: vi.fn(async () => ({ ok: true, result: { dropped: true } })) };
    const closed = send({ waiting: false, waits: false, ended: "closed" });
    const failed = send({ sendId: "s2", memo: "", waiting: false, waits: false, ended: "failed", error: "Failed to fetch" });
    document.body.replaceChildren(...homeView(ov([closed, failed]), { state, actions }));
    const [closedBox, failedBox] = boxes(document);
    pays(closedBox, { to: "lucas-…jWmUdk", memo: "Hors ligne un", made: "02:34" });
    pays(failedBox, { to: "lucas-…jWmUdk", made: "02:34" });
    // Why it wasn't sent: the wallet closed, or no network.
    expect(closedBox.note).toBe(NOT_SENT_TEXT.closed);
    expect(failedBox.note).not.toBe("");
    // Each: Send it now, or Don't send.
    expect([closedBox.buttons.length, failedBox.buttons.length]).toEqual([2, 2]);

    // Send it now: straight to Review, the same amount, recipient and memo, sent there in its place; nothing dropped.
    closedBox.buttons[0].click();
    await vi.waitFor(() => expect(state.route).toBe("confirm"));
    expect(state.draft).toMatchObject({ to: LUCAS, privacy: "public", amountLux: "10000000", amountDusk: "0.01", memo: "Hors ligne un", replaces: "s1" });
    // Astra's: for the wallet, profile and network it was made on alone, as Review checks.
    const shown = ov([closed, failed]);
    expect(state.draft.reviewedFor).toBe(`${shown.accounts[0]} ${Number(shown.selectedAccountIndex ?? 0)} ${shown.nodeUrl}`);
    expect(actions.send).not.toHaveBeenCalled();

    // Don't send: gone, Home drawn again.
    failedBox.buttons[1].click();
    await vi.waitFor(() => expect(actions.send).toHaveBeenCalledWith({ type: "DUSK_UI_DROP_UNSENT", sendId: "s2" }));
  });

  // Lena's, in the app: "Sending: 0.01 DUSK…", then for 20 s no card, no payment and the old balance.
  it("says one that went out after it waited went, with no button, till its block's in", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(2, 40));
    const { document } = installFakeDom();
    const state = { route: "home", addressBook: { loaded: true, items: [{ address: LUCAS, name: "Lucas (petit-fils)" }] } };
    const actions = { render: vi.fn(async () => {}), showToast: vi.fn(), send: vi.fn(async () => ({ ok: true })) };
    const went = send({ waiting: false, waits: false, went: at(2, 39), hash: "w1".repeat(32) });
    document.body.replaceChildren(...homeView(ov([went]), { state, actions }));
    const [box, ...more] = boxes(document);
    expect(more).toEqual([]);
    pays(box, { memo: "Hors ligne un", made: "02:34" });
    // Nothing to wait for, or to call off: it went.
    expect([box.note, box.buttons]).toEqual(["", []]);
  });

  // Marek's, Lena's, Chen's: "something else" was the very same payment, from another device, and nothing said what.
  it("names what its account sent while a held payment waited, and says so where it's this same payment, Don't send leading", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(2, 40));
    const { document } = installFakeDom();
    const state = { route: "home", addressBook: { loaded: true, items: [{ address: LUCAS, name: "Lucas (petit-fils)" }] } };
    const actions = { render: vi.fn(async () => {}), showToast: vi.fn(), send: vi.fn(async () => ({ ok: true, result: {} })) };
    const OWN_2 = "own-second-account-24ZKdvP2";
    const other = { hash: "ab".repeat(32), to: OWN_2, lux: "1000000", memo: "", at: at(2, 36) };
    const same = { hash: "cd".repeat(32), to: LUCAS, lux: "10000000", memo: "Hors ligne un", at: at(2, 37) };
    // Its note, and the answer it leads with.
    const shown = (meanwhile) => {
      document.body.replaceChildren(...homeView(ov([send({ waits: false, held: true, meanwhile })], { accounts: ["mine", OWN_2] }), { state, actions }));
      const box = document.body.querySelector(".home-waiting--held");
      return { note: visibleText(box.querySelector(".home-waiting__note")), lead: box.querySelector("button.btn-primary") };
    };
    // Something else: how much, to whom and when; Send it too leads, to its Review.
    const elsewhere = shown([other]);
    expect(elsewhere.note).toMatch(/0\.001 DUSK/);
    expect(elsewhere.note).toContain("Profile 2");
    expect(elsewhere.note).toContain("02:36");
    expect(elsewhere.note).not.toMatch(/same/i);
    elsewhere.lead.click();
    await vi.waitFor(() => expect(state.route).toBe("confirm"));
    expect(actions.send).not.toHaveBeenCalled();
    state.route = "home";
    // This same payment: named with its memo, said to look the same, and Don't send leads.
    const again = shown([same, other]);
    expect(again.note).toMatch(/0\.01 DUSK/);
    expect(again.note).toContain("Lucas (petit-fils)");
    expect(again.note).toContain("02:37");
    expect(again.note).toContain("Hors ligne un");
    expect(again.note).toMatch(/same/i);
    again.lead.click();
    await vi.waitFor(() => expect(actions.send).toHaveBeenCalledWith({ type: "DUSK_UI_CANCEL_SEND", sendId: "s1" }));
    expect(state.route).toBe("home");
    // Nothing named: no amount, nor anyone.
    const plain = shown(undefined).note;
    expect(plain).not.toBe("");
    expect(plain).not.toMatch(/DUSK/);

    // Chen's, Marek's: "something else", Send it too live, for the seconds before it named this same payment.
    // While it's read, it says so, its answers off; past the node's time, what's known.
    const checking = (since) => {
      document.body.replaceChildren(...homeView(ov([send({ waits: false, held: true, checking: since })], { accounts: ["mine", OWN_2] }), { state, actions }));
      const box = document.body.querySelector(".home-waiting--held");
      return [visibleText(box.querySelector(".home-waiting__note")), box.querySelectorAll("button").map((b) => b.disabled)];
    };
    const [reading, whileRead] = checking(at(2, 40) - 3_000);
    expect(whileRead).toEqual([true, true]);
    expect(reading).not.toBe("");
    expect(reading).not.toBe(plain);
    expect(checking(at(2, 40) - 60_000)).toEqual([plain, [false, false]]);
  });

  // Chen's: the Wi-Fi dropped as she paid on her first phone, she paid the same from her second, and the first sent
  // its copy too once it had the network back, without asking. Then Chen's again: Send it too paid at once, with no
  // Review; Don't send said a red Send failed.
  it("says one held as its account sent something else while it waited, with what it pays, Send it too through Review and Don't send", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(2, 40));
    const { document } = installFakeDom();
    const state = { route: "home", addressBook: { loaded: true, items: [{ address: LUCAS, name: "Lucas (petit-fils)" }] } };
    const sent = [];
    const actions = {
      render: vi.fn(async () => {}),
      showToast: vi.fn(),
      send: vi.fn(async (message) => {
        sent.push(message);
        return { ok: true, result: message.type === "DUSK_UI_SEND_HELD" ? { sending: true } : { cancelled: true } };
      }),
    };
    const held = send({ waits: false, held: true });
    const stopped = send({ sendId: "s2", memo: "Hors ligne deux", waiting: false, waits: false, ended: "locked", held: true });
    document.body.replaceChildren(...homeView(ov([held, stopped]), { state, actions }));
    const [heldBox, stoppedBox] = boxes(document);
    pays(heldBox, { memo: "Hors ligne un", made: "02:34" });
    pays(stoppedBox, { memo: "Hors ligne deux", made: "02:34" });
    // One still waits, the other stopped as it waited; for each, its account sent something else meanwhile, and it
    // offers Send it too or Don't send.
    expect(heldBox.title).not.toBe(stoppedBox.title);
    expect(heldBox.note).not.toBe("");
    expect(stoppedBox.note).toBe(heldBox.note);
    expect([heldBox.buttons.length, stoppedBox.buttons.length]).toEqual([2, 2]);

    // Send it too: its Review, in its place; nothing goes before Confirm there.
    const buttons = () => document.body.querySelectorAll(".home-waiting button");
    buttons()[0].click();
    await vi.waitFor(() => expect(state.route).toBe("confirm"));
    expect(state.draft).toMatchObject({ to: LUCAS, amountLux: "10000000", memo: "Hors ligne un", replaces: "s1" });
    expect(sent).toEqual([]);
    // Don't send: called off, and said plainly.
    state.route = "home";
    document.body.replaceChildren(...homeView(ov([held, stopped]), { state, actions }));
    buttons()[1].click();
    await vi.waitFor(() => expect(actions.showToast).toHaveBeenCalled());
    expect(sent.at(-1)).toEqual({ type: "DUSK_UI_CANCEL_SEND", sendId: "s1" });
    expect(actions.showToast).toHaveBeenCalledWith(NOT_SENT_CHOSEN_TEXT);
    // One the wallet stopped as it waited for the answer: Send it too opens Review, as Send it now does.
    buttons()[2].click();
    await vi.waitFor(() => expect(state.route).toBe("confirm"));
    expect(state.draft).toMatchObject({ to: LUCAS, amountLux: "10000000", memo: "Hors ligne deux", replaces: "s2" });
  });
});
