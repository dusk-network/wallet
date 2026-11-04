import { describe, expect, it } from "vitest";
import { isAccountKey } from "./accountKey.js";

// Provisioners' accounts, from the network.
const REAL = [
  "2131Xe28JCogeQqgK4VTjtDwY5GJ5oFSUQgQobAiFbUKcXK2BzpJdoj4iGammHGgkbnbykjqPVWmy3S83TDgqfPmtLgBv56ZzeuhHbuFy9bCerhU4JTwEi2oCxxPKSx5983T",
  "21KL9R1h2CWF4Su1RGkf6MucN92yUKMRKgBE4gns9mV1r8BW46APhvBBVX4Ut7f5Zxf639KTZUb2zanB4UZiYsEJkzkwoNJ1GQuKKPBNQkUGKwKq5iudjQJ2UiQFHZ71rMvN",
  "21SvzTdXggQkZpnkwvWi8CC3Mn5FsSRenW5NfkL2wmjLMwEmY4K27Vs2DUaEzWQ3aRLZE3U1dgX5UY2zsWG4HTHaRyA7tKUe6ubrqYZBxFuWB4FzvgP4tEL1cH5wFRKVGARR",
];

describe("isAccountKey", () => {
  it("takes real accounts", () => {
    for (const account of REAL) expect(isAccountKey(account)).toBe(true);
  });

  it("refuses an account with any one character changed", () => {
    for (const account of REAL) {
      for (const at of [0, 1, 30, 60, 90, account.length - 2, account.length - 1]) {
        const other = account[at] === "2" ? "3" : "2";
        expect(isAccountKey(account.slice(0, at) + other + account.slice(at + 1))).toBe(false);
      }
    }
  });

  it("refuses an account with its last character dropped, and what isn't one", () => {
    expect(isAccountKey(REAL[0].slice(0, -1))).toBe(false);
    for (const other of ["", "alice", "0OIl", null, undefined]) expect(isAccountKey(other)).toBe(false);
  });
});
