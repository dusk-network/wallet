import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Amélie's: the Wi-Fi off at Confirm, the extension said "Not sent" a second later and never waited, where the web
// wallet waits with Cancel and sends it once the network answers. Chen's: such a send vanished when its page went.

function memoryStorage() {
  const store = new Map();
  return {
    get length() {
      return store.size;
    },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => store.get(String(k)) ?? null,
    setItem: (k, v) => store.set(String(k), String(v)),
    removeItem: (k) => store.delete(String(k)),
    clear: () => store.clear(),
  };
}

const WALLET = "wallet-account";
const NODE = "https://testnet.nodes.dusk.network";
const record = (over = {}) => ({ walletId: WALLET, nodeUrl: NODE, profileIndex: 0, account: "chen-account", privacy: "public", to: "lucas-account", lux: "10000000", feeLux: "2500000", memo: "Hors ligne un", ...over });

// What fails for the network before anything went out, as the engine says it.
const offline = () => Object.assign(new TypeError("Failed to fetch"), { data: { sent: false } });

let waiting;
let host;
let network;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", memoryStorage());
  vi.resetModules();
  waiting = await import("./waitingSends.js");
  network = { answers: false, cancelled: new Set(), handedOver: new Set(), says: "unknown" };
  host = {
    answers: vi.fn(async () => network.answers),
    // Where a payment handed over stands, as the node says it: "in", "absent", "used" or "unknown".
    check: vi.fn(async () => ({ state: typeof network.says === "function" ? network.says() : network.says })),
    // The engine told one handed over never went.
    release: vi.fn(async () => ({ forgotten: true })),
    // The engine's word: called off unless it was handed over.
    cancelInEngine: vi.fn(async (sendId) => {
      if (network.handedOver.has(sendId)) return { cancelled: false };
      network.cancelled.add(sendId);
      return { cancelled: true };
    }),
    // Handed over, or maybe: what the wallet follows by its ID.
    follow: vi.fn(async () => {}),
    tell: vi.fn(),
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// The pause before the network is asked again, gone by.
const askAgain = () => vi.advanceTimersByTimeAsync(waiting.ASK_AGAIN_AFTER_MS);
const kept = () => waiting.waitingSendsOf({ walletId: WALLET, nodeUrl: NODE });
const told = () => host.tell.mock.calls.map(([m]) => `${m.sendId} ${m.waits ? "waits" : "goes"}`);

describe("a payment from Send that couldn't reach the network before it went out", () => {
  it("waits for the network, kept meanwhile, and goes out once, once it answers", async () => {
    const attempt = vi.fn().mockRejectedValueOnce(offline()).mockResolvedValueOnce({ hash: "aa" });
    const sent = waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt, host });
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toHaveBeenCalledOnce();
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", memo: "Hors ligne un", waiting: true, waits: true })]);

    // Asked again a little on: no answer, it waits on, tried no more.
    await askAgain();
    expect(host.answers).toHaveBeenCalledOnce();
    expect(attempt).toHaveBeenCalledOnce();

    // It answers: made again, it goes out, and nothing of it is kept.
    network.answers = true;
    await askAgain();
    await expect(sent).resolves.toEqual({ hash: "aa" });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(told()).toEqual(["s1 waits", "s1 goes"]);
    expect(await kept()).toEqual([]);
  });

  // Chen's, on Android: back from the pocket, a payment that waited stayed unsent for over a minute: the timer
  // set while the app was away came long after its time.
  it("is tried again as soon as the wallet's page shows again, not only once a timer comes", async () => {
    const page = Object.assign(new EventTarget(), { visibilityState: "hidden" });
    vi.stubGlobal("document", page);
    const attempt = vi.fn().mockRejectedValueOnce(offline()).mockResolvedValueOnce({ hash: "a0" });
    const sent = waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt, host });
    await vi.advanceTimersByTimeAsync(0);
    network.answers = true;
    // Shown again, well before the timer: asked at once, and it goes out.
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    await expect(sent).resolves.toEqual({ hash: "a0" });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("isn't kept after, and fails at once, for anything but the network", async () => {
    const refused = Object.assign(new Error("Insufficient balance"), { data: { sent: false } });
    await expect(waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt: vi.fn().mockRejectedValue(refused), host })).rejects.toBe(refused);
    // A shielded one that may have gone out isn't made again: it's followed by its ID.
    const unclear = Object.assign(new TypeError("Failed to fetch"), { data: { sent: "unknown", hash: "bb" } });
    const attempt = vi.fn().mockRejectedValue(unclear);
    await expect(waiting.sendWhenReachable({ sendId: "s2", record: record({ privacy: "shielded" }), attempt, host })).rejects.toBe(unclear);
    expect(attempt).toHaveBeenCalledOnce();
    expect(await kept()).toEqual([]);
  });

  // Astra's: a shielded payment whose proving lost the network failed, as the engine words that its own way.
  it("waits for the network where the engine says it couldn't reach it in its own words, as the prover's", async () => {
    const prover = () =>
      Object.assign(new Error("Could not reach prover (testnet.provers.dusk.network). The prover may be down or dropped the connection. Shielded transactions need a prover. Check Settings → Prover URL."), {
        data: { unreachable: true, sent: false },
      });
    const attempt = vi.fn().mockRejectedValueOnce(prover()).mockRejectedValueOnce(prover()).mockResolvedValueOnce({ hash: "ab" });
    const sent = waiting.sendWhenReachable({ sendId: "s1", record: record({ privacy: "shielded" }), attempt, host });
    await vi.advanceTimersByTimeAsync(0);
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", waiting: true, waits: true })]);
    network.answers = true;
    // Out of reach again on its next try: it waits on, not ended.
    await askAgain();
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", waiting: true, waits: true })]);
    await askAgain();
    await expect(sent).resolves.toEqual({ hash: "ab" });
  });

  it("go out one at a time, in the order they were made, and a new one waits behind them", async () => {
    const order = [];
    const out = (name) => {
      order.push(`${name} begins`);
      return new Promise((resolve) =>
        setTimeout(() => {
          order.push(`${name} out`);
          resolve(name);
        }, 100)
      );
    };
    const first = vi.fn().mockRejectedValueOnce(offline()).mockImplementation(() => out("first"));
    const one = waiting.sendWhenReachable({ sendId: "s1", record: record({ memo: "Hors ligne un" }), attempt: first, host });
    await vi.advanceTimersByTimeAsync(0);
    // Made while one waits: it waits behind it, untried.
    const second = vi.fn(() => out("second"));
    const two = waiting.sendWhenReachable({ sendId: "s2", record: record({ memo: "Hors ligne deux" }), attempt: second, host });
    await vi.advanceTimersByTimeAsync(0);
    expect(second).not.toHaveBeenCalled();
    // Made while two wait, the network back: it isn't tried before them.
    const third = vi.fn(() => out("third"));
    const three = waiting.sendWhenReachable({ sendId: "s3", record: record({ memo: "Trois" }), attempt: third, host });
    expect(third).not.toHaveBeenCalled();
    expect((await kept()).map((send) => send.memo)).toEqual(["Hors ligne un", "Hors ligne deux", "Trois"]);

    network.answers = true;
    await askAgain();
    await vi.advanceTimersByTimeAsync(300);
    await expect(Promise.all([one, two, three])).resolves.toEqual(["first", "second", "third"]);
    expect(order).toEqual(["first begins", "first out", "second begins", "second out", "third begins", "third out"]);
  });
});

