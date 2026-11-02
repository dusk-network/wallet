import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { dataDrivers } from "@dusk/w3sper";

import { readDrc20Call } from "./drc20Calls.js";

// The token drivers the wallet ships, as the engine loads them.
async function driver(file) {
  const loaded = await dataDrivers.load(new Uint8Array(await readFile(path.resolve(process.cwd(), "public", "drivers", file))));
  loaded.init?.();
  return loaded;
}

// Keys made as the DRC20 standard's tests make them (tests/primitives.rs, tests/drc20.rs).
const ALICE = "u5E9jR6rhTroj6gBnP3wMyvrQXTkE4hANU6unNhZeaA76pxgvJGugiYuwe6414TwadKKE41bgqJ32BNoVtvnA7oGeAVszCAwRhXvvs582sJ9wsvvFHqGRUfrzZ56uB8zyMX";
const BOB = "sqrtP6LvrNqtDWn4cic3hCXZatjoW3U3V2NoCPKt7QMkS2J3Lt7LZ7LZ9YZ7Go7N63RJcSP89GBxDS1Sgg9Fqq17LsvX9FAnCbZcV1LyqSTGRg4fdi8aoq75jdomJEgsC4y";
const PHOENIX = "J3W3PD1aVTtUwf4N7mthhuKb4KVutxQuZgy5SAt8RmkL";
const CONTRACT = "18".repeat(32);

let drivers;
beforeAll(async () => {
  drivers = {
    drc20_standard: await driver("drc20_standard_data_driver.wasm"),
    drc20: await driver("drc20_data_driver.wasm"),
    sozu_staked_dusk: await driver("sozu_staked_dusk_data_driver.wasm"),
  };
});

// A call's bytes as a site's driver writes them, and the wallet's reading of them.
const encode = (key, fn, json) => drivers[key].encodeInputFn(fn, json);
const read = (fn, bytes) => readDrc20Call(drivers, fn, bytes);
const account = (value) => ({ kind: "account", value });

