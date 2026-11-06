<#
.SYNOPSIS
    Builds ExoDeck, creates a versioned zip, and publishes to a local directory.

.DESCRIPTION
    1. Runs build-go.ps1 to produce dist\exodeck-go\.
    2. Creates exodeck-<version>.zip from dist\exodeck-go\ (config.json excluded).
    3. Wipes the publish location while preserving any existing config.json there.
    4. Copies dist\exodeck-go\ to the publish location (config.json excluded).

.PARAMETER PublishLocation
    Directory to publish the built application into.
    Defaults to C:\exodeck.

.EXAMPLE
    .\publish.ps1
    .\publish.ps1 -PublishLocation D:\apps\exodeck
#>
[CmdletBinding()]
param(
    [string]$PublishLocation = "C:\exodeck"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = $PSScriptRoot
$DistDir  = Join-Path $RepoRoot "dist\exodeck-go"

# ---------------------------------------------------------------------------
# Step 1: Build
# ---------------------------------------------------------------------------
Write-Host "`n[publish] Step 1/4 — Building..." -ForegroundColor Cyan
Push-Location $RepoRoot
try {
    .\build-go.ps1
    if ($LASTEXITCODE -ne 0) { throw "build-go.ps1 failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

if (-not (Test-Path $DistDir)) {
    throw "Expected dist directory not found after build: $DistDir"
}

# ---------------------------------------------------------------------------
# Read the version from version.go
# ---------------------------------------------------------------------------
$versionLine = Select-String -Path "$RepoRoot\version.go" -Pattern 'var\s+Version\s*=\s*"([^"]+)"'
$version = if ($versionLine) { $versionLine.Matches[0].Groups[1].Value } else { "0.0.0" }
if ($version -eq "dev") { $version = "0.0.0" }
Write-Host "[publish] Version: $version" -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# Step 2: Create versioned zip (excluding config.json)
# ---------------------------------------------------------------------------
$ZipPath = Join-Path $RepoRoot "dist\exodeck-$version.zip"
Write-Host "`n[publish] Step 2/4 — Creating zip: $ZipPath" -ForegroundColor Cyan

# Compress-Archive has no -Exclude, so stage in a temp directory first
$TempDir = Join-Path $env:TEMP ("exodeck-zip-" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $TempDir | Out-Null
try {
    # Robocopy: /E = include subdirs, /XF = exclude file, /NFL /NDL /NJH /NJS = quiet
    # Robocopy exit codes 0-7 indicate success; >=8 means a real error.
    robocopy $DistDir $TempDir /E /XF config.json /NFL /NDL /NJH /NJS | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy staging for zip failed (exit $LASTEXITCODE)" }

    if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
    Compress-Archive -Path "$TempDir\*" -DestinationPath $ZipPath
    Write-Host "[publish] Zip created: $ZipPath" -ForegroundColor Green
} finally {
    Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# Step 3: Wipe publish location, preserving config.json
# ---------------------------------------------------------------------------
Write-Host "`n[publish] Step 3/4 — Preparing publish location: $PublishLocation" -ForegroundColor Cyan

$PublishConfig = Join-Path $PublishLocation "config.json"
$savedConfig   = $null

if (Test-Path $PublishConfig) {
    $savedConfig = Get-Content -Path $PublishConfig -Raw
    Write-Host "[publish] Saved existing config.json for restore."
}

if (Test-Path $PublishLocation) {
    Remove-Item (Join-Path $PublishLocation "*") -Recurse -Force
    Write-Host "[publish] Wiped: $PublishLocation"
} else {
    New-Item -ItemType Directory -Path $PublishLocation | Out-Null
    Write-Host "[publish] Created: $PublishLocation"
}

# ---------------------------------------------------------------------------
# Step 4: Copy dist to publish location (excluding config.json)
# ---------------------------------------------------------------------------
Write-Host "`n[publish] Step 4/4 — Copying to publish location..." -ForegroundColor Cyan

robocopy $DistDir $PublishLocation /E /XF config.json /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy to publish location failed (exit $LASTEXITCODE)" }

# Restore config.json if one was saved
if ($null -ne $savedConfig) {
    Set-Content -Path $PublishConfig -Value $savedConfig -Encoding UTF8 -NoNewline
    Write-Host "[publish] Restored config.json."
} else {
    Write-Host "[publish] No existing config.json found at destination." -ForegroundColor Yellow
    Write-Host "[publish] Copy and edit config.json.example from the dist to get started." -ForegroundColor Yellow
}

Write-Host "`n[publish] Done!" -ForegroundColor Green
Write-Host "  Published : $PublishLocation"
Write-Host "  Zip file  : $ZipPath"