describe("Cancel on a waiting payment", () => {
  it("calls it off at once while it waits: nothing sent, nothing kept, and it's tried no more", async () => {
    const attempt = vi.fn().mockRejectedValue(offline());
    const sent = waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt, host });
    const settled = sent.catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    await expect(waiting.cancelWaitingSend("s1", host)).resolves.toBe(true);
    const error = await settled;
    expect(error.message).toBe("You cancelled it, so nothing was sent.");
    expect(error.data).toEqual({ sent: false, cancelled: true });
    expect(await kept()).toEqual([]);

    network.answers = true;
    await askAgain();
    expect(attempt).toHaveBeenCalledOnce();
    expect(network.cancelled.has("s1")).toBe(true);
  });

  // Astra's: Cancel during the first try, the network gone, said done; the try then joined the payments waiting.
  it("called off during its first try, is never put to wait after it", async () => {
    const first = Promise.withResolvers();
    const attempt = vi.fn(() => first.promise);
    const sent = waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt, host }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    await expect(waiting.cancelWaitingSend("s1", host)).resolves.toBe(true);
    first.reject(offline());
    const error = await sent;
    expect(error.message).toBe("You cancelled it, so nothing was sent.");
    expect(await kept()).toEqual([]);
    expect(told()).toEqual([]);
    network.answers = true;
    await askAgain();
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("is the engine's to settle while it's being tried: one handed over goes on, and says it can't be cancelled", async () => {
    const out = Promise.withResolvers();
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(offline())
      .mockImplementationOnce(() => {
        network.handedOver.add("s1");
        return out.promise;
      });
    const sent = waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt, host });
    await vi.advanceTimersByTimeAsync(0);
    network.answers = true;
    await askAgain();
    expect(attempt).toHaveBeenCalledTimes(2);

    await expect(waiting.cancelWaitingSend("s1", host)).resolves.toBe(false);
    out.resolve({ hash: "cc" });
    await expect(sent).resolves.toEqual({ hash: "cc" });
  });
});

