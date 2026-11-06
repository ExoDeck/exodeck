package main

import (
	"os"

	"golang.org/x/sys/windows"
)

func init() {
	// Enable Virtual Terminal Processing for standard output on Windows
	// This ensures that ANSI escape codes (colors/formatting) printed
	// to stdout/stderr are rendered properly in the Windows console.

	stdout := windows.Handle(os.Stdout.Fd())
	var modeStdout uint32
	if err := windows.GetConsoleMode(stdout, &modeStdout); err == nil {
		modeStdout |= windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING
		_ = windows.SetConsoleMode(stdout, modeStdout)
	}

	stderr := windows.Handle(os.Stderr.Fd())
	var modeStderr uint32
	if err := windows.GetConsoleMode(stderr, &modeStderr); err == nil {
		modeStderr |= windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING
		_ = windows.SetConsoleMode(stderr, modeStderr)
	}
}
