import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("background lock lifecycle conformance", () => {
  it("explicit lock and auto-lock both clear dApp-visible profiles", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src/background/index.js"), "utf8");

    expect(source).toMatch(
      /async function lockWallet[\s\S]*?engineCall\("engine_lock"\)[\s\S]*?broadcastProfilesChangedAll/
    );
    expect(source).toMatch(
      /message\?\.type === "DUSK_UI_LOCK"[\s\S]*?lockWallet\("manual_lock"\)/
    );
    expect(source).toMatch(
      /if \(elapsed >= timeoutMs\) \{[\s\S]*?lockWallet\("auto_lock"\)/
    );
  });

  it("unlock publishes fresh dApp profile visibility only after engine unlock succeeds", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src/background/index.js"), "utf8");

    expect(source).toMatch(
      /message\?\.type === "DUSK_UI_UNLOCK"[\s\S]*?unlockVault\(password\)[\s\S]*?unlockEngine\(mnemonic\)[\s\S]*?broadcastProfilesChangedAll/
    );
  });

  it("keeps contacts to their wallet: a new one starts with none, unlock moves plain ones in, approvals read them unlocked", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src/background/index.js"), "utf8");

    expect(source).toMatch(
      /message\?\.type === "DUSK_UI_CREATE_WALLET"[\s\S]*?finishPendingReset\(\)[\s\S]*?keepOnlyContactsOf\([\s\S]*?clearContacts\(\)[\s\S]*?createVault\(mnemonic, password\);\s*if \(pending\) await endReset\(\)/
    );
    // A restore stays noted, with its wallet, until that wallet's vault is made.
    for (const file of ["src/background/index.js", "src/wallet/localBus.js"]) {
      const code = await readFile(path.resolve(process.cwd(), file), "utf8");
      expect(code, file).toMatch(
        /message\?\.type === "DUSK_UI_RESTORE_WALLET"[\s\S]*?beginReset\(\{ keepContactsOf: walletId \}\)[\s\S]*?clearWalletData\(\{ keepContactsOf: walletId \}\)[\s\S]*?clearVault\(\);\s*await createVault\(mnemonic, password\);\s*await endReset\(\)/
      );
    }
    expect(source).toMatch(
      /message\?\.type === "DUSK_UI_UNLOCK"[\s\S]*?unlockEngine\(mnemonic\)[\s\S]*?moveLegacyContacts\(engineContactsVault\(engineCall\)\)/
    );
    expect(source).toMatch(
      /entry\.kind === "send_tx" && status\.isUnlocked[\s\S]*?contactsStore\(engineContactsVault\(engineCall\)\)\.list\(\)/
    );
    // Nothing reads them in plain text any more.
    expect(source).not.toContain("listAddressBook");
  });
});
