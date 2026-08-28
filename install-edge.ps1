# Build, then print the unpacked path and open the Edge extensions page.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $here "dist"

if (-not (Test-Path (Join-Path $here "node_modules"))) {
    Write-Host "Installing dev dependencies..."
    & npm --prefix $here install --no-audit --no-fund
}

Write-Host "Building..."
& npm --prefix $here run build

Write-Host ""
Write-Host "Load unpacked from:"
Write-Host $dist
Write-Host ""
Write-Host "edge://extensions  ->  Developer mode  ->  Load unpacked"

$edge = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($edge) {
    Start-Process -FilePath $edge -ArgumentList "edge://extensions"
} else {
    Write-Host "msedge.exe not found - open edge://extensions yourself"
}
