// A Multicall for Dusk `aggregate` call as its contract reads and writes it
// (rkyv 0.7), for tests. Test-only: nothing in the extension imports this.

const text = new TextDecoder();
const hex = (bytes) => Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");

/** The calls of an `aggregate` envelope: contract, function and argument of each, as text. */
export function envelopeCalls(body) {
  const b = new Uint8Array(body);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const root = b.length - 8;
  const array = root + v.getInt32(root, true);
  const calls = [];
  for (let i = 0; i < v.getUint32(root + 4, true); i++) {
    const slot = array + i * 56;
    const last = b[slot + 39];
    const at = slot + 32 + v.getInt32(slot + 36, true);
    const name = (last & 0x80) === 0 ? b.subarray(slot + 32, slot + 32 + last) : b.subarray(at, at + v.getUint32(slot + 32, true));
    const args = slot + 40 + v.getInt32(slot + 40, true);
    calls.push({
      contract: hex(b.subarray(slot, slot + 32)),
      fnName: text.decode(name),
      args: text.decode(b.subarray(args, args + v.getUint32(slot + 44, true))),
    });
  }
  return calls;
}

/**
 * An `aggregate` reply as the contract writes it: each result's bytes, then
 * one 16-byte slot per result, then the root. A result is its bytes, `{ Ok:
 * bytes }`, or `{ Err }` for a call that ran out of gas.
 */
export function aggregateReply(results, height = 7n) {
  const okOf = (r) => (r instanceof Uint8Array ? r : "Ok" in r ? r.Ok : null);
  const align = (n, to) => Math.ceil(n / to) * to;
  const slots = align(results.reduce((n, r) => n + (okOf(r)?.length ?? 0), 0), 4);
  const root = align(slots + 16 * results.length, 8);
  const out = new Uint8Array(root + 16);
  const view = new DataView(out.buffer);
  let at = 0;
  results.forEach((r, i) => {
    const slot = slots + 16 * i;
    const ok = okOf(r);
    if (ok) {
      out.set(ok, at);
      view.setInt32(slot + 4, at - (slot + 4), true);
      view.setUint32(slot + 8, ok.length, true);
      at += ok.length;
    } else {
      out[slot] = 1;
      out[slot + 4] = 1; // OutOfGas
    }
  });
  view.setBigUint64(root, height, true);
  view.setInt32(root + 8, slots - (root + 8), true);
  view.setUint32(root + 12, results.length, true);
  return out;
}