describe("a shielded waiting payment that may have gone out", () => {
  // Astra's: a try that reached the node and lost its answer was kept as not sent, with Send it now: a second payment.
  it("is followed by its ID where its try's answer was lost, never kept as not sent, never made again", async () => {
    const lost = Object.assign(new TypeError("Failed to fetch"), { data: { sent: "unknown", hash: "dd" } });
    const attempt = vi.fn().mockRejectedValueOnce(offline()).mockRejectedValueOnce(lost);
    const sent = waiting.sendWhenReachable({ sendId: "s1", record: record({ privacy: "shielded" }), attempt, host }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    network.answers = true;
    await askAgain();
    const error = await sent;
    expect(error.data).toMatchObject({ sent: "unknown", hash: "dd" });
    expect(await kept()).toEqual([]);
    expect(host.follow).toHaveBeenCalledWith({ record: expect.objectContaining({ sendId: "s1", memo: "Hors ligne un" }), hash: "dd", unclear: true });
    await askAgain();
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(host.check).not.toHaveBeenCalled();
  });

  // Astra's: the wallet stopped as a try reached the node; back, Home said nothing was sent, and offered it again.
  it("keeps its ID before it's handed over, and is followed by it after the wallet stopped during the try, never said not sent", async () => {
    // The engine tells of it with its ID before the hand-over; the wallet stops before its answer.
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(offline())
      .mockImplementationOnce(async ({ waited }) => {
        expect(waited).toBe(true);
        await waiting.noteHandingOver("s1", "ee", host);
        return new Promise(() => {});
      });
    waiting.sendWhenReachable({ sendId: "s1", record: record({ privacy: "shielded" }), attempt, host }).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    network.answers = true;
    await askAgain();
    expect(attempt).toHaveBeenCalledTimes(2);

    // Started again, nothing here waits on it: not "nothing was sent", but followed by its ID.
    vi.resetModules();
    waiting = await import("./waitingSends.js");
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", unclear: true, waiting: true })]);
    await waiting.followHandedOver(host);
    expect(host.follow).toHaveBeenCalledWith({ record: expect.objectContaining({ sendId: "s1", hash: "ee" }), hash: "ee", unclear: true });
    expect(JSON.parse(localStorage.getItem("dusk_waiting_sends_v1"))).toEqual({});
  });

  // Astra's: where following it by its ID couldn't be kept, its record went with its ID: found by nothing after.
  it("keeps its record and ID where it can't be followed by that ID yet, followed the next time the wallet starts", async () => {
    const lost = Object.assign(new TypeError("Failed to fetch"), { data: { sent: "unknown", hash: "d1" } });
    const attempt = vi.fn().mockRejectedValueOnce(offline()).mockRejectedValueOnce(lost);
    host.follow = vi.fn().mockRejectedValueOnce(new Error("Storage is full"));
    const sent = waiting.sendWhenReachable({ sendId: "s1", record: record({ privacy: "shielded" }), attempt, host }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    network.answers = true;
    await askAgain();
    expect((await sent).data).toMatchObject({ sent: "unknown", hash: "d1" });
    // Not said not sent, and its ID kept.
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", unclear: true, waiting: true })]);
    expect(JSON.parse(localStorage.getItem("dusk_waiting_sends_v1")).s1).toMatchObject({ sendId: "s1", hash: "d1" });
    // Started again, it's followed by that ID.
    host.follow = vi.fn(async () => {});
    await waiting.followHandedOver(host);
    expect(host.follow).toHaveBeenCalledWith({ record: expect.objectContaining({ sendId: "s1", hash: "d1" }), hash: "d1", unclear: true });
    expect(JSON.parse(localStorage.getItem("dusk_waiting_sends_v1"))).toEqual({});
  });

  it("is kept as not sent where its ID was kept but it was never handed over, as when the engine had no word back", async () => {
    const unkept = Object.assign(new Error("The payment couldn't be kept on this device before it went out, so nothing was sent."), { data: { sent: false } });
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(offline())
      .mockImplementationOnce(async () => {
        await waiting.noteHandingOver("s1", "ff", host);
        throw unkept;
      });
    const sent = waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt, host }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    network.answers = true;
    await askAgain();
    expect(await sent).toBe(unkept);
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", ended: "failed" })]);
    expect((await kept())[0].hash).toBeUndefined();
    expect(host.follow).not.toHaveBeenCalled();
  });

  it("is kept as not sent only where its try never handed it over, or the node turned it down", async () => {
    // Its try ended before the hand-over, no ID kept: nothing went out.
    const stopped = new Error("The message port closed before a response was received.");
    const attempt = vi.fn().mockRejectedValueOnce(offline()).mockRejectedValueOnce(stopped);
    const sent = waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt, host }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    network.answers = true;
    await askAgain();
    expect(await sent).toBe(stopped);
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", ended: "failed" })]);
    expect(host.follow).not.toHaveBeenCalled();
  });
});

