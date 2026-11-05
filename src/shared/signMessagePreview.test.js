import { describe, expect, it } from "vitest";

import {
  SIGN_MESSAGE_PREVIEW_MAX_BYTES,
  SIGN_MESSAGE_PREVIEW_MAX_CHARS,
  describeSignMessagePreview,
} from "./signMessagePreview.js";

const enc = new TextEncoder();

describe("signMessage approval preview", () => {
  it("classifies short UTF-8 messages as readable text", () => {
    const preview = describeSignMessagePreview(enc.encode("Sign in to Dusk"));

    expect(preview).toMatchObject({
      kind: "text",
      encoding: "utf-8",
      text: "Sign in to Dusk",
      byteLength: 15,
      truncated: false,
    });
  });

  it("truncates long readable UTF-8 messages deterministically", () => {
    const text = "a".repeat(SIGN_MESSAGE_PREVIEW_MAX_CHARS + 20);
    const preview = describeSignMessagePreview(enc.encode(text));

    expect(preview.kind).toBe("text");
    expect(preview.truncated).toBe(true);
    expect(preview.text).toHaveLength(SIGN_MESSAGE_PREVIEW_MAX_CHARS);
  });

  it("classifies oversized messages as opaque bytes", () => {
    const preview = describeSignMessagePreview(new Uint8Array(SIGN_MESSAGE_PREVIEW_MAX_BYTES + 1));

    expect(preview).toMatchObject({
      kind: "opaque",
      reason: "too_large",
      label: "Opaque bytes",
    });
    expect(preview).not.toHaveProperty("text");
  });

  it("classifies invalid UTF-8 as opaque bytes", () => {
    const preview = describeSignMessagePreview(Uint8Array.from([0xff, 0xfe, 0xfd]));

    expect(preview).toMatchObject({
      kind: "opaque",
      reason: "invalid_utf8",
    });
    expect(preview).not.toHaveProperty("text");
  });

  it("classifies control-heavy messages conservatively", () => {
    const preview = describeSignMessagePreview(Uint8Array.from([0x48, 0x00, 0x69]));

    expect(preview).toMatchObject({
      kind: "opaque",
      reason: "control_characters",
    });
    expect(preview).not.toHaveProperty("text");
  });

  it("neutralizes what changes how text reads, and says so: it shows what the bytes say", () => {
    const [rlo, pop] = [0x202e, 0x202c].map((c) => String.fromCodePoint(c));
    const preview = describeSignMessagePreview(enc.encode(`I agree to pay ${rlo}0001${pop} DUSK`));
    expect(preview).toMatchObject({ kind: "text", text: "I agree to pay \\u202e0001\\u202c DUSK", needsReview: true, truncated: false });
    expect(describeSignMessagePreview(enc.encode("Sign in\nNonce: 12"))).toMatchObject({ text: "Sign in\nNonce: 12", needsReview: false });
    // Cut as ever, by the characters written, flagged all the same.
    const long = describeSignMessagePreview(enc.encode(`${rlo}${"a".repeat(SIGN_MESSAGE_PREVIEW_MAX_CHARS + 5)}`));
    expect([long.truncated, long.needsReview, long.text]).toEqual([true, true, `\\u202e${"a".repeat(SIGN_MESSAGE_PREVIEW_MAX_CHARS - 1)}`]);
  });

  it("keeps line breaks in readable text, and shows a tab as its code", () => {
    const preview = describeSignMessagePreview(enc.encode("line 1\nline 2\tok"));

    expect(preview).toMatchObject({
      kind: "text",
      text: "line 1\nline 2\\u0009ok",
    });
  });
});
