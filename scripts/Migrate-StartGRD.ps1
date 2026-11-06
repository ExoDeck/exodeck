<#
.SYNOPSIS
    Migrates StartGRD data files and config from the old naming scheme to the new one.

.DESCRIPTION
    Renames the following fields in JSON data files:
      - groups[*].titel         → title
      - items[*].todo_checked   → task_checked
      - items[*].todo_due_date  → task_due_date
      - items[*].todo_created   → task_created

    Renames the following fields in config.json:
      - data_locations          → workspaces
      - font_size_markdown      → font_size_note

.PARAMETER DataFolder
    Path to the folder containing .json page data files (default: ./data).

.PARAMETER ConfigFile
    Path to config.json (default: ./config.json).

.PARAMETER DryRun
    Preview changes without writing any files.

.EXAMPLE
    .\Migrate-StartGRD.ps1 -DryRun
    .\Migrate-StartGRD.ps1 -DataFolder C:\mydata -ConfigFile C:\myconfig.json
#>

[CmdletBinding()]
param(
    [string]$DataFolder = '.\data',
    [string]$ConfigFile = '.\config.json',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Backup-File {
    param([string]$Path)
    $ts = Get-Date -Format 'yyyyMMdd_HHmmss'
    $backup = "$Path.bak_$ts"
    Copy-Item -Path $Path -Destination $backup
    Write-Host "  Backup: $backup"
}

function Migrate-DataFile {
    param([string]$Path)

    $json = Get-Content -Path $Path -Raw -Encoding UTF8
    $data = $json | ConvertFrom-Json -Depth 20

    if (-not $data.groups) { return }

    $changed = $false

    foreach ($group in $data.groups) {
        # Rename 'titel' → 'title'
        if ($group.PSObject.Properties['titel']) {
            $titleValue = $group.titel
            $group.PSObject.Properties.Remove('titel')
            $group | Add-Member -NotePropertyName 'title' -NotePropertyValue $titleValue -Force
            $changed = $true
        }

        if (-not $group.items) { continue }

        foreach ($item in $group.items) {
            # Rename todo_checked → task_checked
            if ($item.PSObject.Properties['todo_checked']) {
                $val = $item.todo_checked
                $item.PSObject.Properties.Remove('todo_checked')
                $item | Add-Member -NotePropertyName 'task_checked' -NotePropertyValue $val -Force
                $changed = $true
            }
            # Rename todo_due_date → task_due_date
            if ($item.PSObject.Properties['todo_due_date']) {
                $val = $item.todo_due_date
                $item.PSObject.Properties.Remove('todo_due_date')
                $item | Add-Member -NotePropertyName 'task_due_date' -NotePropertyValue $val -Force
                $changed = $true
            }
            # Rename todo_created → task_created
            if ($item.PSObject.Properties['todo_created']) {
                $val = $item.todo_created
                $item.PSObject.Properties.Remove('todo_created')
                $item | Add-Member -NotePropertyName 'task_created' -NotePropertyValue $val -Force
                $changed = $true
            }
        }
    }

    if ($changed) {
        Write-Host "Migrating data file: $Path"
        if (-not $DryRun) {
            Backup-File -Path $Path
            $data | ConvertTo-Json -Depth 20 | Set-Content -Path $Path -Encoding UTF8 -NoNewline
        } else {
            Write-Host '  [DRY RUN] Would update this file.'
        }
    } else {
        Write-Host "No changes needed: $Path"
    }
}

function Migrate-Config {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        Write-Warning "Config file not found: $Path"
        return
    }

    $json = Get-Content -Path $Path -Raw -Encoding UTF8
    $cfg = $json | ConvertFrom-Json -Depth 10

    $changed = $false

    # Rename data_locations → workspaces
    if ($cfg.PSObject.Properties['data_locations']) {
        $val = $cfg.data_locations
        $cfg.PSObject.Properties.Remove('data_locations')
        $cfg | Add-Member -NotePropertyName 'workspaces' -NotePropertyValue $val -Force
        $changed = $true
    }

    # Rename font_size_markdown → font_size_note
    if ($cfg.PSObject.Properties['font_size_markdown']) {
        $val = $cfg.font_size_markdown
        $cfg.PSObject.Properties.Remove('font_size_markdown')
        $cfg | Add-Member -NotePropertyName 'font_size_note' -NotePropertyValue $val -Force
        $changed = $true
    }

    if ($changed) {
        Write-Host "Migrating config: $Path"
        if (-not $DryRun) {
            Backup-File -Path $Path
            $cfg | ConvertTo-Json -Depth 10 | Set-Content -Path $Path -Encoding UTF8 -NoNewline
        } else {
            Write-Host '  [DRY RUN] Would update this file.'
        }
    } else {
        Write-Host "No changes needed: $Path"
    }
}

# --- Main ---

Write-Host ''
if ($DryRun) { Write-Host '=== DRY RUN — no files will be modified ===' }

# Migrate data files
$resolvedData = Resolve-Path -Path $DataFolder -ErrorAction SilentlyContinue
if (-not $resolvedData) {
    Write-Warning "Data folder not found: $DataFolder"
} else {
    $files = Get-ChildItem -Path $resolvedData -Filter '*.json' -Recurse
    if ($files.Count -eq 0) {
        Write-Host "No .json files found in $DataFolder"
    } else {
        foreach ($file in $files) {
            Migrate-DataFile -Path $file.FullName
        }
    }
}

# Migrate config
Migrate-Config -Path ((Resolve-Path $ConfigFile -ErrorAction SilentlyContinue) ?? $ConfigFile)

Write-Host ''
Write-Host 'Done.'
