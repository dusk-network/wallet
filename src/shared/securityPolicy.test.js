import { describe, expect, it } from "vitest";

import {
  isAllowedDappEndpoint,
  isAllowedDappOrigin,
  isLocalHttpHostname,
} from "./securityPolicy.js";

describe("security policy", () => {
  it.each([
    ["localhost", true],
    ["LOCALHOST", true],
    ["127.0.0.1", true],
    ["::1", true],
    ["[::1]", true],
    ["192.168.1.10", false],
    ["10.0.0.2", false],
    ["dapp.example", false],
  ])("classifies local HTTP hostname %s", (hostname, expected) => {
    expect(isLocalHttpHostname(hostname)).toBe(expected);
  });

  it.each([
    ["https://dapp.example", true],
    ["https://dapp.example/path", true],
    ["http://localhost:5173", true],
    ["http://127.0.0.1:5173", true],
    ["http://[::1]:5173", true],
    ["http://dapp.example", false],
    ["http://192.168.1.10:5173", false],
    ["ftp://dapp.example", false],
    ["chrome-extension://abc/page.html", false],
    ["", false],
    ["not a url", false],
  ])("validates dApp origin %s", (origin, expected) => {
    expect(isAllowedDappOrigin(origin)).toBe(expected);
  });

  it.each([
    ["https://testnet.nodes.dusk.network", true],
    ["http://localhost:8080", true],
    ["http://127.0.0.1:8080", true],
    ["http://[::1]:8080", true],
    ["http://node.example:8080", false],
    ["http://192.168.1.20:8080", false],
  ])("validates dApp-selectable endpoints %s", (endpoint, expected) => {
    expect(isAllowedDappEndpoint(endpoint)).toBe(expected);
  });
});
