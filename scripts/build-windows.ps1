param(
    [ValidateSet("nsis", "msi", "all")]
    [string]$Bundle = "nsis"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$sidecar = Join-Path $repo "src-tauri\binaries\muse-x86_64-pc-windows-msvc.exe"
$package = Get-Content -LiteralPath (Join-Path $repo "package.json") -Raw | ConvertFrom-Json
$version = [string]$package.version

if ([string]::IsNullOrWhiteSpace($version)) {
    throw "Missing package version in $repo\package.json"
}

if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf)) {
    throw "Missing Windows x64 Muse sidecar: $sidecar"
}

Push-Location $repo
try {
    npm run build
    npm run tauri -- build --bundles $Bundle
    if ($Bundle -eq "nsis" -or $Bundle -eq "all") {
        $bundleDir = Join-Path $repo "src-tauri\target\release\bundle\nsis"
        $installer = Get-ChildItem -LiteralPath $bundleDir -Filter "*-setup.exe" -File |
            Sort-Object LastWriteTimeUtc -Descending |
            Select-Object -First 1
        if ($null -eq $installer) {
            throw "No NSIS installer found in $bundleDir"
        }
        $manifest = Join-Path $installer.DirectoryName "$($installer.BaseName).manifest.json"
        node (Join-Path $repo "scripts\release-manifest.mjs") `
            --artifact $installer.FullName `
            --sidecar $sidecar `
            --output $manifest `
            --version $version `
            --target "x86_64-pc-windows-msvc"
    }
} finally {
    Pop-Location
}
