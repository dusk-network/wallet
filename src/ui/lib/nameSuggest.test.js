import { describe, expect, it } from "vitest";

import { asDuskName, closeDuskName, editDistance } from "./nameSuggest.js";

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

  it("offers the .dusk name a name typed without its ending, or with a dot after it, likely means", () => {
    expect(["alice", "alice.", " Alice ", "alice.dusk.", "alice.dusk", "shop.alice", "a-1"].map(asDuskName)).toEqual([
      "alice.dusk",
      "alice.dusk",
      "alice.dusk",
      "alice.dusk",
      "alice.dusk",
      "shop.alice.dusk",
      "a-1.dusk",
    ]);
    // Never an address, or anything a name can't be.
    const account =
      "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
    for (const typed of [account, "aLice", "0xab84", "0x", "", ".", "-alice", "alice-", "al_ice", "a..b", "a.b.c.d.e", "x".repeat(64)]) {
      expect(asDuskName(typed)).toBeNull();
    }
  });
});