describe("a payment from Send as it's confirmed", () => {
  // Sofía's, on Android: Confirm with the signal going, then Android ended the app; back, the payment had
  // vanished, with no "Not sent" card and nothing in Activity, as nothing was kept during its first try.
  it("is kept before its first try: a wallet that closes during the try finds it, said not sent", async () => {
    const attempt = vi.fn(() => new Promise(() => {}));
    waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt, host }).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toHaveBeenCalledOnce();
    // Being sent: on Home as such, with Cancel.
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", memo: "Hors ligne un", waiting: true, waits: false })]);
    expect((await kept())[0].unclear).toBeUndefined();

    // Android ends the app during the try: started again, it's there, said not sent, never handed over.
    vi.resetModules();
    waiting = await import("./waitingSends.js");
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", waiting: false, ended: "closed" })]);
    expect(waiting.NOT_SENT_TEXT.closed).toBe("The wallet closed before the network answered, so nothing was sent.");
  });

  it("handed over during its first try as the wallet closed, is asked of the node after, never said not sent before", async () => {
    const attempt = vi.fn(async () => {
      await waiting.noteHandingOver("s1", { hash: "f1", nonce: "131" }, host);
      return new Promise(() => {});
    });
    waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt, host }).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(told()).toEqual(["s1 goes"]);
    expect(host.tell).toHaveBeenLastCalledWith({ type: "DUSK_UI_SEND_WAITING", sendId: "s1", waits: false, handedOver: true });
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", waiting: true, unclear: true })]);

    vi.resetModules();
    waiting = await import("./waitingSends.js");
    // Not "nothing was sent": it may have gone, till the node's asked.
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", hash: "f1", nonce: "131", waiting: true, unclear: true, checks: true })]);
    // The node can't be asked yet: as it was.
    await waiting.followHandedOver(host);
    expect(host.check).toHaveBeenCalledWith(expect.objectContaining({ sendId: "s1", account: "chen-account", hash: "f1", nonce: "131" }));
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", unclear: true, checks: true })]);
    // In the node's mempool: it went, followed as sent, and its record goes.
    network.says = "in";
    await waiting.followHandedOver(host);
    expect(host.follow).toHaveBeenCalledWith({ record: expect.objectContaining({ sendId: "s1", hash: "f1" }), hash: "f1" });
    expect(await kept()).toEqual([]);
  });

  it("isn't sent where it can't be kept first", async () => {
    vi.stubGlobal("localStorage", { ...memoryStorage(), getItem: () => null, setItem: () => {
      throw new Error("Storage is full");
    } });
    const attempt = vi.fn();
    const error = await waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt, host }).catch((e) => e);
    expect(error.data).toMatchObject({ sent: false });
    expect(attempt).not.toHaveBeenCalled();
  });
});

