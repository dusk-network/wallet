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

  it("does not lose concurrent grants", async () => {
    const { permissionsMod } = await loadPermissionsModule();
    await Promise.all([
      permissionsMod.approveOrigin("https://a.example", { accountIndex: 0 }),
      permissionsMod.approveOrigin("https://b.example", { accountIndex: 1 }),
    ]);
    await expect(permissionsMod.getPermissions()).resolves.toMatchObject({
      "https://a.example": { accountIndex: 0 },
      "https://b.example": { accountIndex: 1 },
    });
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

describe("permissionProfileState", () => {
  const perm = {
    profileId: "account:1:acct1",
    accountIndex: 1,
    grants: { publicAccount: true, shieldedReceiveAddress: true },
    updatedAt: 1,
  };
  const status = { isUnlocked: true, accounts: ["acct0", "acct1"], addresses: ["addr0", "addr1"] };

  it("gives the profile its verified .dusk name and no other profile's", async () => {
    const { permissionsMod } = await loadPermissionsModule();
    const state = (names, shielded = false) =>
      permissionsMod.permissionProfileState(perm, status, shielded, names).profile;

    expect(state(new Map([["acct0", "zero.dusk"], ["acct1", "one.dusk"]]))).toEqual({
      profileId: "account:1:acct1",
      account: "acct1",
      name: "one.dusk",
    });
    expect(state(new Map([["acct1", "one.dusk"]]), true)).toEqual({
      profileId: "account:1:acct1",
      account: "acct1",
      shieldedAddress: "addr1",
      name: "one.dusk",
    });
    // Without a name for its account the profile has no name field at all.
    expect(state(new Map([["acct0", "zero.dusk"]]))).toEqual({ profileId: "account:1:acct1", account: "acct1" });
    expect(state()).toEqual({ profileId: "account:1:acct1", account: "acct1" });
  });

  it("gives no profile, so no name, while locked or through a stale permission", async () => {
    const { permissionsMod } = await loadPermissionsModule();
    const names = new Map([["acct0", "zero.dusk"], ["acct1", "one.dusk"]]);

    expect(permissionsMod.permissionProfileState(perm, { ...status, isUnlocked: false }, true, names)).toEqual({
      isValid: true,
      profile: null,
    });
    const stale = { ...perm, profileId: "account:1:another-wallet" };
    expect(permissionsMod.permissionProfileState(stale, status, true, names)).toEqual({
      isValid: false,
      profile: null,
    });
  });
});
