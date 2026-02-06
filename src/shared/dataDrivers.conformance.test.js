import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { dataDrivers } from "@dusk/w3sper";

async function loadDriverFromPublic(relPath) {
  const wasmPath = path.resolve(process.cwd(), "public", "drivers", relPath);
  const bytes = await readFile(wasmPath);
  const driver = await dataDrivers.load(new Uint8Array(bytes));
  // Some generated drivers require an explicit init() call before use.
  try {
    driver.init?.();
  } catch {
    // ignore
  }
  return driver;
}

// A known-good base58 Moonlight public key string (taken from local DRC standards examples).
const EXAMPLE_PK =
  "26brdzqNXEG1jTzCubJAPhks18bSSDY4n21ZW6VLYkCv6bBUdBAZZAbn1Coz1LPBYc4uEekBbzFnZvhL9untGCqRamhZS2cBV51fdZog3qkP3NbMEaqgNMcKEahAFV8t2Cke";

describe("Canonical data-drivers conformance (DRC20 / DRC721)", () => {
  it("DRC20 driver can encode+decode standard inputs", async () => {
    const driver = await loadDriverFromPublic("drc20_data_driver.wasm");

    // transfer(TransferCall)
    {
      const args = {
        to: { External: EXAMPLE_PK },
        value: "42",
      };
      const rkyv = driver.encodeInputFn("transfer", JSON.stringify(args));
      expect(rkyv).toBeInstanceOf(Uint8Array);
      expect(rkyv.byteLength).toBeGreaterThan(0);
      expect(driver.decodeInputFn("transfer", rkyv)).toEqual(args);
    }

    // approve(ApproveCall)
    {
      const args = {
        spender: { External: EXAMPLE_PK },
        value: "18446744073709551615",
      };
      const rkyv = driver.encodeInputFn("approve", JSON.stringify(args));
      expect(rkyv).toBeInstanceOf(Uint8Array);
      expect(rkyv.byteLength).toBeGreaterThan(0);
      expect(driver.decodeInputFn("approve", rkyv)).toEqual(args);
    }

    // transfer_from(TransferFromCall)
    {
      const args = {
        owner: { External: EXAMPLE_PK },
        to: { External: EXAMPLE_PK },
        value: "1",
      };
      const rkyv = driver.encodeInputFn("transfer_from", JSON.stringify(args));
      expect(rkyv).toBeInstanceOf(Uint8Array);
      expect(rkyv.byteLength).toBeGreaterThan(0);
      expect(driver.decodeInputFn("transfer_from", rkyv)).toEqual(args);
    }
  });

  it("DRC721 driver can encode+decode standard inputs", async () => {
    const driver = await loadDriverFromPublic("drc721_data_driver.wasm");

    // approve(ApproveCall)
    {
      const args = {
        approved: { External: EXAMPLE_PK },
        token_id: "1",
      };
      const rkyv = driver.encodeInputFn("approve", JSON.stringify(args));
      expect(rkyv).toBeInstanceOf(Uint8Array);
      expect(rkyv.byteLength).toBeGreaterThan(0);
      expect(driver.decodeInputFn("approve", rkyv)).toEqual(args);
    }

    // set_approval_for_all(SetApprovalForAllCall)
    {
      const args = {
        operator: { External: EXAMPLE_PK },
        approved: true,
      };
      const rkyv = driver.encodeInputFn("set_approval_for_all", JSON.stringify(args));
      expect(rkyv).toBeInstanceOf(Uint8Array);
      expect(rkyv.byteLength).toBeGreaterThan(0);
      expect(driver.decodeInputFn("set_approval_for_all", rkyv)).toEqual(args);
    }

    // transfer_from(TransferFromCall)
    {
      const args = {
        from: { External: EXAMPLE_PK },
        to: { External: EXAMPLE_PK },
        token_id: "42",
      };
      const rkyv = driver.encodeInputFn("transfer_from", JSON.stringify(args));
      expect(rkyv).toBeInstanceOf(Uint8Array);
      expect(rkyv.byteLength).toBeGreaterThan(0);
      expect(driver.decodeInputFn("transfer_from", rkyv)).toEqual(args);
    }
  });
});
