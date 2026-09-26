param(
    # Defaults to the newest *-setup.exe produced by build:windows.
    [string]$InstallerPath
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$sevenZip = "C:\Program Files\7-Zip\7z.exe"
if (-not (Test-Path $sevenZip)) {
    throw "7-Zip is required to verify the installer contents: $sevenZip"
}

if (-not $InstallerPath) {
    $nsisDir = Join-Path $repo "src-tauri\target\release\bundle\nsis"
    $InstallerPath = Get-ChildItem -LiteralPath $nsisDir -Filter "*-setup.exe" -File |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not (Test-Path $InstallerPath)) {
    throw "installer not found: $InstallerPath"
}
Write-Host "Installer: $InstallerPath"

# 1. Stop the app and any stuck installer/uninstaller first: a running app
#    keeps files locked and a half-finished silent install then leaves the OLD
#    build in place (measured twice on 26/09, docs/evidence/2026-09-26-m1-closure).
Get-Process |
    Where-Object { $_.Name -like "muse-desktop*" -or $_.Name -like "Muse-Desktop_*-setup*" -or $_.Name -eq "uninstall" } |
    Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# 2. Source of truth: the exe INSIDE the installer. target\release is not a
#    valid reference — the tauri pipeline may rewrite it after the bundle
#    captured its copy (build-windows.ps1 warns on that divergence).
$extract = Join-Path $env:TEMP "muse-install-verify"
Remove-Item -Recurse -Force $extract -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $extract | Out-Null
& $sevenZip e "-o$extract" -y $InstallerPath "muse-desktop.exe" -r | Out-Null
$bundleExe = Join-Path $extract "muse-desktop.exe"
if (-not (Test-Path $bundleExe)) {
    throw "could not extract muse-desktop.exe from the installer"
}
$expected = (Get-FileHash $bundleExe -Algorithm SHA256).Hash

# 3. Remove the previous install: the silent uninstaller can hang and a
#    same-version reinstall may then skip the replacement entirely.
$installDir = Join-Path $env:LOCALAPPDATA "Muse-Desktop"
Remove-Item -Recurse -Force $installDir -ErrorAction SilentlyContinue

# 4. Foreground silent install (-Wait): a background-shell run of the same
#    installer hung indefinitely on 26/09.
$proc = Start-Process -FilePath $InstallerPath -ArgumentList "/S" -Wait -PassThru
if ($proc.ExitCode -ne 0) {
    throw "installer exited with code $($proc.ExitCode)"
}

# 5. Verify the installed exe against the bundle's exe.
$installedExe = Join-Path $installDir "muse-desktop.exe"
if (-not (Test-Path $installedExe)) {
    throw "install did not produce $installedExe (the silent install hung or skipped)"
}
$actual = (Get-FileHash $installedExe -Algorithm SHA256).Hash
if ($actual -ne $expected) {
    throw "installed exe hash $($actual.Substring(0,8)) differs from the bundle's $($expected.Substring(0,8))"
}
$installedSize = (Get-Item $installedExe).Length
Write-Host "Installed and verified: $installedExe ($installedSize bytes, sha256 $($actual.Substring(0,8)))"