describe("a payment sent again from Home's Send it now", () => {
  // Chen's, Sofía's, Nandini's and Amélie's: Send it now dropped the notice before anything was sent again.
  const unsent = () => localStorage.setItem("dusk_waiting_sends_v1", JSON.stringify({ old: { ...record(), sendId: "old", at: 1, ended: "closed" } }));

  it("takes the place of the one Home said wasn't sent, one notice throughout, gone once it's handed over", async () => {
    unsent();
    const out = Promise.withResolvers();
    const attempt = vi.fn(async () => {
      await waiting.noteHandingOver("s1", { hash: "e1", nonce: "7" }, host);
      return out.promise;
    });
    const sent = waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt, host, replaces: "old" });
    await vi.advanceTimersByTimeAsync(0);
    expect((await kept()).map((send) => send.sendId)).toEqual(["s1"]);
    out.resolve({ hash: "e1" });
    await expect(sent).resolves.toEqual({ hash: "e1" });
    expect(await kept()).toEqual([]);
  });

  it("turned down before it's handed over, or called off, gives the one Home said wasn't sent its place back", async () => {
    unsent();
    const refused = Object.assign(new Error("Insufficient balance"), { data: { sent: false } });
    await expect(waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt: vi.fn().mockRejectedValue(refused), host, replaces: "old" })).rejects.toBe(refused);
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "old", waiting: false, ended: "closed" })]);

    // Waiting for the network, then called off: the same.
    const sent = waiting.sendWhenReachable({ sendId: "s2", record: record(), attempt: vi.fn().mockRejectedValue(offline()), host, replaces: "old" }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect((await kept()).map((send) => [send.sendId, send.waiting])).toEqual([["s2", true]]);
    await expect(waiting.cancelWaitingSend("s2", host)).resolves.toBe(true);
    expect((await sent).data).toMatchObject({ cancelled: true });
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "old", waiting: false, ended: "closed" })]);
  });

  // Astra's: Send it now sent from the profile, wallet or network chosen since, and the first one's record went.
  it("is refused from another wallet, profile or network, or as another payment, the one Home said wasn't sent kept", async () => {
    for (const other of [{ profileIndex: 1, account: "another-account" }, { nodeUrl: "https://nodes.dusk.network" }, { walletId: "another-wallet" }, { lux: "20000000" }, { memo: "Autre" }]) {
      unsent();
      const attempt = vi.fn();
      const error = await waiting.sendWhenReachable({ sendId: "s1", record: record(other), attempt, host, replaces: "old" }).catch((e) => e);
      expect([error.message, error.data?.sent], JSON.stringify(other)).toEqual([waiting.NOT_IN_PLACE_TEXT, false]);
      expect(attempt).not.toHaveBeenCalled();
      expect(JSON.parse(localStorage.getItem("dusk_waiting_sends_v1"))).toEqual({ old: expect.objectContaining({ sendId: "old", ended: "closed" }) });
    }
  });

  it("closed on as it waits, is the one notice left", async () => {
    unsent();
    waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt: vi.fn().mockRejectedValue(offline()), host, replaces: "old" }).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    vi.resetModules();
    waiting = await import("./waitingSends.js");
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", waiting: false, ended: "closed" })]);
  });
});

// Astra's: the extension's background started again while the engine, in its own page, was handing a public payment
// over. The node didn't have it yet, so it was said not sent, with Send it now, and then the engine handed it over.
describe("a payment the engine hands over after the wallet's background started again", () => {
  it("is never said not sent while the engine is still handing it over, and is followed once the node has it", async () => {
    localStorage.setItem("dusk_waiting_sends_v1", JSON.stringify({ s1: { ...record(), sendId: "s1", at: 1 } }));
    vi.resetModules();
    waiting = await import("./waitingSends.js");
    let underWay = true;
    host.underWay = vi.fn(async () => underWay);
    network.says = "absent";
    await expect(waiting.noteHandingOver("s1", { hash: "d1", nonce: "9" }, host)).resolves.toBe(true);
    // Not said not sent, nor its nonce given back: still being sent, its ID and nonce kept.
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", hash: "d1", nonce: "9", waiting: true })]);
    expect(host.release).not.toHaveBeenCalled();
    await waiting.followHandedOver(host);
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", hash: "d1", waiting: true })]);

    // Handed over since: the node has it, and it's followed as a sent one.
    underWay = false;
    network.says = "in";
    await waiting.followHandedOver(host);
    expect(host.follow).toHaveBeenCalledWith(expect.objectContaining({ hash: "d1" }));
    expect(await kept()).toEqual([]);
  });

  it("is said not sent once the engine is done with it and the node never had it", async () => {
    localStorage.setItem("dusk_waiting_sends_v1", JSON.stringify({ s1: { ...record(), sendId: "s1", at: 1, hash: "d2", nonce: "9" } }));
    vi.resetModules();
    waiting = await import("./waitingSends.js");
    host.underWay = vi.fn(async () => false);
    network.says = "absent";
    await waiting.followHandedOver(host);
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", waiting: false, ended: "closed" })]);
  });
});

