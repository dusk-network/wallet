import { describe, expect, it } from "vitest";

import { closeDuskName, editDistance } from "./nameSuggest.js";

describe("Did you mean", () => {
  it("counts letters added, removed, changed and swapped", () => {
    expect(editDistance("alice", "alice")).toBe(0);
    expect(editDistance("alcie", "alice")).toBe(1);
    expect(editDistance("alic", "alice")).toBe(1);
    expect(editDistance("alicee", "alice")).toBe(1);
    expect(editDistance("elise", "alice")).toBe(2);
    expect(editDistance("", "bob")).toBe(3);
  });

  it("offers the closest known name, and nothing for a far one or the same one", () => {
    const known = ["wallet-both.dusk", "Alice.dusk", "alice-shop.dusk"];
    expect(closeDuskName("alcie.dusk", known)).toBe("alice.dusk");
    expect(closeDuskName("ALICE-SHOPP.dusk", known)).toBe("alice-shop.dusk");
    expect(closeDuskName("walet-bth.dusk", known)).toBe("wallet-both.dusk");
    expect(closeDuskName("alice.dusk", known)).toBeNull();
    expect(closeDuskName("carol.dusk", known)).toBeNull();
    // Short names allow one edit only.
    expect(closeDuskName("bbo.dusk", ["bob.dusk"])).toBe("bob.dusk");
    expect(closeDuskName("bxx.dusk", ["bob.dusk"])).toBeNull();
    expect(closeDuskName(".dusk", known)).toBeNull();
  });
});
