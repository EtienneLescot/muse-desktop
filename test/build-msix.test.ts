import assert from "node:assert/strict";
import { test } from "node:test";
import { appxManifest, msixVersion, STORE_IDENTITY } from "../scripts/build-msix.mjs";

test("MSIX version is x.y.z.0 and refuses pre-releases", () => {
  assert.equal(msixVersion("0.4.0"), "0.4.0.0");
  assert.throws(() => msixVersion("0.4.0-rc.1"));
});

test("manifest carries the Store identity and the full-trust entry point", () => {
  const xml = appxManifest("1.2.3");
  assert.match(xml, new RegExp(`Name="${STORE_IDENTITY.name}" Publisher="${STORE_IDENTITY.publisher}" Version="1.2.3.0"`));
  assert.match(xml, /Executable="muse-desktop.exe" EntryPoint="Windows.FullTrustApplication"/);
  assert.match(xml, /rescap:Capability Name="runFullTrust"/);
});
