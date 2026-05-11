import { describe, expect, it } from "vitest";

import { classifyDuskIdentifier } from "./duskIdentifiers.js";

const ACCOUNT =
  "M8vMuVUZZrHCW3LBFKEctWFJerYmT2HghQNuGHKrgV6BQqgkYK1A4FZLX3Nm9Rri63RZwL4gQCMhLyJRJQE5MQouqqu77Dr1rQnHqk1W7zAf4WKZqr6MgdxzkxFwFjo8ZM";
const ADDRESS =
  "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";

describe("classifyDuskIdentifier", () => {
  it("classifies public accounts by decoded byte length", () => {
    expect(classifyDuskIdentifier(ACCOUNT)).toBe("account");
  });

  it("classifies shielded addresses by decoded byte length", () => {
    expect(classifyDuskIdentifier(ADDRESS)).toBe("address");
  });

  it("rejects invalid base58 and unsupported lengths", () => {
    expect(classifyDuskIdentifier("acct1")).toBe("undefined");
    expect(classifyDuskIdentifier("0OIl")).toBe("undefined");
    expect(classifyDuskIdentifier("")).toBe("undefined");
  });
});
