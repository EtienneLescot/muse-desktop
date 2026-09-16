param(
    [ValidateSet("nsis", "msi", "all")]
    [string]$Bundle = "nsis"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$sidecar = Join-Path $repo "src-tauri\binaries\muse-x86_64-pc-windows-msvc.exe"

if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf)) {
    throw "Missing Windows x64 Muse sidecar: $sidecar"
}

Push-Location $repo
try {
    npm run build
    npm run tauri -- build --bundles $Bundle
} finally {
    Pop-Location
}
