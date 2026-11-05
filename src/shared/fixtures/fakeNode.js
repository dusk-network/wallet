// The wallet's real engine against a node a test scripts: real w3sper builders
// and the real wallet core signing, in this process, and a node that exists
// only as the answers `fetch` and `WebSocket` give here. Nothing reaches a
// network. Test-only: nothing in the extension imports this.

import { readFile } from "node:fs/promises";
import { resolveObjectURL } from "node:buffer";
import path from "node:path";

import { vi } from "vitest";

// What w3sper's network looks for in each event a socket gives, which a browser
// has: here for as long as a socket can still close, past any one test.
globalThis.ErrorEvent ??= class ErrorEvent extends Event {};

const publicFile = (name) => readFile(path.resolve(process.cwd(), "public", name));

const bytesOf = (bigints) => {
  const out = new Uint8Array(bigints.length * 8);
  const view = new DataView(out.buffer);
  bigints.forEach((n, i) => view.setBigUint64(i * 8, BigInt(n), true));
  return out;
};

// What the stake contract answers for a profile with this much staked; 8 zero
// bytes for none (w3sper's StakeInfo.parse).
function stakeReply({ value = 0n, reward = 0n } = {}) {
  if (!value) return new Uint8Array(64);
  const out = new Uint8Array(64);
  const view = new DataView(out.buffer);
  view.setUint8(0, 1);
  view.setUint8(8, 1);
  view.setBigUint64(16, BigInt(value), true);
  view.setBigUint64(40, BigInt(reward), true);
  return out;
}

/**
 * The node. `says` is what it answers to /on/node/info, a chain ID, null for
 * no answer, or a function of how many times it was asked. `signed` keeps each
 * transaction handed to it, as it arrives: a signature it got.
 * @param {string} nodeUrl
 */
export function fakeNode(nodeUrl) {
  const origin = new URL(nodeUrl).origin;
  const node = {
    says: null,
    asked: 0,
    signed: [],
    // What it answers a transaction with instead of taking it, as a body and status.
    refuses: null,
    balance: { nonce: 0n, value: 10n ** 13n },
    stake: {},
    async fetch(input, init = {}) {
      const url = new URL(String(input), "https://wallet.invalid");
      if (url.origin === "https://wallet.invalid") return new Response(await publicFile(url.pathname.slice(1)));
      if (url.origin !== origin) throw new TypeError(`Nothing but ${origin} answers in this test, not ${url.href}`);
      if (url.pathname === "/on/node/info") {
        node.asked += 1;
        const id = typeof node.says === "function" ? node.says(node.asked) : node.says;
        return id === null ? new Response("", { status: 503 }) : new Response(JSON.stringify({ chain_id: id, version: "1.7.1" }));
      }
      if (/\/on\/transactions\/(preverify|propagate)$/.test(url.pathname)) {
        node.signed.push(new Uint8Array(init.body));
        return node.refuses === null ? new Response("ok") : new Response(node.refuses, { status: 400 });
      }
      if (url.pathname.endsWith("/account")) return new Response(bytesOf([node.balance.nonce, node.balance.value]));
      if (url.pathname.endsWith("/get_stake")) return new Response(stakeReply(node.stake));
      return new Response("ok");
    },
  };
  return node;
}

/** The chain ID a signed public transaction carries: its payload's first byte. */
export const moonlightChainId = (signed) => signed[1 + 8];

// A socket that opens, and gives its session's ID, as a node's RUES does.
class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeSocket.CONNECTING;

  constructor() {
    super();
    setTimeout(() => {
      this.readyState = FakeSocket.OPEN;
      this.dispatchEvent(new Event("open"));
      setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: "session" })), 0);
    }, 0);
  }

  send() {}

  close() {
    this.readyState = FakeSocket.CLOSED;
    setTimeout(() => this.dispatchEvent(new Event("close")), 0);
  }
}

/**
 * Runs the wallet core in this process, where w3sper would start a worker.
 * `calls` keeps every call of the core's exports. A call `decline` picks returns
 * the error code it gives, without running: for what needs a real note, whose
 * arguments are what a test reads.
 * @param {{ decline?: (member: string) => number | null | undefined }} [opts]
 */
export function installWalletCore({ decline } = {}) {
  const calls = [];
  class InProcessWorker {
    onmessage = null;
    #listeners = new Set();
    #ready;

    constructor(url) {
      const add = (_type, fn) => this.#listeners.add(fn);
      const remove = (_type, fn) => this.#listeners.delete(fn);
      const post = (data) => queueMicrotask(() => this.onmessage?.({ data }));
      this.post = post;
      this.#ready = resolveObjectURL(url)
        .text()
        .then((code) => new Function("self", "addEventListener", "removeEventListener", "postMessage", code)({}, add, remove, post));
    }

    postMessage(data, ports) {
      if (data?.member && data.member !== "malloc" && data.member !== "free") calls.push({ member: data.member, args: data.args });
      const declined = data?.member ? decline?.(data.member) : null;
      if (declined != null) {
        this.post(declined);
        return;
      }
      this.#ready.then(() => {
        for (const fn of [...this.#listeners]) fn({ data, ports });
      });
    }

    terminate() {}
  }
  vi.stubGlobal("Worker", InProcessWorker);
  vi.stubGlobal("WebSocket", FakeSocket);
  return calls;
}