describe("a public payment handed to the node without a clear answer", () => {
  // Chen's, on Android: confirmed as the Wi-Fi died, the phone pocketed. Back, the app said "It may still have reached
  // the network" and Activity "Sent −0.01", though the node never had it and nothing ever left.
  const lost = (hash) => Object.assign(new TypeError("Failed to fetch"), { data: { sent: "unknown", hash } });
  // A try that hands it over, the ID and nonce noted first, and loses the answer.
  const handsOverAndLoses = (hash, nonce = "131") => async () => {
    await waiting.noteHandingOver("s1", { hash, nonce }, host);
    throw lost(hash);
  };

  it("isn't said sent, nor kept as a sent one, and is asked of the node once it answers: there, it went", async () => {
    const attempt = vi.fn().mockImplementationOnce(handsOverAndLoses("c1")).mockResolvedValueOnce({ hash: "c1", from: "found" });
    const sent = waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt, host });
    await vi.advanceTimersByTimeAsync(0);
    // Waiting, maybe gone, never followed as a send with no clear answer.
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", waiting: true, waits: true, unclear: true })]);
    expect(host.follow).not.toHaveBeenCalled();
    expect(host.tell).toHaveBeenLastCalledWith({ type: "DUSK_UI_SEND_WAITING", sendId: "s1", waits: true, handedOver: true });

    // No network: nothing asked.
    await askAgain();
    expect(host.check).not.toHaveBeenCalled();
    network.answers = true;
    network.says = "in";
    await askAgain();
    await expect(sent).resolves.toEqual({ hash: "c1", from: "found" });
    expect(attempt).toHaveBeenLastCalledWith({ found: { hash: "c1", nonce: "131" } });
    expect(await kept()).toEqual([]);
  });

  it("nowhere, and its nonce unused, goes out once more as the very transaction made for it", async () => {
    const attempt = vi.fn().mockImplementationOnce(handsOverAndLoses("c2")).mockResolvedValueOnce({ hash: "c2" });
    const sent = waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt, host });
    await vi.advanceTimersByTimeAsync(0);
    network.answers = true;
    network.says = "absent";
    await askAgain();
    await expect(sent).resolves.toEqual({ hash: "c2" });
    // Sent again as it was made: never made again, never twice.
    expect(attempt.mock.calls).toEqual([[{ waited: false }], [{ resend: true }]]);
    expect(host.release).not.toHaveBeenCalled();
    expect(await kept()).toEqual([]);
  });

  it("waits, maybe gone, while the node can't be asked, and holds the payments after it", async () => {
    const attempt = vi.fn(handsOverAndLoses("c3"));
    waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt, host }).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const second = vi.fn(async () => ({ hash: "d3" }));
    waiting.sendWhenReachable({ sendId: "s2", record: record({ memo: "Deux" }), attempt: second, host }).catch(() => {});
    network.answers = true;
    await askAgain();
    await askAgain();
    expect(host.check).toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect((await kept()).map((send) => [send.sendId, send.waiting, Boolean(send.unclear)])).toEqual([
      ["s1", true, true],
      ["s2", true, false],
    ]);
  });

  it("can't be called off: it may have gone", async () => {
    waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt: vi.fn(handsOverAndLoses("c4")), host }).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await expect(waiting.cancelWaitingSend("s1", host)).resolves.toBe(false);
    expect(host.cancelInEngine).not.toHaveBeenCalled();
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", unclear: true })]);
  });

  it("whose nonce another transaction took, is said not sent once the chain still hasn't it a while on", async () => {
    const sent = waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt: vi.fn(handsOverAndLoses("c5")), host }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    network.answers = true;
    network.says = "used";
    // The chain's list a moment behind: not yet.
    await askAgain();
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", unclear: true })]);
    await vi.advanceTimersByTimeAsync(waiting.USED_FOR_MS);
    const error = await sent;
    expect(error.message).toBe(waiting.REPLACED_TEXT);
    expect(error.data).toMatchObject({ sent: false });
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", waiting: false, ended: "failed", error: waiting.REPLACED_TEXT })]);
    expect((await kept())[0].hash).toBeUndefined();
    expect(host.release).toHaveBeenCalledWith("s1");
  });

  it("sent again and turned down, is asked again, and said not sent with why once the node still hasn't it", async () => {
    const refused = Object.assign(new Error("The node refused it: there isn't enough to pay for it."), { data: { sent: false } });
    const attempt = vi.fn().mockImplementationOnce(handsOverAndLoses("c6")).mockRejectedValue(refused);
    const sent = waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt, host }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    network.answers = true;
    network.says = "absent";
    await askAgain();
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", unclear: true })]);
    await askAgain();
    expect(await sent).toBe(refused);
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", waiting: false, ended: "failed", error: refused.message })]);
  });

  it("as the wallet locks, is kept with its ID, maybe sent; once it's open, the node never having had it, it's said not sent", async () => {
    const sent = waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt: vi.fn(handsOverAndLoses("c7")), host }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    await waiting.stopWaitingSends("locked", host);
    const error = await sent;
    expect(error.data).toMatchObject({ sent: "unknown", hash: "c7" });
    expect(error.message).not.toMatch(/nothing was sent/i);
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", unclear: true, checks: true })]);
    // Back, the node asked: it never had it, and its nonce is unused.
    network.says = "absent";
    await waiting.followHandedOver(host);
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", waiting: false, ended: "locked" })]);
    expect((await kept())[0].hash).toBeUndefined();
    expect(host.release).toHaveBeenCalledWith("s1");
    // Don't send forgets it now; before, while it might have gone, it couldn't.
    await expect(waiting.dropUnsent("s1")).resolves.toBe(true);
  });

  it("can't be dropped while it may have gone out", async () => {
    localStorage.setItem("dusk_waiting_sends_v1", JSON.stringify({ s1: { ...record(), sendId: "s1", at: 1, hash: "c8", nonce: "9" } }));
    await expect(waiting.dropUnsent("s1")).resolves.toBe(false);
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", unclear: true })]);
  });
});

