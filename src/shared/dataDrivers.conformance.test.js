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
  it("wallet engine binds fetch for extension data-driver loading", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src", "shared", "walletEngine.js"), "utf8");
    expect(source).toContain("globalThis.fetch.bind(globalThis)");
    expect(source).toContain("new dataDrivers.DataDriverRegistry(fetchAsset)");
  });

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

  it("Sozu hub driver can encode contract lookups and decode optional contract IDs", async () => {
    const driver = await loadDriverFromPublic("sozu_hub_data_driver.wasm");
    const rkyv = driver.encodeInputFn("contract", JSON.stringify("pool"));
    expect(rkyv).toBeInstanceOf(Uint8Array);
    expect(rkyv.byteLength).toBeGreaterThan(0);
    expect(driver.decodeInputFn("contract", rkyv)).toBe("pool");

    const out = new Uint8Array([
      1,
      ...Array.from({ length: 32 }, (_, i) => i + 1),
    ]);
    expect(driver.decodeOutputFn("contract", out)).toBe(
      "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
    );
  });

  it("Sozu pool driver can encode deposit/withdraw args and decode reads", async () => {
    const driver = await loadDriverFromPublic("sozu_pool_data_driver.wasm");
    const stake = driver.encodeInputFn("sozu_stake", JSON.stringify("1000000000000"));
    expect(Array.from(stake)).toEqual([0, 16, 165, 212, 232, 0, 0, 0]);
    expect(driver.decodeInputFn("sozu_unstake", stake)).toBe("1000000000000");

    const balance = new Uint8Array([42, 0, 0, 0, 0, 0, 0, 0]);
    expect(driver.decodeOutputFn("balance_of", balance)).toBe("42");
  });

  it("Sozu stDUSK token driver can encode/decode token reads and transfers", async () => {
    const driver = await loadDriverFromPublic("sozu_staked_dusk_data_driver.wasm");
    const rkyv = driver.encodeInputFn("balance_of", JSON.stringify(EXAMPLE_PK));
    expect(rkyv).toBeInstanceOf(Uint8Array);
    expect(rkyv.byteLength).toBeGreaterThan(0);
    expect(driver.decodeInputFn("balance_of", rkyv)).toBe(EXAMPLE_PK);

    const transfer = [EXAMPLE_PK, "42"];
    const transferBytes = driver.encodeInputFn("transfer", JSON.stringify(transfer));
    expect(transferBytes).toBeInstanceOf(Uint8Array);
    expect(driver.decodeInputFn("transfer", transferBytes)).toEqual(transfer);

    const approve = [EXAMPLE_PK, "84"];
    const approveBytes = driver.encodeInputFn("approve", JSON.stringify(approve));
    expect(approveBytes).toBeInstanceOf(Uint8Array);
    expect(driver.decodeInputFn("approve", approveBytes)).toEqual(approve);

    const balance = new Uint8Array([42, 0, 0, 0, 0, 0, 0, 0]);
    expect(driver.decodeOutputFn("balance_of", balance)).toBe("42");
  });
});
