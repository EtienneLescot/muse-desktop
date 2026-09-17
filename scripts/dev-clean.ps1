[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoPrefix = $repo.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

function Is-WithinRepo([string]$path) {
    if ([string]::IsNullOrWhiteSpace($path)) { return $false }
    try {
        $resolved = [IO.Path]::GetFullPath($path)
        return $resolved.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase) -or
            $resolved.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).Equals($repo, [StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

function Is-MuseDevProcess($process) {
    $path = [string]$process.ExecutablePath
    $commandLine = [string]$process.CommandLine
    $isRepoBinary = $path -and (Is-WithinRepo $path) -and
        ([IO.Path]::GetFileName($path) -ieq "muse-desktop.exe")
    $mentionsRepo = $commandLine -and $commandLine.IndexOf($repo, [StringComparison]::OrdinalIgnoreCase) -ge 0
    $isDevCommand = $commandLine -and $commandLine -match "(?i)(tauri\s+dev|vite)"
    return $isRepoBinary -or ($mentionsRepo -and $isDevCommand)
}

Write-Host "Muse-Desktop Windows development launcher"
Write-Host "Repository: $repo"

# Only terminate a process whose executable or command line is tied to this
# checkout. The process tree is stopped so a stale WebView/Vite child cannot
# keep serving an old renderer. Unrelated Node, Tauri, and Muse processes stay
# untouched.
Get-CimInstance Win32_Process |
    Where-Object { Is-MuseDevProcess $_ } |
    Sort-Object ProcessId -Descending |
    ForEach-Object {
        $processId = [int]$_.ProcessId
        if ($PSCmdlet.ShouldProcess("PID $processId", "Stop stale Muse-Desktop development process tree")) {
            & taskkill.exe /PID $processId /T /F | Out-Null
        }
    }

$viteCache = Join-Path $repo "node_modules\.vite"
if (Test-Path -LiteralPath $viteCache) {
    if (-not (Is-WithinRepo $viteCache)) { throw "Refusing to clear a cache outside the repository." }
    if ($PSCmdlet.ShouldProcess($viteCache, "Clear Vite transform cache")) {
        Remove-Item -LiteralPath $viteCache -Recurse -Force
    }
}

if ($PSCmdlet.ShouldProcess("npm run tauri -- dev", "Start Tauri with the Vite renderer")) {
    Push-Location $repo
    try {
        & npm.cmd run tauri -- dev
        if ($LASTEXITCODE -ne 0) {
            throw "Tauri development launch failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}
