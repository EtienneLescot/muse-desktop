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
    if ($LASTEXITCODE -ne 0) {
        throw "Frontend build failed with exit code $LASTEXITCODE"
    }
    npm run tauri -- build --bundles $Bundle
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri build failed with exit code $LASTEXITCODE"
    }

    $bundleRoot = Join-Path $repo "src-tauri\target\release\bundle"
    $artifacts = @()
    if ($Bundle -eq "nsis" -or $Bundle -eq "all") {
        $nsisDir = Join-Path $bundleRoot "nsis"
        $artifacts += Get-ChildItem -LiteralPath $nsisDir -Filter "*-setup.exe" -File |
            Sort-Object LastWriteTimeUtc -Descending |
            Select-Object -First 1
    }
    if ($Bundle -eq "msi" -or $Bundle -eq "all") {
        $msiDir = Join-Path $bundleRoot "msi"
        $artifacts += Get-ChildItem -LiteralPath $msiDir -Filter "*.msi" -File |
            Sort-Object LastWriteTimeUtc -Descending |
            Select-Object -First 1
    }
    if ($artifacts.Count -eq 0) {
        throw "No Windows installer found in $bundleRoot"
    }

    foreach ($installer in $artifacts) {
        $manifest = Join-Path $installer.DirectoryName "$($installer.BaseName).manifest.json"
        node (Join-Path $repo "scripts\release-manifest.mjs") `
            --artifact $installer.FullName `
            --sidecar $sidecar `
            --output $manifest `
            --version $version `
            --target "x86_64-pc-windows-msvc"
        if ($LASTEXITCODE -ne 0) {
            throw "Release manifest generation failed: $manifest"
        }
        node (Join-Path $repo "scripts\verify-release-manifest.mjs") `
            --manifest $manifest `
            --artifact $installer.FullName `
            --sidecar $sidecar `
            --version $version `
            --target "x86_64-pc-windows-msvc"
        if ($LASTEXITCODE -ne 0) {
            throw "Release manifest verification failed: $manifest"
        }
    }
} finally {
    Pop-Location
}
