import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./storage.js", () => {
  let store = {};
  return {
    storage: {
      get: vi.fn(async (keys) =>
        Object.fromEntries([keys].flat().filter((k) => store[k] !== undefined).map((k) => [k, structuredClone(store[k])]))
      ),
      set: vi.fn(async (obj) => {
        Object.assign(store, structuredClone(obj));
      }),
      remove: vi.fn(async (keys) => {
        for (const k of [keys].flat()) delete store[k];
      }),
    },
    STORAGE_KEYS: {
      PERMISSIONS: "dusk_permissions_v1",
      PERMISSIONS_V2: "dusk_permissions_v2",
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

// Two wallets' profiles, by wallet ID (each one's first public account).
const W1 = ["w1acct0", "w1acct1"];
const W2 = ["w2acct0", "w2acct1"];
const grant = (accounts, index, shielded = false) => ({
  profileId: `account:${index}:${accounts[index]}`,
  accountIndex: index,
  grants: { publicAccount: true, shieldedReceiveAddress: shielded },
});
const unlocked = (accounts) => ({ isUnlocked: true, accounts, addresses: accounts.map((a) => `addr-${a}`) });

describe("permissions", () => {
  beforeEach(async () => {
    vi.resetModules();
    const { storageMod } = await loadPermissionsModule();
    storageMod.__resetStore();
    vi.clearAllMocks();
  });

  it("returns empty permissions by default", async () => {
    const { permissionsMod } = await loadPermissionsModule();
    await expect(permissionsMod.getPermissions(W1[0])).resolves.toEqual({});
    await expect(permissionsMod.getPermissions()).resolves.toEqual({});
  });

  it("approves origin and records timestamp", async () => {
    const { permissionsMod } = await loadPermissionsModule();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(123456);

    const res = await permissionsMod.approveOrigin("https://example.com", grant(W1, 1), W1[0]);
    expect(res).toMatchObject(grant(W1, 1));
    expect(res.connectedAt).toBe(123456);
    expect(res.updatedAt).toBe(123456);

    nowSpy.mockRestore();
  });

  it("needs the wallet a connection is of; without one, a disconnect is from the connections from before", async () => {
    const { storageMod, permissionsMod } = await loadPermissionsModule();
    expect(() => permissionsMod.approveOrigin("https://example.com", grant(W1, 0))).toThrow("walletId is required");
    await permissionsMod.approveOrigin("https://example.com", grant(W1, 0), W1[0]);
    storageMod.__getStore().dusk_permissions_v1 = { "https://example.com": grant(W1, 0), "https://other.example": grant(W1, 1) };
    await permissionsMod.revokeOrigin("https://example.com", " ");
    expect(storageMod.__getStore().dusk_permissions_v1).toEqual({ "https://other.example": grant(W1, 1) });
    await expect(permissionsMod.getPermissionForOrigin("https://example.com", W1[0])).resolves.toMatchObject(grant(W1, 0));
  });

  it("gets permission for origin", async () => {
    const { permissionsMod } = await loadPermissionsModule();
    await permissionsMod.approveOrigin("https://example.com", grant(W1, 1, true), W1[0]);
    await expect(permissionsMod.getPermissionForOrigin("https://example.com", W1[0])).resolves.toMatchObject(grant(W1, 1, true));
  });

  it("preserves shielded grant only when reconnecting the same profile", async () => {
    const { permissionsMod } = await loadPermissionsModule();
    await permissionsMod.approveOrigin("https://example.com", grant(W1, 1, true), W1[0]);

    const same = await permissionsMod.approveOrigin("https://example.com", grant(W1, 1), W1[0]);
    expect(same.grants.shieldedReceiveAddress).toBe(true);

    const different = await permissionsMod.approveOrigin("https://example.com", grant(W1, 0), W1[0]);
    expect(different.grants.shieldedReceiveAddress).toBe(false);
  });

  it("does not lose concurrent grants", async () => {
    const { permissionsMod } = await loadPermissionsModule();
    await Promise.all([
      permissionsMod.approveOrigin("https://a.example", { accountIndex: 0 }, W1[0]),
      permissionsMod.approveOrigin("https://b.example", { accountIndex: 1 }, W1[0]),
      permissionsMod.approveOrigin("https://a.example", { accountIndex: 1 }, W2[0]),
    ]);
    await expect(permissionsMod.getPermissions(W1[0])).resolves.toMatchObject({
      "https://a.example": { accountIndex: 0 },
      "https://b.example": { accountIndex: 1 },
    });
    await expect(permissionsMod.getPermissions(W2[0])).resolves.toEqual({
      "https://a.example": expect.objectContaining({ accountIndex: 1 }),
    });
  });

  it("revokes origin, of its wallet only", async () => {
    const { permissionsMod } = await loadPermissionsModule();
    await permissionsMod.approveOrigin("https://example.com", grant(W1, 0), W1[0]);
    await permissionsMod.approveOrigin("https://example.com", grant(W2, 0), W2[0]);
    await permissionsMod.revokeOrigin("https://example.com", W1[0]);
    await expect(permissionsMod.getPermissionForOrigin("https://example.com", W1[0])).resolves.toBeNull();
    await expect(permissionsMod.getPermissionForOrigin("https://example.com", W2[0])).resolves.toMatchObject(grant(W2, 0));
  });

  it("forgets a site that disconnects itself on every wallet, and on the connections from before", async () => {
    const { storageMod, permissionsMod } = await loadPermissionsModule();
    await permissionsMod.approveOrigin("https://site.example", grant(W1, 0), W1[0]);
    await permissionsMod.approveOrigin("https://site.example", grant(W2, 1), W2[0]);
    await permissionsMod.approveOrigin("https://other.example", grant(W2, 0), W2[0]);
    storageMod.__getStore().dusk_permissions_v1 = { "https://site.example": grant(W1, 1) };

    await permissionsMod.revokeOriginEverywhere("https://site.example");
    await expect(permissionsMod.getPermissions(W1[0])).resolves.toEqual({});
    await expect(permissionsMod.getPermissions(W2[0])).resolves.toEqual({ "https://other.example": expect.objectContaining(grant(W2, 0)) });
    expect(storageMod.__getStore().dusk_permissions_v1).toBeUndefined();
  });

  it("clears one wallet's sites, or every wallet's for a reset", async () => {
    const { storageMod, permissionsMod } = await loadPermissionsModule();
    await permissionsMod.approveOrigin("https://example.com", grant(W1, 0), W1[0]);
    await permissionsMod.approveOrigin("https://example.org", grant(W1, 1), W1[0]);
    await permissionsMod.approveOrigin("https://example.org", grant(W2, 1), W2[0]);

    await permissionsMod.clearPermissions(W1[0]);
    await expect(permissionsMod.getPermissions(W1[0])).resolves.toEqual({});
    await expect(permissionsMod.getPermissions(W2[0])).resolves.toMatchObject({ "https://example.org": grant(W2, 1) });

    // No wallet: the connections from before only.
    storageMod.__getStore().dusk_permissions_v1 = { "https://old.example": grant(W1, 0) };
    await permissionsMod.clearPermissions("");
    expect(storageMod.__getStore().dusk_permissions_v1).toBeUndefined();
    await expect(permissionsMod.getPermissions(W2[0])).resolves.toMatchObject({ "https://example.org": grant(W2, 1) });

    // A reset: every wallet's, and those from before.
    storageMod.__getStore().dusk_permissions_v1 = { "https://old.example": grant(W1, 0) };
    await permissionsMod.clearAllPermissions();
    expect(storageMod.__getStore()).toEqual({});
  });

  it("a site connected to one wallet sees nothing of another unless it's connected there too", async () => {
    const { permissionsMod } = await loadPermissionsModule();
    const site = "https://shop.example";
    await permissionsMod.approveOrigin(site, grant(W1, 1), W1[0]);
    const seen = async (accounts) =>
      permissionsMod.permissionProfileState(await permissionsMod.getPermissionForOrigin(site, accounts[0]), unlocked(accounts));

    expect(await seen(W1)).toEqual({ isValid: true, profile: { profileId: `account:1:${W1[1]}`, account: W1[1] } });
    // Wallet 2 unlocked: no connection, so nothing of it.
    expect(await seen(W2)).toEqual({ isValid: false, profile: null });
    // Even wallet 1's record, asked against wallet 2's profiles, shows none of them.
    expect(permissionsMod.permissionProfileState({ ...grant(W1, 1), updatedAt: 1 }, unlocked(W2))).toEqual({ isValid: false, profile: null });

    await permissionsMod.approveOrigin(site, grant(W2, 0), W2[0]);
    expect((await seen(W2)).profile).toEqual({ profileId: `account:0:${W2[0]}`, account: W2[0] });
    expect((await seen(W1)).profile).toEqual({ profileId: `account:1:${W1[1]}`, account: W1[1] });
  });

  it("moves the connections from before under the wallet whose profiles they are", async () => {
    const { storageMod, permissionsMod } = await loadPermissionsModule();
    const at = { connectedAt: 1, updatedAt: 2 };
    const legacy = {
      "https://a.example": { ...grant(W1, 0), ...at },
      "https://b.example": { ...grant(W1, 1, true), ...at },
      // A profile of no wallet unlocked here yet.
      "https://c.example": { ...grant(["x0", "x1"], 1), ...at },
    };
    storageMod.__getStore().dusk_permissions_v1 = structuredClone(legacy);

    // Before any wallet is unlocked since, they're what's connected.
    await expect(permissionsMod.getPermissions("")).resolves.toEqual(legacy);
    await expect(permissionsMod.getPermissions(W1[0])).resolves.toEqual({});

    // Wallet 2 adopts none of them; wallet 1 adopts its own, writing none over.
    await expect(permissionsMod.adoptLegacyPermissions(W2[0], W2)).resolves.toBe(0);
    await permissionsMod.approveOrigin("https://a.example", grant(W1, 1), W1[0]);
    const newer = await permissionsMod.getPermissionForOrigin("https://a.example", W1[0]);
    await expect(permissionsMod.adoptLegacyPermissions(W1[0], W1)).resolves.toBe(2);

    await expect(permissionsMod.getPermissions(W1[0])).resolves.toEqual({
      "https://a.example": newer,
      "https://b.example": legacy["https://b.example"],
    });
    await expect(permissionsMod.getPermissions(W2[0])).resolves.toEqual({});
    expect(storageMod.__getStore().dusk_permissions_v1).toEqual({ "https://c.example": legacy["https://c.example"] });

    // Done again, nothing changes; the last one gone, so is the record from before.
    await expect(permissionsMod.adoptLegacyPermissions(W1[0], W1)).resolves.toBe(0);
    await expect(permissionsMod.adoptLegacyPermissions("x0", ["x0", "x1"])).resolves.toBe(1);
    expect(storageMod.__getStore().dusk_permissions_v1).toBeUndefined();
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
