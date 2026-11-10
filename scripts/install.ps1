<#
.SYNOPSIS
    ExoDeck cross-platform installer for Windows.
.DESCRIPTION
    Downloads and installs the latest ExoDeck binary for Windows.
    By default, installs to the user profile without requiring administrator permissions:
      $env:LOCALAPPDATA\Programs\ExoDeck\xd.exe
    Automatically unblocks the binary to prevent Windows SmartScreen unrecognized app warnings.
.EXAMPLE
    # One-line user installation via PowerShell (No Admin Required):
    irm https://raw.githubusercontent.com/ExoDeck/exodeck/main/scripts/install.ps1 | iex
.EXAMPLE
    # Specific version:
    powershell -ExecutionPolicy Bypass -File install.ps1 -Version "1.0.0"
.EXAMPLE
    # System-wide installation (requires Administrator privileges):
    powershell -ExecutionPolicy Bypass -File install.ps1 -System
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Version,

    [Parameter()]
    [string]$InstallDir,

    [Parameter()]
    [switch]$System,

    [Parameter()]
    [string]$LocalArchive
)

$ErrorActionPreference = "Stop"

$repo = "ExoDeck/exodeck"
$binaryName = "xd.exe"

function Write-Info([string]$msg) {
    Write-Host "[INFO] $msg" -ForegroundColor Cyan
}

function Write-Success([string]$msg) {
    Write-Host "[SUCCESS] $msg" -ForegroundColor Green
}

function Write-Warn([string]$msg) {
    Write-Host "[WARN] $msg" -ForegroundColor Yellow
}

function Write-Err([string]$msg) {
    Write-Host "[ERROR] $msg" -ForegroundColor Red
}

