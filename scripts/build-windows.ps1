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
    $bundleTargets = if ($Bundle -eq "all") { @("nsis", "msi") } else { @($Bundle) }
    foreach ($bundleTarget in $bundleTargets) {
        npm run tauri -- build --bundles $bundleTarget
        if ($LASTEXITCODE -ne 0) {
            throw "Tauri $bundleTarget build failed with exit code $LASTEXITCODE"
        }
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

    # Bundle-vs-tree identity guard (measured 26/09/2026, campaign
    # docs/evidence/2026-09-26-m1-closure): the tauri pipeline can rewrite
    # target/release\muse-desktop.exe AFTER the NSIS bundle captured it, so the
    # installed app was unverifiable against the tree. Compare the exe the
    # installer actually carries with the tree's exe; on divergence rebundle
    # once and regenerate the manifest; if it still diverges, say so loudly —
    # the installed app must then be verified against the BUNDLE, not the tree.
    $sevenZip = "C:\Program Files\7-Zip\7z.exe"
    $releaseExe = Join-Path $repo "src-tauri\target\release\muse-desktop.exe"
    if (-not (Test-Path $sevenZip)) {
        Write-Warning "7-Zip not found; skipped the bundle-vs-tree identity check"
    } elseif (-not (Test-Path $releaseExe)) {
        Write-Warning "target\release\muse-desktop.exe not found; skipped the bundle-vs-tree identity check"
    } else {
        function Get-BundleExeHash($setupPath) {
            $dir = Join-Path $env:TEMP "muse-bundle-verify"
            Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
            New-Item -ItemType Directory -Path $dir | Out-Null
            & $sevenZip e "-o$dir" -y $setupPath "muse-desktop.exe" -r | Out-Null
            $extracted = Join-Path $dir "muse-desktop.exe"
            if (-not (Test-Path $extracted)) { return $null }
            return (Get-FileHash $extracted -Algorithm SHA256).Hash
        }
        $nsisSetup = Get-ChildItem -LiteralPath (Join-Path $bundleRoot "nsis") -Filter "*-setup.exe" -File |
            Sort-Object LastWriteTimeUtc -Descending |
            Select-Object -First 1
        $bundledHash = Get-BundleExeHash $nsisSetup.FullName
        $treeHash = (Get-FileHash $releaseExe -Algorithm SHA256).Hash
        if ($bundledHash -eq $null) {
            Write-Warning "could not extract muse-desktop.exe from $($nsisSetup.Name); bundle identity unverified"
        } elseif ($bundledHash -ne $treeHash) {
            Write-Warning "bundle identity mismatch (bundled $($bundledHash.Substring(0,8)) vs tree $($treeHash.Substring(0,8))); rebundling once"
            npm run tauri -- build --bundles nsis
            if ($LASTEXITCODE -ne 0) {
                throw "Rebundle after identity mismatch failed"
            }
            $nsisSetup = Get-ChildItem -LiteralPath (Join-Path $bundleRoot "nsis") -Filter "*-setup.exe" -File |
                Sort-Object LastWriteTimeUtc -Descending |
                Select-Object -First 1
            $manifest = Join-Path $nsisSetup.DirectoryName "$($nsisSetup.BaseName).manifest.json"
            node (Join-Path $repo "scripts\release-manifest.mjs") `
                --artifact $nsisSetup.FullName `
                --sidecar $sidecar `
                --output $manifest `
                --version $version `
                --target "x86_64-pc-windows-msvc"
            if ($LASTEXITCODE -ne 0) {
                throw "Release manifest regeneration failed: $manifest"
            }
            node (Join-Path $repo "scripts\verify-release-manifest.mjs") `
                --manifest $manifest `
                --artifact $nsisSetup.FullName `
                --sidecar $sidecar `
                --version $version `
                --target "x86_64-pc-windows-msvc"
            if ($LASTEXITCODE -ne 0) {
                throw "Release manifest verification failed after rebundle: $manifest"
            }
            $bundledHash = Get-BundleExeHash $nsisSetup.FullName
            $treeHash = (Get-FileHash $releaseExe -Algorithm SHA256).Hash
            if ($bundledHash -ne $treeHash) {
                Write-Warning "bundle STILL differs from the tree after one rebundle (bundled $($bundledHash.Substring(0,8)) vs tree $($treeHash.Substring(0,8))); verify the installed app against the bundle's exe (scripts/install-packaged.ps1 does exactly that), not against target\release"
            } else {
                Write-Host "Bundle identity OK after rebundle ($($bundledHash.Substring(0,8)))"
            }
        } else {
            Write-Host "Bundle identity OK ($($bundledHash.Substring(0,8)))"
        }
    }
} finally {
    Pop-Location
}
