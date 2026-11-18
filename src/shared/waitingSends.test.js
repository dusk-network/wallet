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
    // Where a payment handed over stands, as the node says it: "in", "absent", "replaced", "used" or "unknown".
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

// Chen's, in the Android app: a payment confirmed as the signal dropped went out only once he opened the app again.
// What hasn't reached the node yet is what the app's notice says waits for it to be opened again.
describe("the payments that haven't reached the node", () => {
  it("are those on their first try or waiting, said as a first try begins, and not once handed over, sent or called off", async () => {
    const ids = () => waiting.waitingForNetwork().map(({ sendId, walletId, nodeUrl }) => `${sendId} ${walletId === WALLET} ${nodeUrl === NODE}`);
    host.changed = vi.fn();
    // The first try, under way: it hasn't reached the node, and it's said.
    const first = Promise.withResolvers();
    const attempt = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ hash: "aa" });
    const sent = waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt, host });
    await vi.advanceTimersByTimeAsync(0);
    expect([ids(), host.changed]).toEqual([["s1 true true"], expect.any(Function)]);
    expect(host.changed).toHaveBeenCalledOnce();
    // It couldn't reach the network: it waits, as one more behind it does.
    first.reject(offline());
    const other = waiting.sendWhenReachable({ sendId: "s2", record: record({ memo: "Hors ligne deux" }), attempt: vi.fn().mockRejectedValue(offline()), host });
    await vi.advanceTimersByTimeAsync(0);
    expect(ids()).toEqual(["s1 true true", "s2 true true"]);
    // Called off, it's no longer one; sent, nor is the other.
    await waiting.cancelWaitingSend("s2", host);
    await expect(other).rejects.toMatchObject({ data: { cancelled: true } });
    network.answers = true;
    await askAgain();
    await expect(sent).resolves.toEqual({ hash: "aa" });
    expect(ids()).toEqual([]);
  });

  it("isn't one handed over without a clear answer: it may have gone out", async () => {
    const attempt = vi.fn().mockRejectedValue(Object.assign(new TypeError("Failed to fetch"), { data: { sent: "unknown", hash: "ab".repeat(32) } }));
    waiting.sendWhenReachable({ sendId: "s3", record: record(), attempt, host }).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(waiting.waitingForNetwork()).toEqual([]);
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

  // Marek's: the browser died before a payment left it; the account's next send took its nonce; still "Not
  // confirmed" and "on its way" 47 minutes on. Asked of a node as it is, with the wallet's own lookup.
  it("crashed before it went out, its nonce then taken by another send: not sent once that send is seen at it, never before", async () => {
    const LOST = "f1".repeat(32);
    const NEXT = "f2".repeat(32);
    const { handedOverState } = await import("./txLifecycle.js");
    // The node: the next send in its chain at nonce 131, the account's nonce 131; the archive's list of the
    // account's sends behind it at first.
    const node = { listed: false };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const body = String(init?.body ?? "");
        const json = (value) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
        if (String(url).endsWith("/on/account:chen-account/status")) return json({ balance: 1, nonce: 131 });
        if (body.includes("mempoolTxs")) return json({ mempoolTxs: [] });
        if (body.includes("lastBlockPair")) return json({ pair: { json: { last_block: [4860000, "aa"], last_finalized_block: [4859998, "bb"] } } });
        if (body.includes("moonlightHistory(sender:")) return json({ h: node.listed ? { json: [{ block_height: 4859990, origin: NEXT, events: [] }] } : null });
        if (body.includes(`t0: tx(hash: "${NEXT}")`)) return json({ t0: { tx: { json: JSON.stringify({ type: "moonlight", sender: "chen-account", receiver: "lucas-account", value: 1, nonce: 131 }) } } });
        if (body.includes("tx(hash:")) return json({ tx: null });
        throw new Error(`Not asked of this node: ${body}`);
      })
    );
    host.check = vi.fn((kept) => handedOverState(kept.nodeUrl, kept));
    // Handed over as the browser died: the node never got it.
    const attempt = vi.fn(async () => {
      await waiting.noteHandingOver("s1", { hash: LOST, nonce: "131" }, host);
      return new Promise(() => {});
    });
    waiting.sendWhenReachable({ sendId: "s1", record: record({ at: Date.now() }), attempt, host }).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    vi.resetModules();
    waiting = await import("./waitingSends.js");

    // Back, and another send since took its nonce: the account's nonce is past it, but that send isn't listed yet.
    await waiting.followHandedOver(host);
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", waiting: true, unclear: true, checks: true })]);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await waiting.followHandedOver(host);
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", waiting: true, unclear: true, checks: true })]);
    expect(host.release).not.toHaveBeenCalled();

    // Listed: the account's send at its nonce is another. Not sent, with Send it now and Don't send on Home.
    node.listed = true;
    await waiting.followHandedOver(host);
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", waiting: false, ended: "failed", error: waiting.REPLACED_TEXT })]);
    expect(host.release).toHaveBeenCalledWith("s1");
    expect(host.follow).not.toHaveBeenCalled();
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

  // Issue #214: one kept by an earlier version, which kept no account, was refused as "changed" from where it was made.
  it("takes the place of one kept by an earlier version, which names no account, from the same wallet and profile", async () => {
    const { account: _account, ...earlier } = record();
    localStorage.setItem("dusk_waiting_sends_v1", JSON.stringify({ old: { ...earlier, sendId: "old", at: 1, ended: "closed" } }));
    const attempt = vi.fn(async () => ({ hash: "e2" }));
    await expect(waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt, host, replaces: "old" })).resolves.toEqual({ hash: "e2" });
    expect(attempt).toHaveBeenCalledOnce();
    // From another profile, still refused.
    localStorage.setItem("dusk_waiting_sends_v1", JSON.stringify({ old: { ...earlier, sendId: "old", at: 1, ended: "closed" } }));
    const error = await waiting.sendWhenReachable({ sendId: "s2", record: record({ profileIndex: 1, account: "another-account" }), attempt, host, replaces: "old" }).catch((e) => e);
    expect(error.message).toBe(waiting.NOT_IN_PLACE_TEXT);
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
    // Said Sent, by its ID, till its block's in (forgetWent).
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", hash: "c1", waiting: false, went: expect.any(Number) })]);
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
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", hash: "c2", waiting: false, went: expect.any(Number) })]);
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

  // Marek's: the account's nonce gone past a payment isn't proof it never went; the transaction seen at its nonce is.
  it("whose nonce another transaction took, is said not sent once that transaction is seen, never on the nonce alone", async () => {
    const sent = waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt: vi.fn(handsOverAndLoses("c5")), host }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    network.answers = true;
    network.says = "used";
    // The nonce gone past it, nothing seen at it: however long, it may have gone.
    await askAgain();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", unclear: true })]);
    expect(host.release).not.toHaveBeenCalled();
    network.says = "replaced";
    await askAgain();
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

describe("a payment that went out after it waited", () => {
  // Lena's, in the app: "Sending: 0.01 DUSK…" on Home, then for 20 s no card, no payment and the old balance, till
  // its block came in.
  const goesOut = async (hash = "w1") => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(offline())
      .mockImplementationOnce(async () => {
        // The engine notes its transaction's ID and nonce before it hands it over.
        await waiting.noteHandingOver("s1", { hash, nonce: "42" }, host);
        return { hash };
      });
    const sent = waiting.sendWhenReachable({ sendId: "s1", record: record(), attempt, host });
    await vi.advanceTimersByTimeAsync(0);
    network.answers = true;
    await askAgain();
    await expect(sent).resolves.toEqual({ hash });
  };

  it("is said Sent, by its ID, till its block's in and the balance read since, never in neither list", async () => {
    await goesOut();
    const went = [expect.objectContaining({ sendId: "s1", hash: "w1", waiting: false, went: expect.any(Number) })];
    expect(await kept()).toEqual(went);
    // Never asked of the node as one handed over, nor dropped.
    await waiting.followHandedOver(host);
    expect(host.check).not.toHaveBeenCalled();
    await expect(waiting.dropUnsent("s1")).resolves.toBe(false);
    // On its way still, or done with the balance not read since: said Sent.
    await waiting.forgetWent({ walletId: WALLET, nodeUrl: NODE }, [{ hash: "w1", status: "submitted" }]);
    await waiting.forgetWent({ walletId: WALLET, nodeUrl: NODE }, [{ hash: "w1", status: "executed" }], { balanceRead: false });
    await waiting.forgetWent({ walletId: WALLET, nodeUrl: NODE }, null);
    expect(await kept()).toEqual(went);
    // Another wallet's or node's sends say nothing of it.
    await waiting.forgetWent({ walletId: "another", nodeUrl: NODE }, []);
    expect(await kept()).toEqual(went);
    // In its block, the balance read after: gone.
    await waiting.forgetWent({ walletId: WALLET, nodeUrl: NODE }, [{ hash: "w1", status: "executed" }]);
    expect(await kept()).toEqual([]);
  });

  // Lena's, in the app again: it went out as Home read the wallet, after the sends were read, and that read forgot
  // it as gone from them: no card, no payment and the old balance for 20 s.
  it("is said Sent still after a read of the sends begun before it went out, which can't have it", async () => {
    const read = waiting.sendsReadBegins();
    await goesOut("w4");
    await waiting.forgetWent({ walletId: WALLET, nodeUrl: NODE }, [], { read });
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", hash: "w4", waiting: false, went: expect.any(Number) })]);
    // Read since, without it: the chain's history has it.
    await waiting.forgetWent({ walletId: WALLET, nodeUrl: NODE }, [], { read: waiting.sendsReadBegins() });
    expect(await kept()).toEqual([]);
  });

  it("goes once the chain's history has it, its record gone from the sends, or after a quarter of an hour", async () => {
    await goesOut("w2");
    await waiting.forgetWent({ walletId: WALLET, nodeUrl: NODE }, []);
    expect(await kept()).toEqual([]);
    await goesOut("w3");
    await vi.advanceTimersByTimeAsync(waiting.WENT_FOR_MS + 1);
    await waiting.forgetWent({ walletId: WALLET, nodeUrl: NODE }, [{ hash: "w3", status: "submitted" }], { balanceRead: false });
    expect(await kept()).toEqual([]);
  });
});

describe("a public payment that waited, its account having sent something else meanwhile", () => {
  // Chen's: the Wi-Fi dropped as she paid on her first phone, so the payment waited; she paid the same from her
  // second; once the first had the network back, it sent its copy too, without asking.
  beforeEach(() => {
    network.nonce = 41n;
    network.own = null;
    host.nonceNow = vi.fn(async () => {
      if (network.nonce instanceof Error) throw network.nonce;
      return network.nonce;
    });
    host.ownNonce = vi.fn(async () => network.own);
  });
  const waitsFromNonce = (sendId, attempt, over = {}) => waiting.sendWhenReachable({ sendId, record: record({ seenNonce: "41", ...over }), attempt, host });

  it("isn't sent by itself: it's held and said so, and goes out only on Send it too", async () => {
    const attempt = vi.fn().mockRejectedValueOnce(offline()).mockResolvedValueOnce({ hash: "h1" });
    const sent = waitsFromNonce("s1", attempt);
    await vi.advanceTimersByTimeAsync(0);
    // Paid from the other phone meanwhile: the account's nonce went on.
    network.nonce = 42n;
    network.answers = true;
    await askAgain();
    await askAgain();
    expect(attempt).toHaveBeenCalledOnce();
    expect(host.nonceNow).toHaveBeenCalledWith(expect.objectContaining({ sendId: "s1", account: "chen-account", seenNonce: "41" }));
    expect(host.tell).toHaveBeenLastCalledWith({ type: "DUSK_UI_SEND_WAITING", sendId: "s1", waits: false, held: true });
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", waiting: true, waits: false, held: true })]);
    // Nothing waits for the network: Android's notice of it goes.
    expect(waiting.waitingForNetwork()).toEqual([]);

    // Send it too: what was sent meanwhile counts as seen, and it goes out at once.
    await expect(waiting.sendHeld("s1", host)).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    await expect(sent).resolves.toEqual({ hash: "h1" });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(await kept()).toEqual([]);
  });

  // Astra's: the other phone's transaction still in the node's mempool, the chain not up to it, Send it too built one
  // at its nonce, as the engine counts a new one's from the chain's.
  it("goes out on Send it too only once the chain has the other transaction, or the mempool no longer holds it", async () => {
    for (const other of ["in its block", "gone from the mempool"]) {
      network.chain = 41n;
      host.chainNonce = vi.fn(async () => network.chain);
      network.nonce = 41n;
      network.answers = false;
      const attempt = vi.fn().mockRejectedValueOnce(offline()).mockResolvedValueOnce({ hash: "h1" });
      const sent = waitsFromNonce("s1", attempt);
      await vi.advanceTimersByTimeAsync(0);
      // The other phone's, in the node's mempool at 42; the chain still at 41.
      network.nonce = 42n;
      network.answers = true;
      await askAgain();
      await expect(waiting.sendHeld("s1", host)).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      await askAgain();
      await askAgain();
      expect(attempt, other).toHaveBeenCalledOnce();
      expect(await kept(), other).toEqual([expect.objectContaining({ sendId: "s1", waiting: true })]);
      if (other === "in its block") network.chain = 42n;
      else network.nonce = 41n;
      await askAgain();
      await expect(sent, other).resolves.toEqual({ hash: "h1" });
      expect(attempt, other).toHaveBeenCalledTimes(2);
    }
  });

  // Marek's, Lena's, Chen's: "something else" was the very same payment, sent from another device, and nothing named it.
  it("keeps what its account sent meanwhile, as the node names it, and says so again once it's named", async () => {
    const attempt = vi.fn().mockRejectedValueOnce(offline());
    const other = { hash: "ab".repeat(32), to: "lucas-account", lux: "10000000", memo: "night shift 9", at: 1_794_900_000_000 };
    host.meanwhile = vi.fn(async () => [other, { hash: "nope", to: "x", lux: "not a number" }]);
    waitsFromNonce("s1", attempt).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    network.nonce = 43n;
    network.answers = true;
    await askAgain();
    await vi.advanceTimersByTimeAsync(0);
    // From the nonce the wallet knew of last, up to the one now.
    expect(host.meanwhile).toHaveBeenCalledWith(expect.objectContaining({ sendId: "s1" }), { after: 41n, upTo: 43n });
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", held: true, meanwhile: [other] })]);
    expect(host.tell.mock.calls.filter(([m]) => m.held)).toHaveLength(2);
    delete host.meanwhile;
  });

  // Chen's and Marek's: for the 8 to 10 seconds the node took to say what was sent meanwhile, the hold said
  // "something else", Send it too live, though it was the very same payment.
  it("says it checks what its account sent while that's read, till the node answers or its time is up", async () => {
    const other = { hash: "ab".repeat(32), to: "lucas-account", lux: "10000000", memo: "night shift 9", at: 1_794_900_000_000 };
    for (const answer of ["named", "silent"]) {
      let named;
      host.meanwhile = vi.fn(() => new Promise((resolve) => (named = resolve)));
      host.tell.mockClear();
      waitsFromNonce("s1", vi.fn().mockRejectedValueOnce(offline())).catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      network.nonce = 43n;
      network.answers = true;
      await askAgain();
      await vi.advanceTimersByTimeAsync(0);
      expect(await kept(), answer).toEqual([expect.objectContaining({ sendId: "s1", held: true, checking: expect.any(Number) })]);
      if (answer === "named") named([other]);
      else await vi.advanceTimersByTimeAsync(waiting.MEANWHILE_READ_MS);
      await vi.advanceTimersByTimeAsync(0);
      const [record] = await kept();
      expect([record.checking, record.meanwhile], answer).toEqual([undefined, answer === "named" ? [other] : undefined]);
      // Said again with the answer, or with what's known.
      expect(host.tell.mock.calls.filter(([m]) => m.held), answer).toHaveLength(2);
      await waiting.cancelWaitingSend("s1", host).catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      network.nonce = 41n;
      network.answers = false;
    }
    delete host.meanwhile;
  });

  // Chen's: Send it too paid at once, with no Review. From its Review, it's sent in the held one's place.
  it("goes from the queue as Send it too's Review sends it in its place, said not sent there without a word", async () => {
    const attempt = vi.fn().mockRejectedValueOnce(offline());
    const sent = waitsFromNonce("s1", attempt).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    network.nonce = 42n;
    network.answers = true;
    await askAgain();
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", held: true })]);
    // Reviewed, and sent in its place, as the account's nonce is now.
    const again = waiting.sendWhenReachable({ sendId: "s2", record: record({ seenNonce: "42" }), attempt: vi.fn(async () => ({ hash: "h2" })), host, replaces: "s1" });
    await expect(again).resolves.toEqual({ hash: "h2" });
    expect((await sent).data).toEqual({ sent: false, cancelled: true, inPlace: true });
    expect(attempt).toHaveBeenCalledOnce();
    expect(await kept()).toEqual([]);
  });

  // Astra's: the one sent in its place was turned down before it went out (its balance, its gas), and the held
  // payment was gone with it. Held till the other goes out, it's held again, as it was, where that one never does.
  it("stays held while the one sent in its place is tried, and is held again where that one never goes out", async () => {
    const attempt = vi.fn().mockRejectedValueOnce(offline());
    const other = { hash: "ab".repeat(32), to: "lucas-account", lux: "10000000", memo: "night shift 9", at: 1_794_900_000_000 };
    host.meanwhile = vi.fn(async () => [other]);
    const sent = waitsFromNonce("s1", attempt).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    network.nonce = 42n;
    network.answers = true;
    await askAgain();
    await vi.advanceTimersByTimeAsync(0);
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", held: true, meanwhile: [other] })]);
    // Sent in its place, and turned down before it was handed over.
    const refused = Object.assign(new Error("Insufficient balance"), { data: { sent: false } });
    await expect(waiting.sendWhenReachable({ sendId: "s2", record: record({ seenNonce: "42" }), attempt: vi.fn().mockRejectedValue(refused), host, replaces: "s1" })).rejects.toBe(refused);
    // Held still, as it was, and said so: Send it too and Don't send again.
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", waiting: true, waits: false, held: true, meanwhile: [other] })]);
    expect(host.tell).toHaveBeenLastCalledWith({ type: "DUSK_UI_SEND_WAITING", sendId: "s1", waits: false, held: true });
    // Sent in its place again, and gone out this time: it goes, said not sent in that one's place.
    const again = waiting.sendWhenReachable({ sendId: "s3", record: record({ seenNonce: "42" }), attempt: vi.fn(async () => ({ hash: "h3" })), host, replaces: "s1" });
    await expect(again).resolves.toEqual({ hash: "h3" });
    expect((await sent).data).toEqual({ sent: false, cancelled: true, inPlace: true });
    expect(attempt).toHaveBeenCalledOnce();
    expect(await kept()).toEqual([]);
    delete host.meanwhile;
  });

  it("held, Don't send calls it off: nothing sent, nothing kept", async () => {
    const attempt = vi.fn().mockRejectedValueOnce(offline()).mockResolvedValueOnce({ hash: "h2" });
    const sent = waitsFromNonce("s1", attempt).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    network.nonce = 43n;
    network.answers = true;
    await askAgain();
    await expect(waiting.cancelWaitingSend("s1", host)).resolves.toBe(true);
    expect((await sent).data).toEqual({ sent: false, cancelled: true });
    await askAgain();
    expect(attempt).toHaveBeenCalledOnce();
    expect(await kept()).toEqual([]);
  });

  it("goes out by itself as before where nothing else was sent, the wallet's own sends counting as seen", async () => {
    // Two that waited, one behind the other: the first one's own nonce is no one else's send for the second.
    const first = vi.fn().mockRejectedValueOnce(offline()).mockImplementationOnce(async () => {
      network.nonce = 42n;
      network.own = 42n;
      return { hash: "p1" };
    });
    const second = vi.fn(async () => ({ hash: "p2" }));
    const one = waitsFromNonce("s1", first);
    await vi.advanceTimersByTimeAsync(0);
    const two = waitsFromNonce("s2", second, { memo: "Deux" });
    network.answers = true;
    await askAgain();
    await expect(one).resolves.toEqual({ hash: "p1" });
    await expect(two).resolves.toEqual({ hash: "p2" });
    expect(host.tell.mock.calls.some(([m]) => m.held)).toBe(false);
  });

  it("waits on, sent by nothing, while the node can't say the account's nonce", async () => {
    const attempt = vi.fn().mockRejectedValueOnce(offline()).mockResolvedValueOnce({ hash: "h3" });
    const sent = waitsFromNonce("s1", attempt);
    await vi.advanceTimersByTimeAsync(0);
    network.nonce = new Error("Account request failed (503)");
    network.answers = true;
    await askAgain();
    expect(attempt).toHaveBeenCalledOnce();
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", waiting: true, waits: true })]);
    // It says it, and nothing else went: out it goes.
    network.nonce = 41n;
    await askAgain();
    await expect(sent).resolves.toEqual({ hash: "h3" });
  });

  it("held as the wallet locks, is kept as not sent, still said held, and never goes by itself", async () => {
    const attempt = vi.fn().mockRejectedValueOnce(offline()).mockResolvedValue({ hash: "h4" });
    const sent = waitsFromNonce("s1", attempt).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    network.nonce = 42n;
    network.answers = true;
    await askAgain();
    await waiting.stopWaitingSends("locked", host);
    expect((await sent).data).toEqual({ sent: false, cancelled: true });
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", waiting: false, ended: "locked", held: true })]);
    await expect(waiting.sendHeld("s1", host)).resolves.toBe(false);
    await askAgain();
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("made already, goes again as it is only while nothing else of its account waits at its nonce", async () => {
    const lost = Object.assign(new TypeError("Failed to fetch"), { data: { sent: "unknown", hash: "c9" } });
    const attempt = vi
      .fn()
      .mockImplementationOnce(async () => {
        await waiting.noteHandingOver("s1", { hash: "c9", nonce: "42" }, host);
        throw lost;
      })
      .mockResolvedValueOnce({ hash: "c9" });
    const sent = waitsFromNonce("s1", attempt);
    await vi.advanceTimersByTimeAsync(0);
    // The node never had it, but the account's other send waits in its mempool at that nonce.
    network.says = "absent";
    network.nonce = 42n;
    network.answers = true;
    await askAgain();
    await askAgain();
    expect(attempt).toHaveBeenCalledOnce();
    expect(await kept()).toEqual([expect.objectContaining({ sendId: "s1", waiting: true, unclear: true })]);
    // That one gone from the mempool, never in a block: its nonce is free, and it goes.
    network.nonce = 41n;
    await askAgain();
    await expect(sent).resolves.toEqual({ hash: "c9" });
    expect(attempt).toHaveBeenLastCalledWith({ resend: true });
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
    // The account's nonce as its Review read it, where it says one.
    expect(waiting.waitingRecordOf({ ...message, seenNonce: "41" })).toEqual(expect.objectContaining({ seenNonce: "41" }));
    expect(waiting.waitingRecordOf({ ...message, seenNonce: "x" })).not.toHaveProperty("seenNonce");
  });
});