describe("reading a DRC20 call", () => {
  it("reads the standard's struct calls: each principal, and the amount exactly at any u64", () => {
    const standard = (fn, json) => read(fn, encode("drc20_standard", fn, json));
    expect(standard("transfer", `{"to":{"Moonlight":"${BOB}"},"amount":9007199254740993}`)).toEqual({
      driver: "drc20_standard",
      fn: "transfer",
      to: account(BOB),
      amount: "9007199254740993",
    });
    expect(standard("approve", `{"spender":{"Contract":"${CONTRACT}"},"amount":18446744073709551615}`)).toEqual({
      driver: "drc20_standard",
      fn: "approve",
      spender: { kind: "contract", value: CONTRACT },
      amount: "18446744073709551615",
    });
    expect(standard("transfer_from", `{"owner":{"Moonlight":"${ALICE}"},"to":{"Phoenix":"${PHOENIX}"},"amount":7}`)).toEqual({
      driver: "drc20_standard",
      fn: "transfer_from",
      owner: account(ALICE),
      to: { kind: "shielded", value: PHOENIX },
      amount: "7",
    });
    expect(standard("increase_allowance", `{"spender":{"Moonlight":"${BOB}"},"added_amount":1000000000000000001}`)).toMatchObject({
      fn: "increase_allowance",
      spender: account(BOB),
      amount: "1000000000000000001",
    });
    expect(standard("decrease_allowance", `{"spender":{"Phoenix":"${PHOENIX}"},"subtracted_amount":0}`)).toMatchObject({
      fn: "decrease_allowance",
      spender: { kind: "shielded", value: PHOENIX },
      amount: "0",
    });
  });

  it("reads older tokens' calls and Sozu's stDUSK as before", () => {
    expect(read("transfer", encode("drc20", "transfer", `{"to":{"External":"${BOB}"},"value":"9007199254740993"}`))).toEqual({
      driver: "drc20",
      fn: "transfer",
      to: account(BOB),
      amount: "9007199254740993",
    });
    expect(read("approve", encode("drc20", "approve", `{"spender":{"Contract":"${CONTRACT}"},"value":"18446744073709551615"}`))).toMatchObject({
      driver: "drc20",
      spender: { kind: "contract", value: CONTRACT },
      amount: "18446744073709551615",
    });
    expect(read("transfer_from", encode("drc20", "transfer_from", `{"owner":{"External":"${ALICE}"},"to":{"External":"${BOB}"},"value":"1"}`))).toMatchObject({
      owner: account(ALICE),
      to: account(BOB),
      amount: "1",
    });
    expect(read("transfer_from", encode("sozu_staked_dusk", "transfer_from", `["${ALICE}","${BOB}","42"]`))).toEqual({
      driver: "sozu_staked_dusk",
      fn: "transfer_from",
      owner: account(ALICE),
      to: account(BOB),
      amount: "42",
    });
  });

  it("shows a standard call as the standard's, though Sozu's driver takes its bytes as another", () => {
    const shop = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
    const bytes = encode("drc20_standard", "transfer", `{"to":{"Moonlight":"${shop}"},"amount":9007199254740993}`);
    // Sozu's driver reads these 208 bytes as a transfer of 4 to another account.
    const [to, amount] = drivers.sozu_staked_dusk.decodeInputFn("transfer", bytes);
    expect([to === shop, amount]).toEqual([false, "4"]);
    expect(read("transfer", bytes)).toEqual({ driver: "drc20_standard", fn: "transfer", to: account(shop), amount: "9007199254740993" });
  });

  it("shows an older token's call as the older token's, though the standard's driver takes its bytes too", () => {
    // Its 16th byte, where the standard's call keeps its principal's kind, is 2: a contract.
    const id = `${"11".repeat(15)}02${"11".repeat(16)}`;
    const bytes = encode("drc20", "transfer", `{"to":{"Contract":"${id}"},"value":"5"}`);
    expect(() => drivers.drc20_standard.decodeInputFn("transfer", bytes)).not.toThrow();
    expect(read("transfer", bytes)).toEqual({ driver: "drc20", fn: "transfer", to: { kind: "contract", value: id }, amount: "5" });
  });

  it("can't read a token call that isn't all of one call it knows", () => {
    const bytes = encode("drc20_standard", "transfer", `{"to":{"Moonlight":"${BOB}"},"amount":5}`);
    const changed = (at, value) => bytes.map((byte, i) => (i === at ? value : byte));
    // A principal that isn't a valid key, which the standard writes as InvalidMoonlight.
    expect(drivers.drc20_standard.decodeInputFn("transfer", changed(20, bytes[20] ^ 0xff)).to).toHaveProperty("InvalidMoonlight");
    expect(read("transfer", changed(20, bytes[20] ^ 0xff))).toEqual({ unread: true });
    // Bytes the driver reads past: a padding byte set, or bytes before the call.
    expect(read("transfer", changed(bytes.length - 1, 1))).toEqual({ unread: true });
    expect(read("transfer", new Uint8Array([...new Uint8Array(8), ...bytes]))).toEqual({ unread: true });
  });

  it("can't read a call that two drivers each read whole", () => {
    // Drivers that each read these bytes as a call, and write that call back to them.
    const bytes = new Uint8Array([1, 2, 3]);
    const whole = (decoded) => ({ decodeInputFn: () => decoded, encodeInputFn: () => bytes });
    const both = { drc20: whole({ to: { External: BOB }, value: "5" }), sozu_staked_dusk: whole([ALICE, "7"]) };
    expect(readDrc20Call(both, "transfer", bytes)).toEqual({ unread: true });
    expect(readDrc20Call({ drc20: both.drc20 }, "transfer", bytes)).toEqual({ driver: "drc20", fn: "transfer", to: account(BOB), amount: "5" });
  });

  it("reads nothing from bytes no token driver takes, or a call it doesn't read", () => {
    expect(read("transfer", new Uint8Array([1, 2, 255]))).toBeNull();
    expect(read("burn", encode("drc20_standard", "burn", "7"))).toBeNull();
    expect(read("__proto__", new Uint8Array(208))).toBeNull();
  });
});