describe("a waiting payment as the wallet stops waiting for it", () => {
  it("ends as the wallet locks, kept as not sent with why, and never goes out after", async () => {
    const attempt = vi.fn().mockRejectedValue(offline());
    const sent = waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt, host }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    await waiting.stopWaitingSends("locked", host);
    expect((await sent).message).toBe("The wallet locked before the network answered, so nothing was sent.");
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", waiting: false, ended: "locked" })]);

    network.answers = true;
    await askAgain();
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("is said not sent where the wallet closed on it, never sent by itself, and Drop forgets it", async () => {
    // Kept by a page or a worker that's gone: nothing here waits for it.
    localStorage.setItem("dusk_waiting_sends_v1", JSON.stringify({ old: { ...record(), sendId: "old", at: 1 } }));
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "old", waiting: false, ended: "closed" })]);
    expect(waiting.NOT_SENT_TEXT.closed).toBe("The wallet closed before the network answered, so nothing was sent.");
    await expect(waiting.dropUnsent("old")).resolves.toBe(true);
    expect(await kept()).toEqual([]);
  });

  it("is kept with what it ran into once the network answered and it failed, till the wallet says so", async () => {
    const refused = Object.assign(new Error("Insufficient balance"), { data: { sent: false } });
    const attempt = vi.fn().mockRejectedValueOnce(offline()).mockRejectedValueOnce(refused);
    const sent = waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt, host }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    network.answers = true;
    await askAgain();
    expect(await sent).toBe(refused);
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", waiting: false, ended: "failed", error: "Insufficient balance" })]);
  });
});

describe("what's kept of a payment from Send's message", () => {
  it("is whose, where, and what it pays, never more", () => {
    const message = {
      type: "DUSK_UI_SEND_TX",
      walletId: WALLET,
      sendTicket: "a ticket",
      feeCapLux: "2500000",
      toName: "lucas.dusk",
      params: { kind: "transfer", privacy: "public", to: "lucas-account", amount: "10000000", memo: "Hors ligne un", profileIndex: 1, _approvalContext: { walletId: WALLET, profileIndex: 1, account: "acct", nodeUrl: NODE } },
    };
    expect(waiting.waitingRecordOf(message)).toEqual({
      walletId: WALLET,
      nodeUrl: NODE,
      profileIndex: 1,
      account: "acct",
      privacy: "public",
      to: "lucas-account",
      toName: "lucas.dusk",
      lux: "10000000",
      feeLux: "2500000",
      memo: "Hors ligne un",
    });
  });
});
