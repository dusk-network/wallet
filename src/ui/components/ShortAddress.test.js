import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installFakeDom, screenReaderText, visibleText } from "../testing/fakeDom.js";
import { shortAddressEl } from "./ShortAddress.js";

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";

beforeEach(() => {
  installFakeDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("short address", () => {
  it("shows 6…6, with the full address on hover and for screen readers", () => {
    const el = shortAddressEl(ACCOUNT, { className: "receive-field__address" });
    expect([el.localName, el.className, el.title]).toEqual(["code", "receive-field__address", ACCOUNT]);
    expect([visibleText(el), screenReaderText(el)]).toEqual(["26FCH7…Tck927", ACCOUNT]);

    // One too short to cut shows once, as it is.
    const short = shortAddressEl("acct0", { tag: "span" });
    expect([short.localName, short.title]).toEqual(["span", "acct0"]);
    expect([visibleText(short), screenReaderText(short)]).toEqual(["acct0", "acct0"]);
    expect(short.querySelector(".sr-only")).toBeNull();
  });
});
