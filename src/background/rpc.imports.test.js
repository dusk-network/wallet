import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("background RPC imports", () => {
  it("does not import w3sper into the service worker", () => {
    const source = readFileSync(resolve(__dirname, "rpc.js"), "utf8");
    expect(source).not.toContain("@dusk/w3sper");
    expect(source).not.toContain("ProfileGenerator");
  });
});
