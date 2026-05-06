import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./storage.js", () => {
  let store = {};
  return {
    storage: {
      get: vi.fn(async (key) => ({ [key]: store[key] })),
      set: vi.fn(async (obj) => {
        Object.assign(store, obj);
      }),
    },
    STORAGE_KEYS: {
      PERMISSIONS: "dusk_permissions_v1",
    },
    __resetStore: () => {
      store = {};
    },
    __getStore: () => store,
  };
});

async function loadPermissionsModule() {
  const storageMod = await import("./storage.js");
  const permissionsMod = await import("./permissions.js");
  return { storageMod, permissionsMod };
}

describe("permissions", () => {
  beforeEach(async () => {
    vi.resetModules();
    const { storageMod } = await loadPermissionsModule();
    storageMod.__resetStore();
    vi.clearAllMocks();
  });

  it("returns empty permissions by default", async () => {
    const { permissionsMod } = await loadPermissionsModule();
    const perms = await permissionsMod.getPermissions();
    expect(perms).toEqual({});
  });

  it("approves origin and records timestamp", async () => {
    const { permissionsMod } = await loadPermissionsModule();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(123456);

    const res = await permissionsMod.approveOrigin("https://example.com", {
      profileId: "account:2:acct2",
      accountIndex: 2,
      grants: { publicAccount: true, shieldedReceiveAddress: false },
    });
    expect(res).toMatchObject({
      profileId: "account:2:acct2",
      accountIndex: 2,
      grants: { publicAccount: true, shieldedReceiveAddress: false },
    });
    expect(res.connectedAt).toBe(123456);
    expect(res.updatedAt).toBe(123456);

    nowSpy.mockRestore();
  });

  it("gets permission for origin", async () => {
    const { permissionsMod } = await loadPermissionsModule();
    await permissionsMod.approveOrigin("https://example.com", {
      profileId: "account:1:acct1",
      accountIndex: 1,
      grants: { publicAccount: true, shieldedReceiveAddress: true },
    });
    const res = await permissionsMod.getPermissionForOrigin("https://example.com");
    expect(res).toMatchObject({
      profileId: "account:1:acct1",
      accountIndex: 1,
      grants: { publicAccount: true, shieldedReceiveAddress: true },
    });
  });

  it("preserves shielded grant only when reconnecting the same profile", async () => {
    const { permissionsMod } = await loadPermissionsModule();
    await permissionsMod.approveOrigin("https://example.com", {
      profileId: "account:1:acct1",
      accountIndex: 1,
      grants: { publicAccount: true, shieldedReceiveAddress: true },
    });

    const same = await permissionsMod.approveOrigin("https://example.com", {
      profileId: "account:1:acct1",
      accountIndex: 1,
      grants: { publicAccount: true, shieldedReceiveAddress: false },
    });
    expect(same.grants.shieldedReceiveAddress).toBe(true);

    const different = await permissionsMod.approveOrigin("https://example.com", {
      profileId: "account:0:acct0",
      accountIndex: 0,
      grants: { publicAccount: true, shieldedReceiveAddress: false },
    });
    expect(different.grants.shieldedReceiveAddress).toBe(false);
  });

  it("revokes origin", async () => {
    const { permissionsMod } = await loadPermissionsModule();
    await permissionsMod.approveOrigin("https://example.com", {
      profileId: "account:0:acct0",
      accountIndex: 0,
      grants: { publicAccount: true },
    });
    await permissionsMod.revokeOrigin("https://example.com");
    const res = await permissionsMod.getPermissionForOrigin("https://example.com");
    expect(res).toBeNull();
  });

  it("clears all permissions", async () => {
    const { permissionsMod } = await loadPermissionsModule();
    await permissionsMod.approveOrigin("https://example.com", {
      profileId: "account:0:acct0",
      accountIndex: 0,
      grants: { publicAccount: true },
    });
    await permissionsMod.approveOrigin("https://example.org", {
      profileId: "account:1:acct1",
      accountIndex: 1,
      grants: { publicAccount: true },
    });
    await permissionsMod.clearPermissions();

    const res = await permissionsMod.getPermissions();
    expect(res).toEqual({});
  });
});
