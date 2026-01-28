import { describe, it, expect } from "vitest";
import {
  isHexString,
  hexToBytes,
  bytesToHex,
  base64ToBytes,
  toBytes,
} from "./bytes.js";

describe("isHexString", () => {
  it("returns true for valid hex strings", () => {
    expect(isHexString("00")).toBe(true);
    expect(isHexString("ff")).toBe(true);
    expect(isHexString("0123456789abcdef")).toBe(true);
    expect(isHexString("ABCDEF")).toBe(true);
  });

  it("returns false for odd-length strings", () => {
    expect(isHexString("abc")).toBe(false);
    expect(isHexString("0")).toBe(false);
  });

  it("returns false for invalid characters", () => {
    expect(isHexString("gg")).toBe(false);
    expect(isHexString("0x00")).toBe(false); // 0x prefix counts as invalid chars
  });

  it("returns false for non-strings", () => {
    expect(isHexString(null)).toBe(false);
    expect(isHexString(undefined)).toBe(false);
    expect(isHexString(123)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isHexString("")).toBe(false);
  });
});

describe("hexToBytes", () => {
  it("converts hex string to bytes", () => {
    expect(hexToBytes("00ff")).toEqual(new Uint8Array([0, 255]));
    expect(hexToBytes("deadbeef")).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it("handles 0x prefix", () => {
    expect(hexToBytes("0x00ff")).toEqual(new Uint8Array([0, 255]));
    expect(hexToBytes("0X00ff")).toEqual(new Uint8Array([0, 255]));
  });

  it("returns empty array for empty input", () => {
    expect(hexToBytes("")).toEqual(new Uint8Array());
    expect(hexToBytes(null)).toEqual(new Uint8Array());
    expect(hexToBytes("0x")).toEqual(new Uint8Array());
  });

  it("throws on invalid hex", () => {
    expect(() => hexToBytes("gg")).toThrow("Invalid hex");
    expect(() => hexToBytes("0xgg")).toThrow("Invalid hex");
  });
});

describe("bytesToHex", () => {
  it("converts bytes to hex string", () => {
    expect(bytesToHex(new Uint8Array([0, 255]))).toBe("00ff");
    expect(bytesToHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe("deadbeef");
  });

  it("handles empty array", () => {
    expect(bytesToHex(new Uint8Array())).toBe("");
    expect(bytesToHex([])).toBe("");
  });

  it("handles regular array", () => {
    expect(bytesToHex([0, 255])).toBe("00ff");
  });

  it("handles null/undefined", () => {
    expect(bytesToHex(null)).toBe("");
    expect(bytesToHex(undefined)).toBe("");
  });
});

describe("base64ToBytes", () => {
  it("decodes base64 string", () => {
    // "hello" in base64
    expect(base64ToBytes("aGVsbG8=")).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
  });

  it("handles base64: prefix", () => {
    expect(base64ToBytes("base64:aGVsbG8=")).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
    expect(base64ToBytes("BASE64:aGVsbG8=")).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
  });

  it("returns empty array for empty input", () => {
    expect(base64ToBytes("")).toEqual(new Uint8Array());
    expect(base64ToBytes(null)).toEqual(new Uint8Array());
  });
});

describe("toBytes", () => {
  it("passes through Uint8Array", () => {
    const arr = new Uint8Array([1, 2, 3]);
    expect(toBytes(arr)).toBe(arr);
  });

  it("converts ArrayBuffer", () => {
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    expect(toBytes(buffer)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("converts number array", () => {
    expect(toBytes([1, 2, 3])).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("converts hex string with 0x prefix", () => {
    expect(toBytes("0x00ff")).toEqual(new Uint8Array([0, 255]));
  });

  it("converts plain hex string", () => {
    expect(toBytes("00ff")).toEqual(new Uint8Array([0, 255]));
  });

  it("converts base64 with prefix", () => {
    expect(toBytes("base64:aGVsbG8=")).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
  });

  it("returns empty array for null/undefined", () => {
    expect(toBytes(null)).toEqual(new Uint8Array());
    expect(toBytes(undefined)).toEqual(new Uint8Array());
  });

  it("throws on unsupported types", () => {
    expect(() => toBytes({})).toThrow("Unsupported byte encoding");
    expect(() => toBytes(123)).toThrow("Unsupported byte encoding");
  });
});
