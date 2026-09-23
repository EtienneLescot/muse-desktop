import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hostPlatform, isMacPlatform } from "../src/lib/platform.ts";

describe("host platform detection", () => {
  it("maps webview platform strings", () => {
    assert.equal(hostPlatform("MacIntel"), "macos");
    assert.equal(hostPlatform("Win32"), "windows");
    assert.equal(hostPlatform("Linux x86_64"), "linux");
    assert.equal(hostPlatform(""), "unknown");
    assert.ok(isMacPlatform("MacIntel"));
    assert.ok(!isMacPlatform("Win32"));
  });
});

import { driverInstallCommand } from "../src/lib/computerUse.ts";

describe("cua-driver install command", () => {
  it("follows the host OS", () => {
    assert.match(driverInstallCommand("windows"), /install\.ps1/);
    assert.match(driverInstallCommand("macos"), /install\.sh/);
  });
});
