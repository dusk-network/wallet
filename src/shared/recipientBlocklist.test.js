import { networks } from "@dusk-network/networks";
import { describe, expect, it } from "vitest";

import { blockedRecipient } from "./recipientBlocklist.js";

const listed = (reason) => networks.testnet.display.blocklist.find((entry) => entry.reason === reason).account;
const ANYONE = "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";

describe("blockedRecipient", () => {
  it("says why the network's file won't have the wallet pay an account, as the web wallet does", () => {
    expect(blockedRecipient(listed("compromised"), 2)).toBe(
      "Transfer restricted: this recipient address has been reported as compromised."
    );
    expect(blockedRecipient(` ${listed("scam")} `, 1)).toBe(
      "Transfer restricted: this recipient address is associated with reported fraud/scam activity."
    );
    expect([blockedRecipient(ANYONE, 2), blockedRecipient("", 2), blockedRecipient(undefined, 2)]).toEqual([null, null, null]);
  });

  it("checks every network's list while the node's network isn't known", () => {
    expect(blockedRecipient(listed("scam"))).not.toBeNull();
    expect(blockedRecipient(listed("scam"), 0)).not.toBeNull();
    expect(blockedRecipient(ANYONE)).toBeNull();
  });
});
