#!/usr/bin/env pwsh
# build-go.ps1 — Build the Go backend as a single self-contained executable.
#
# Usage:
#   .\build-go.ps1                         # builds for current OS/ARCH
#   .\build-go.ps1 -OutputDir dist/custom  # custom output directory
#   .\build-go.ps1 -OS linux -Arch amd64   # cross-compile

param(
    [string]$OutputDir = "dist/exodeck-go",
    [string]$OS       = "",
    [string]$Arch     = "",
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"

# Detect current OS if not specified
if ([string]::IsNullOrEmpty($OS)) {
    if ($IsWindows -or $env:OS -eq "Windows_NT") {
        $OS = "windows"
    } elseif ($IsLinux) {
        $OS = "linux"
    } elseif ($IsMacOS) {
        $OS = "darwin"
    } else {
        # Fallback: let Go decide by not setting GOOS
        $OS = ""
    }
}

# Determine output binary name
$binaryName = if ($OS -eq "windows") { "xd.exe" } else { "xd" }
$outputPath = Join-Path $OutputDir $binaryName

# Read version from version.go (default to "dev" if not found)
$versionLine = Select-String -Path "version.go" -Pattern 'var\s+Version\s*=\s*"([^"]+)"'
$version = if ($versionLine) { $versionLine.Matches[0].Groups[1].Value } else { "dev" }
if ($version -eq "dev") {
    Write-Host "Version not found or set to 'dev' in version.go, using 0.0.0"
    $version = "0.0.0"
}

# Parse version parts for the Windows resource file
$parts = $version.Split('.')
$major = [int]($parts.Count -gt 0 ? $parts[0] : 0)
$minor = [int]($parts.Count -gt 1 ? $parts[1] : 0)
$patch = [int]($parts.Count -gt 2 ? $parts[2] : 0)

# Regenerate resource_windows_*.syso files with the current version (only applies to Windows targets)
if (Get-Command goversioninfo -ErrorAction SilentlyContinue) {
    # Patch version numbers in versioninfo.json on the fly via a temp copy
    $vi = Get-Content versioninfo.json -Raw | ConvertFrom-Json
    $vi.FixedFileInfo.FileVersion.Major    = $major
    $vi.FixedFileInfo.FileVersion.Minor    = $minor
    $vi.FixedFileInfo.FileVersion.Patch    = $patch
    $vi.FixedFileInfo.ProductVersion.Major = $major
    $vi.FixedFileInfo.ProductVersion.Minor = $minor
    $vi.FixedFileInfo.ProductVersion.Patch = $patch
    $vi.StringFileInfo.FileVersion    = $version
    $vi.StringFileInfo.ProductVersion = $version
    $vi | ConvertTo-Json -Depth 10 | Set-Content _versioninfo_tmp.json
    goversioninfo -platform-specific _versioninfo_tmp.json
    Remove-Item _versioninfo_tmp.json
    Write-Host "  resource_windows_*.syso regenerated (v$version)"
} else {
    Write-Warning "goversioninfo not found — skipping .syso regeneration. Install with: go install github.com/josephspurrier/goversioninfo/cmd/goversioninfo@latest"
}

if (-not $SkipTests) {
    Write-Host "Running Go tests with coverage..."
    go test -coverprofile coverage.out ./...
    if ($LASTEXITCODE -ne 0) { throw "go test failed" }
    Write-Host "  Coverage report generated: coverage.out"
}

Write-Host "Building Go backend..."
Write-Host "  OS=$OS  ARCH=$Arch  version=$version  -> $outputPath"

# Wipe and recreate output directory
if (Test-Path $OutputDir) {
    Remove-Item $OutputDir -Recurse -Force
    Write-Host "  Cleaned output directory: $OutputDir"
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

# Only set GOOS/GOARCH if explicitly provided (otherwise Go builds for current platform)
if (-not [string]::IsNullOrEmpty($OS)) {
    $env:GOOS = $OS
}
if (-not [string]::IsNullOrEmpty($Arch)) {
    $env:GOARCH = $Arch
}

go build "-ldflags=-w -X main.Version=$version" -o $outputPath .
if ($LASTEXITCODE -ne 0) { throw "go build failed" }

# Copy LICENSE and README.md into output directory for distribution
Copy-Item "LICENSE", "README.md" $OutputDir -Force

Write-Host "Build successful: $outputPath"
Write-Host "Binary size: $([int]((Get-Item $outputPath).Length / 1MB)) MB"