import { describe, expect, it, vi } from "vitest";
import { handleUiCommand } from "./uiCommands.js";

describe("shared UI command dispatcher", () => {
  it("leaves platform commands alone and dispatches engine commands", async () => {
    const adapters = {
      engineCall: vi.fn().mockResolvedValue(9n),
      ensureEngineConfigured: vi.fn(),
      getEngineStatus: vi.fn().mockResolvedValue({
        isUnlocked: true,
        accounts: ["account-0"],
        selectedAccountIndex: 1,
      }),
    };

    expect(await handleUiCommand({ type: "DUSK_UI_OVERVIEW" }, adapters)).toBeNull();
    expect(adapters.getEngineStatus).not.toHaveBeenCalled();

    await expect(
      handleUiCommand(
        { type: "DUSK_UI_DRC20_GET_BALANCE", contractId: "c", driver: "d" },
        adapters
      )
    ).resolves.toEqual({ ok: true, result: "9" });
    expect(adapters.engineCall).toHaveBeenCalledWith("dusk_getDrc20Balance", {
      contractId: "c",
      profileIndex: 1,
      driver: "d",
    });
  });
});
