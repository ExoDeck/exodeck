//go:build !windows

package handlers

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

const appleScriptPath = "/usr/bin/osascript"

const appleScriptFolderPicker = `on run argv
	if (count of argv) > 0 and (item 1 of argv) is not "" then
		try
			return POSIX path of (choose folder with prompt "Select Workspace Folder" default location (POSIX file (item 1 of argv)))
		on error errMsg number errNum
			if errNum is -128 then error errMsg number errNum
		end try
	end if
	return POSIX path of (choose folder with prompt "Select Workspace Folder")
end run
`

func normalizeSelectedUnixPath(raw string) string {
	selected := strings.TrimSpace(raw)
	if len(selected) > 1 {
		selected = strings.TrimRight(selected, "/")
	}
	return selected
}

func runUnixDialogCommand(ctx context.Context, name string, args ...string) (string, string, int, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	exitCode := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		}
	}
	return stdout.String(), stderr.String(), exitCode, err
}

func pickFolderMacOS(ctx context.Context, initialDir string) (string, bool, error) {
	args := []string{"-"}
	if initialDir != "" {
		args = append(args, initialDir)
	}
	cmd := exec.CommandContext(ctx, appleScriptPath, args...)
	cmd.Stdin = strings.NewReader(appleScriptFolderPicker)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return "", true, ctxErr
		}
		errOut := strings.TrimSpace(stderr.String())
		if strings.Contains(errOut, "(-128)") {
			return "", true, nil
		}
		if errOut != "" {
			return "", false, fmt.Errorf("osascript failed: %s (%w)", errOut, err)
		}
		return "", false, err
	}

	selected := normalizeSelectedUnixPath(stdout.String())
	if selected == "" {
		return "", true, nil
	}
	return selected, false, nil
}

func pickFolderNative(ctx context.Context, initialDir string) (string, bool, error) {
	if err := ctx.Err(); err != nil {
		return "", true, err
	}

	if runtime.GOOS == "darwin" {
		if info, err := os.Stat(appleScriptPath); err != nil || info.IsDir() {
			return "", false, errPickerUnavailable
		}
		return pickFolderMacOS(ctx, initialDir)
	}

	if zenityPath, err := exec.LookPath("zenity"); err == nil {
		args := []string{"--file-selection", "--directory", "--title=Select Workspace Folder"}
		if initialDir != "" {
			filenameArg := initialDir
			if !strings.HasSuffix(filenameArg, "/") {
				filenameArg += "/"
			}
			args = append(args, "--filename="+filenameArg)
		}
		stdout, stderr, exitCode, runErr := runUnixDialogCommand(ctx, zenityPath, args...)
		if runErr != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return "", true, ctxErr
			}
			if exitCode == 1 || exitCode == 5 {
				return "", true, nil
			}
			errOut := strings.TrimSpace(stderr)
			if errOut != "" {
				return "", false, fmt.Errorf("zenity failed: %s (%w)", errOut, runErr)
			}
			return "", false, runErr
		}
		selected := normalizeSelectedUnixPath(stdout)
		if selected == "" {
			return "", true, nil
		}
		return selected, false, nil
	}

	if kdialogPath, err := exec.LookPath("kdialog"); err == nil {
		args := []string{"--title", "Select Workspace Folder", "--getexistingdirectory"}
		if initialDir != "" {
			args = append(args, initialDir)
		}
		stdout, stderr, exitCode, runErr := runUnixDialogCommand(ctx, kdialogPath, args...)
		if runErr != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return "", true, ctxErr
			}
			if exitCode == 1 {
				return "", true, nil
			}
			errOut := strings.TrimSpace(stderr)
			if errOut != "" {
				return "", false, fmt.Errorf("kdialog failed: %s (%w)", errOut, runErr)
			}
			return "", false, runErr
		}
		selected := normalizeSelectedUnixPath(stdout)
		if selected == "" {
			return "", true, nil
		}
		return selected, false, nil
	}

	return "", false, errPickerUnavailable
}
