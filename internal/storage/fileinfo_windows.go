//go:build windows

package storage

import (
	"io/fs"
	"syscall"
	"time"
)

// getFileTimes returns the creation and modification times of a file.
// On Windows, it extracts the actual CreationTime from Win32FileAttributeData.
func getFileTimes(info fs.FileInfo) (time.Time, time.Time) {
	modTime := info.ModTime()
	createTime := modTime
	if sys, ok := info.Sys().(*syscall.Win32FileAttributeData); ok {
		createTime = time.Unix(0, sys.CreationTime.Nanoseconds())
	}
	return createTime, modTime
}
