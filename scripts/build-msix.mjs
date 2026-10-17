#!/usr/bin/env node

/**
 * Package the release build as an MSIX for the Microsoft Store.
 *
 * Tauri bundles NSIS and MSI only. This takes what `tauri build` left in
 * src-tauri/target/release (the app; the Muse engine is the user's own), adds the Store
 * tiles and a manifest carrying the identity Partner Center assigned to product
 * 9NBPFWQBGLZG, and packs them with the Windows SDK's makeappx. The package is
 * unsigned on purpose: the Store signs what it publishes.
 *
 *   npx tauri build --no-bundle && node scripts/build-msix.mjs
 *
 * MAKEAPPX overrides the makeappx.exe path (makepri.exe is taken next to it);
 * otherwise the newest Windows Kits x64 copy is used.
 */
import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Partner Center > product 9NBPFWQBGLZG > Product identity (reserved 14/10/2026). The display
// name must be one of the product's reserved names: "MuDesktop" since the 16/10/2026 rejection
// (10.1.1.1, no third-party product in the name).
export const STORE_IDENTITY = {
  name: "EtienneLescot.DesktopforMuseCode",
  publisher: "CN=03B0FC8C-2067-45D9-BE82-9F15CE264B4A",
  publisherDisplayName: "Etienne Lescot",
  displayName: "MuDesktop",
};

// Tiles `tauri icon` generates for Windows that the manifest references.
const TILES = ["StoreLogo.png", "Square44x44Logo.png", "Square71x71Logo.png", "Square150x150Logo.png"];

// Without unplated variants of the 44x44 logo, Windows draws the accent-coloured
// plate behind the icon in the taskbar and Start's app list (reported on 0.4.1).
// It picks these by pixel size; "lightunplated" is the light-taskbar variant.
const UNPLATED_SIZES = [16, 24, 32, 48, 256];

/** Store versions have four parts and the last one must be 0. */
export function msixVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`MSIX needs a plain x.y.z version, got "${version}"`);
  return `${match[1]}.${match[2]}.${match[3]}.0`;
}

export function appxManifest(version, identity = STORE_IDENTITY) {
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity Name="${identity.name}" Publisher="${identity.publisher}" Version="${msixVersion(version)}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>${identity.displayName}</DisplayName>
    <PublisherDisplayName>${identity.publisherDisplayName}</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
    <Resource Language="fr-fr" />
  </Resources>
  <Applications>
    <Application Id="App" Executable="muse-desktop.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="${identity.displayName}" Description="Desktop app for an AI coding agent"
        BackgroundColor="transparent" Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png">
        <uap:DefaultTile Square71x71Logo="Assets\\Square71x71Logo.png" />
      </uap:VisualElements>
    </Application>
  </Applications>
  <Capabilities>
    <Capability Name="internetClient" />
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
`;
}

function findMakeappx() {
  if (process.env.MAKEAPPX) return process.env.MAKEAPPX;
  const kits = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  const versions = existsSync(kits) ? readdirSync(kits).filter((v) => /^10\./.test(v)).sort().reverse() : [];
  for (const v of versions) {
    const candidate = join(kits, v, "x64", "makeappx.exe");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("makeappx.exe not found: install the Windows SDK or set MAKEAPPX");
}

function main() {
  const root = resolve(import.meta.dirname, "..");
  const release = join(root, "src-tauri", "target", "release");
  const out = join(root, "src-tauri", "target", "msix");
  const layout = join(out, "layout");
  const version = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(layout, "Assets"), { recursive: true });
  const app = join(release, "muse-desktop.exe");
  if (!existsSync(app)) throw new Error(`${app} is missing: run \`npx tauri build --no-bundle\` first`);
  copyFileSync(app, join(layout, "muse-desktop.exe"));

  const icons = join(out, "icons");
  const master = join(root, "src-tauri", "icons", "macos-icon-1024.png");
  execSync(`npx tauri icon "${master}" -o "${icons}"`, { cwd: root, stdio: "inherit" });
  for (const tile of TILES) copyFileSync(join(icons, tile), join(layout, "Assets", tile));
  const sized = join(out, "icons-unplated");
  execSync(`npx tauri icon "${master}" -o "${sized}" -p ${UNPLATED_SIZES.join(",")}`, { cwd: root, stdio: "inherit" });
  for (const n of UNPLATED_SIZES) {
    for (const form of ["altform-unplated", "altform-lightunplated"]) {
      copyFileSync(join(sized, `${n}x${n}.png`), join(layout, "Assets", `Square44x44Logo.targetsize-${n}_${form}.png`));
    }
  }

  const manifest = join(layout, "AppxManifest.xml");
  writeFileSync(manifest, appxManifest(version));
  // Qualified assets (targetsize, altform) only resolve through a resource
  // index: without resources.pri Windows ignores the unplated icons.
  const makeappx = findMakeappx();
  const makepri = join(dirname(makeappx), "makepri.exe");
  const priconfig = join(out, "priconfig.xml");
  execFileSync(makepri, ["createconfig", "/cf", priconfig, "/dq", "en-US", "/pv", "10.0.0", "/o"], { stdio: "inherit" });
  execFileSync(makepri, ["new", "/pr", layout, "/cf", priconfig, "/mn", manifest, "/of", join(layout, "resources.pri"), "/o"], { stdio: "inherit" });
  const msix = join(out, `MuDesktop_${version}_x64.msix`);
  execFileSync(makeappx, ["pack", "/o", "/d", layout, "/p", msix], { stdio: "inherit" });
  console.log(msix);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
