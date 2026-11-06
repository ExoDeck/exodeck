#!/usr/bin/env pwsh

$ErrorActionPreference = "Stop"

Write-Host "Running JavaScript and Markdown Linters..." -ForegroundColor Cyan
npm run lint
$npmExitCode = $LASTEXITCODE

Write-Host "`nRunning Go Linter (golangci-lint)..." -ForegroundColor Cyan
# Run golangci-lint using 'go run' to avoid requiring global installation.
# It automatically picks up .golangci.yml configuration.
go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest run
$goExitCode = $LASTEXITCODE

if ($npmExitCode -ne 0 -or $goExitCode -ne 0) {
    Write-Host "`n[FAIL] One or more linters reported errors." -ForegroundColor Red
    exit 1
}

Write-Host "`n[SUCCESS] All linters passed!" -ForegroundColor Green