try {
    # 1. Determine Architecture (amd64 or arm64)
    $isArm = ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") -or ($env:PROCESSOR_ARCHITEW6432 -eq "ARM64")
    $arch = if ($isArm) { "arm64" } else { "amd64" }

    # 2. Determine Version
    $tag = ""
    if ($Version) {
        $tag = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }
    } elseif ($LocalArchive) {
        $tag = "local"
    } else {
        Write-Info "Fetching latest release information from GitHub..."
        try {
            $latest = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ "User-Agent" = "ExoDeck-Installer" }
            $tag = $latest.tag_name
        } catch {
            Write-Warn "Could not query GitHub releases API directly ($($_.Exception.Message)). Falling back to latest release URL."
            $tag = "v1.0.0"
        }
    }

    if (-not $tag) {
        throw "Failed to resolve target release version."
    }

    Write-Info "Installing ExoDeck $tag for windows-$arch..."

    # 3. Determine Installation Directory
    $targetDir = ""
    $scope = "User"

    if ($InstallDir) {
        $targetDir = [System.IO.Path]::GetFullPath($InstallDir)
    } elseif ($System) {
        $targetDir = "C:\Program Files\ExoDeck"
        $scope = "Machine"
        
        # Verify admin permissions for System install
        $currentPrincipal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        $isAdmin = $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        if (-not $isAdmin) {
            throw "System-wide installation to '$targetDir' requires Administrator privileges. Run PowerShell as Administrator or install without -System."
        }
    } else {
        # Default: User-scoped install without admin permissions
        $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
        if (-not $localAppData) {
            $localAppData = Join-Path $env:USERPROFILE "AppData\Local"
        }
        $targetDir = Join-Path $localAppData "Programs\ExoDeck"
        $scope = "User"
    }

    Write-Info "Target install folder: $targetDir"
    if (-not (Test-Path -Path $targetDir)) {
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    }

    # 4. Create Temporary Directory
    $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("exodeck_install_" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

    $zipPath = ""
    if ($LocalArchive) {
        $zipPath = [System.IO.Path]::GetFullPath($LocalArchive)
        if (-not (Test-Path -Path $zipPath)) {
            throw "Local archive not found: $zipPath"
        }
        Write-Info "Using local archive: $zipPath"
    } else {
        $zipName = "exodeck-$tag-windows-$arch.zip"
        $zipUrl = "https://github.com/$repo/releases/download/$tag/$zipName"
        $zipPath = Join-Path $tempDir $zipName

        Write-Info "Downloading $zipUrl..."
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing

        # 5. Unblock downloaded archive to prevent Mark-of-the-Web SmartScreen triggers
        try {
            Unblock-File -Path $zipPath -ErrorAction SilentlyContinue
        } catch {}

        # 6. Verify Checksum (if checksums.txt is available)
        $checksumUrl = "https://github.com/$repo/releases/download/$tag/checksums.txt"
        $checksumPath = Join-Path $tempDir "checksums.txt"
        try {
            Invoke-WebRequest -Uri $checksumUrl -OutFile $checksumPath -UseBasicParsing -ErrorAction SilentlyContinue
            if (Test-Path -Path $checksumPath) {
                $expectedLine = Get-Content $checksumPath | Where-Object { $_ -match [regex]::Escape($zipName) } | Select-Object -First 1
                if ($expectedLine) {
                    $expectedHash = ($expectedLine -split '\s+')[0].Trim().ToLower()
                    $actualHash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLower()
                    if ($expectedHash -ne $actualHash) {
                        throw "SHA256 checksum mismatch! Expected: $expectedHash, Actual: $actualHash"
                    }
                    Write-Info "SHA256 checksum verified successfully."
                }
            }
        } catch {
            Write-Warn "Checksum validation note: $($_.Exception.Message)"
        }
    }

    # 7. Extract archive
    $extractDir = Join-Path $tempDir "extracted"
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

    # 8. Check if xd process is running and stop it before copying
    $wasRunning = $false
    $xdProcesses = Get-Process -Name "xd" -ErrorAction SilentlyContinue
    if ($xdProcesses) {
        $wasRunning = $true
        Write-Info "Found running ExoDeck (xd) process. Stopping it before updating binary..."
        foreach ($proc in $xdProcesses) {
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            } catch {
                Write-Warn "Could not stop process $($proc.Id): $($_.Exception.Message)"
            }
        }

        # Wait for processes to exit so file lock is released
        $waitCount = 0
        while ((Get-Process -Name "xd" -ErrorAction SilentlyContinue) -and ($waitCount -lt 10)) {
            Start-Sleep -Milliseconds 500
            $waitCount++
        }

        if (Get-Process -Name "xd" -ErrorAction SilentlyContinue) {
            Write-Warn "One or more xd processes could not be stopped. Copying may fail if the binary is locked."
        } else {
            Write-Info "ExoDeck process stopped successfully."
        }
    }

    # 9. Copy binary and unblock
    $sourceExe = Join-Path $extractDir $binaryName
    if (-not (Test-Path -Path $sourceExe)) {
        throw "Binary '$binaryName' not found inside downloaded archive."
    }

    $destExe = Join-Path $targetDir $binaryName
    Copy-Item -Path $sourceExe -Destination $destExe -Force

    # Copy LICENSE and README if present
    foreach ($docFile in @("LICENSE", "README.md")) {
        $srcDoc = Join-Path $extractDir $docFile
        if (Test-Path -Path $srcDoc) {
            Copy-Item -Path $srcDoc -Destination (Join-Path $targetDir $docFile) -Force
        }
    }

    # Unblock the destination executable
    try {
        Unblock-File -Path $destExe -ErrorAction SilentlyContinue
        Write-Info "Unblocked $destExe to prevent SmartScreen warnings."
    } catch {}

    # 10. Update PATH environment variable
    $pathVar = [Environment]::GetEnvironmentVariable("Path", $scope)
    $pathParts = if ($pathVar) { $pathVar -split ';' } else { @() }
    $alreadyInPath = $pathParts | Where-Object { $_.Trim().TrimEnd('\') -eq $targetDir.Trim().TrimEnd('\') }

    if (-not $alreadyInPath) {
        $newPath = if ($pathVar) { "$pathVar;$targetDir" } else { $targetDir }
        [Environment]::SetEnvironmentVariable("Path", $newPath, $scope)
        Write-Success "Added '$targetDir' to $scope PATH environment variable."
    }

    # Also update current session PATH so user can run xd immediately in the current console
    if (-not ($env:Path -split ';' | Where-Object { $_.Trim().TrimEnd('\') -eq $targetDir.Trim().TrimEnd('\') })) {
        $env:Path = "$targetDir;$env:Path"
    }

    # 11. Create Minimized Shortcut with xd.exe icon in the installation directory (only if not existing)
    $shortcutPath = Join-Path $targetDir "ExoDeck.lnk"
    $startMenuPrograms = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
    $startMenuShortcut = if ($startMenuPrograms) { Join-Path $startMenuPrograms "ExoDeck.lnk" } else { $null }

    if (-not (Test-Path -Path $shortcutPath)) {
        try {
            $wscript = New-Object -ComObject WScript.Shell
            $shortcut = $wscript.CreateShortcut($shortcutPath)
            $shortcut.TargetPath = $destExe
            $shortcut.WorkingDirectory = $targetDir
            $shortcut.WindowStyle = 7 # 7 = Minimized window
            $shortcut.IconLocation = "$destExe,0"
            $shortcut.Description = "ExoDeck - Local-first personal cockpit and knowledge management"
            $shortcut.Save()
            Write-Success "Created minimized shortcut: $shortcutPath"

            # Also copy shortcut to user's Start Menu Programs folder if not existing
            if ($startMenuShortcut -and (-not (Test-Path -Path $startMenuShortcut))) {
                Copy-Item -Path $shortcutPath -Destination $startMenuShortcut -Force -ErrorAction SilentlyContinue
            }

            # Attempt to pin shortcut to taskbar if supported by environment
            try {
                $shell = New-Object -ComObject Shell.Application
                $folder = $shell.Namespace($targetDir)
                $item = $folder.ParseName("ExoDeck.lnk")
                if ($item) {
                    $pinVerb = $item.Verbs() | Where-Object {
                        $name = $_.Name.Replace('&', '').ToLower()
                        $name -match 'pin to taskbar' -or $name -match 'an taskleiste anheften' -or $name -match 'taskbar' -or $name -match 'taskleiste'
                    } | Select-Object -First 1

                    if ($pinVerb) {
                        $pinVerb.DoIt()
                        Write-Success "Pinned shortcut to taskbar."
                    } else {
                        $userPinned = Join-Path $env:APPDATA "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"
                        if ((Test-Path -Path $userPinned) -and (-not (Test-Path -Path (Join-Path $userPinned "ExoDeck.lnk")))) {
                            Copy-Item -Path $shortcutPath -Destination (Join-Path $userPinned "ExoDeck.lnk") -Force -ErrorAction SilentlyContinue
                        }
                        Write-Info "Taskbar pinning note: Windows may require manual pinning via right-click on the shortcut -> 'Pin to taskbar'."
                    }
                }
            } catch {
                Write-Warn "Could not automatically pin to taskbar: $($_.Exception.Message)"
            }
        } catch {
            Write-Warn "Could not create shortcut: $($_.Exception.Message)"
        }
    } else {
        Write-Info "Shortcut already exists at '$shortcutPath'; skipping creation."
    }

    # Clean up temp
    try {
        Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    } catch {}

    Write-Host ""
    Write-Success "ExoDeck ($tag) installed successfully!"
    Write-Host ""
    Write-Info "Executable location: $destExe"
    Write-Info "Working directory & default data: $env:USERPROFILE\.exodeck"
    Write-Info "Launch ExoDeck by typing: xd"
    Write-Info "App URL: http://localhost:8000"
    Write-Host ""

} catch {
    Write-Err "Installation failed: $($_.Exception.Message)"
    exit 1
}
