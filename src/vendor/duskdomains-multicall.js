// Vendored verbatim from @duskdomains/sdk 0.5.4 (JSR, npm:@jsr/duskdomains__sdk),
// src/frozen/multicall.js, the build of src/frozen/multicall.ts. The SDK keeps
// it internal (no entrypoint exports it); the lens reader the wallet uses reads
// one query at a time, and multicallFetch.js batches those reads with it.
// Remove this copy once the SDK exports a batching light reader.
//
// MIT License
//
// Copyright (c) 2026 Aurora Dauven
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * Multicall for Dusk v1 (`aggregate`): its envelope and reply, encoded and decoded by hand as the rkyv
 * 0.7 archives (`size_32`) the deployed contract reads and writes, so no driver ships for it.
 * Internal: no package entrypoint exports it.
 * @module
 */ /** The multicall's ID: the v0.1.0 contract, nonce 0, the same owner on mainnet and testnet. */ export const MULTICALL_CONTRACT_ID = '93de287b7d349d678a0038fe7772e8960e1a84a1b5da2d0b1f62f532616ce1d4';
/** The most calls one `aggregate` takes. */ export const MAX_CALLS = 256;
/** The most bytes a multicall query's envelope, or its reply, may take: 64 KiB. */ export const ARGBUF_LEN = 65536;
/** The most bytes of a callee's panic message a result keeps. */ export const MAX_PANIC_BYTES = 200;
/** rkyv 0.7 keeps a string of at most this many bytes inside its 8-byte slot (`size_32`). */ const INLINE = 7;
/** `ArchivedCall`: contract, name, argument, gas limit; aligned to 8. */ const CALL = 56;
/** `ArchivedResult<ArchivedVec<u8>, ArchivedCallError>`: aligned to 4. */ const SLOT = 16;
/** `ArchivedAggregate`: height, then the results; aligned to 8. */ const ROOT = 16;
const align = (n, to)=>Math.ceil(n / to) * to;
const utf8 = new TextEncoder();
/** The bytes a call's name, when not inline, and its argument add to an envelope beside its slot. */ export function callBytes(fnName, args) {
  const name = utf8.encode(fnName).length;
  return (name > INLINE ? name : 0) + args.length;
}
/** The size of the envelope of `calls` calls whose names and arguments add `bytes` (`callBytes`). */ export function envelopeLength(calls, bytes) {
  return align(bytes, 8) + CALL * calls + 8;
}
/**
 * The size of the reply to `calls` calls whose replies and long panic messages add `outOfLine`
 * bytes: what the multicall checks against its 64 KiB bound after every call.
 */ export function replyLength(calls, outOfLine) {
  return align(align(outOfLine, 4) + SLOT * calls, 8) + ROOT;
}
/** `Vec<Call>` as the multicall's `aggregate` reads it. */ export function encodeAggregate(calls) {
  if (calls.length > MAX_CALLS) throw new Error(`A multicall takes at most ${MAX_CALLS} calls`);
  const names = calls.map((c)=>utf8.encode(c.fnName));
  let data = 0;
  for (const c of calls){
    if (c.contract.length !== 32) throw new Error('A multicall callee is 32 bytes');
    if (typeof c.gasLimit !== 'bigint' || c.gasLimit < 0n || c.gasLimit >= 1n << 64n) throw new Error('A multicall gas limit is a u64');
    data += callBytes(c.fnName, c.args);
  }
  const size = envelopeLength(calls.length, data);
  if (size > ARGBUF_LEN) throw new Error(`A multicall envelope takes at most ${ARGBUF_LEN} bytes`);
  const out = new Uint8Array(size), view = new DataView(out.buffer);
  // rkyv writes what each call points to first, in call order: its name when not inline, then its argument.
  const at = [];
  let pos = 0;
  for (const [i, c] of calls.entries()){
    const name = pos;
    if (names[i].length > INLINE) {
      out.set(names[i], pos);
      pos += names[i].length;
    }
    at.push({
      name,
      args: pos
    });
    out.set(c.args, pos);
    pos += c.args.length;
  }
  const array = align(pos, 8);
  for (const [i, c] of calls.entries()){
    const slot = array + i * CALL;
    out.set(c.contract, slot);
    const name = names[i];
    if (name.length > INLINE) {
      view.setUint32(slot + 32, name.length, true);
      view.setInt32(slot + 36, at[i].name - (slot + 32), true);
    } else {
      out.set(name, slot + 32);
      out[slot + 39] = name.length;
    }
    view.setInt32(slot + 40, at[i].args - (slot + 40), true);
    view.setUint32(slot + 44, c.args.length, true);
    view.setBigUint64(slot + 48, c.gasLimit, true);
  }
  const root = array + CALL * calls.length;
  view.setInt32(root, array - root, true);
  view.setUint32(root + 4, calls.length, true);
  return out;
}
// Rust's `String` keeps a leading U+FEFF: so does a panic message read here.
const fatal = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: true
});
/**
 * The multicall's reply: the height its query read at and one result per call, in call order. Anything
 * that is not exactly such an archive of `expected` results, as rkyv writes it, throws: each result's
 * bytes out of line follow the previous result's from the start of the reply, with no gap and nothing
 * claimed twice; the results start at the 4-aligned end of those bytes, and the root at theirs, 8-aligned.
 */ export function decodeAggregate(bytes, expected) {
  const malformed = ()=>new Error('Malformed multicall reply');
  if (bytes.length < ROOT || bytes.length % 8 !== 0 || bytes.length > ARGBUF_LEN) throw malformed();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), root = bytes.length - ROOT, height = view.getBigUint64(root, true), count = view.getUint32(root + 12, true);
  if (count !== expected) throw new Error(`The multicall answered ${count} calls, not ${expected}`);
  const slots = root + 8 + view.getInt32(root + 8, true);
  if (slots < 0 || slots % 4 !== 0 || align(slots + SLOT * count, 8) !== root) throw malformed();
  // The bytes the archived value at `base` points to, its offset from `base` stored at `at`: right after
  // the previous result's, and before the results.
  let next = 0;
  const claim = (base, at, length)=>{
    const start = base + view.getInt32(at, true);
    if (start !== next || start + length > slots) throw malformed();
    next = start + length;
    return bytes.subarray(start, next);
  };
  const results = [];
  for(let i = 0; i < count; i++){
    const slot = slots + i * SLOT;
    const tag = bytes[slot];
    if (tag === 0) {
      results.push({
        Ok: claim(slot + 4, slot + 4, view.getUint32(slot + 8, true)).slice()
      });
      continue;
    }
    if (tag !== 1) throw malformed();
    const error = bytes[slot + 4];
    if (error === 1) results.push({
      Err: 'OutOfGas'
    });
    else if (error === 2) results.push({
      Err: 'DoesNotExist'
    });
    else if (error === 3) results.push({
      Err: 'Unknown'
    });
    else if (error === 0) {
      const repr = slot + 8, last = bytes[repr + 7], length = (last & 0x80) === 0 ? last : view.getUint32(repr, true);
      // rkyv keeps a string of 7 bytes or fewer inline, and only a longer one out of line.
      if ((last & 0x80) === 0 ? length > INLINE : length <= INLINE) throw malformed();
      const text = (last & 0x80) === 0 ? bytes.subarray(repr, repr + length) : claim(repr, repr + 4, length);
      if (text.length > MAX_PANIC_BYTES) throw malformed();
      let message;
      try {
        message = fatal.decode(text);
      } catch  {
        throw malformed();
      }
      results.push({
        Err: {
          Panic: message
        }
      });
    } else throw malformed();
  }
  if (align(next, 4) !== slots) throw malformed();
  return {
    height,
    results
  };
}
