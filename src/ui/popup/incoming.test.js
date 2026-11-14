import { afterEach, describe, expect, it, vi } from "vitest";

const ACCOUNTS = [
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927",
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz",
];
const PAYER = "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";
const TOKEN = "ab".repeat(16);

// An open wallet on Testnet, as the overview has it.
const open = (over = {}) => ({
  isUnlocked: true,
  accounts: ACCOUNTS,
  nodeUrl: "https://testnet.nodes.dusk.network",
  archiverUrl: "https://testnet.nodes.dusk.network",
  accountNames: { 0: "Estudio" },
  hideBalances: false,
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fresh() {
  vi.resetModules();
  return import("./incoming.js");
}

// Sofía's: no notice when a client paid her request while the app was in the background.
describe("notices of money coming in, in the app on Android", () => {
  it("gives Android's job public data only: the accounts, each profile as Profile N, .dusk names, the archive, the words", async () => {
    vi.stubGlobal("navigator", { ...globalThis.navigator, language: "es-ES" });
    const { incomingSetup } = await fresh();
    const names = new Map([
      [PAYER, "sofiadesign.dusk"],
      ["someone", null],
    ]);
    expect(incomingSetup(open(), { names })).toEqual({
      // A profile's own label on this device stays on it.
      accounts: [
        { account: ACCOUNTS[0], name: "Profile 1" },
        { account: ACCOUNTS[1], name: "Profile 2" },
      ],
      names: { [PAYER]: "sofiadesign.dusk" },
      archiveUrl: "https://testnet.nodes.dusk.network",
      network: "Testnet",
      title: "You received {amount} DUSK from {name}",
      // Astra's: the lock screen showed the amount and who paid, where the phone hides what notices say.
      publicTitle: "Payment received",
      wallet: ACCOUNTS[0],
      decimal: ",",
      group: ".",
    });
    // Balances hidden: no amount. Turned off in Settings: nothing to look at.
    expect(incomingSetup(open({ hideBalances: true })).title).toBe("You received a payment from {name}");
    expect(incomingSetup(open({ incomingNotices: false }))).toBeNull();
  });

  it("gives it once notices are allowed, with the wallet's token for the taps; again only once it changes; nothing while locked", async () => {
    const { keepIncomingWatched } = await fresh();
    const watch = vi.fn(async () => {});
    const send = vi.fn(async (message) => (message.type === "DUSK_UI_INCOMING_TOKEN" ? { ok: true, token: TOKEN } : {}));
    let allowed = false;
    const keep = (ov, now) => keepIncomingWatched(ov, { send, watch, allowedNow: async () => allowed, now });

    // Notices not allowed: Android looks at nothing.
    await keep(open(), 1_000);
    expect(watch.mock.calls).toEqual([[null]]);
    // Allowed in the phone's settings since: given within a minute.
    allowed = true;
    await keep(open(), 2_000);
    expect(watch).toHaveBeenCalledTimes(1);
    await keep(open(), 62_000);
    expect(watch).toHaveBeenLastCalledWith(expect.objectContaining({ wallet: ACCOUNTS[0], token: TOKEN, accounts: expect.any(Array) }));
    // Drawn again as it is: nothing more; balances hidden since: given again.
    await keep(open(), 63_000);
    expect(watch).toHaveBeenCalledTimes(2);
    await keep(open({ hideBalances: true }), 64_000);
    expect(watch).toHaveBeenCalledTimes(3);
    expect(watch.mock.lastCall[0].title).toBe("You received a payment from {name}");
    // Locked, as when the app locks on leaving: what Android has stays.
    await keep({ isUnlocked: false, accounts: [] }, 65_000);
    expect(watch).toHaveBeenCalledTimes(3);
    // Turned off: Android stops looking.
    await keep(open({ hideBalances: true, incomingNotices: false }), 66_000);
    expect(watch.mock.lastCall).toEqual([null]);
  });

  // Seen on the phone: notices allowed from Settings' switch, and Android's job was given nothing for a minute.
  it("gives it at once once it's turned on in Settings, though it was given a moment before", async () => {
    const { keepIncomingWatched, watchIncomingAgain } = await fresh();
    const watch = vi.fn(async () => {});
    const send = async () => ({ ok: true, token: TOKEN });
    let allowed = false;
    await keepIncomingWatched(open(), { send, watch, allowedNow: async () => allowed, now: 1_000 });
    expect(watch.mock.calls).toEqual([[null]]);
    allowed = true;
    watchIncomingAgain();
    await keepIncomingWatched(open(), { send, watch, allowedNow: async () => allowed, now: 2_000 });
    expect(watch).toHaveBeenLastCalledWith(expect.objectContaining({ token: TOKEN }));
  });
});
