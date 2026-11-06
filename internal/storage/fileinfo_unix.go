//go:build !windows

package storage

import (
	"io/fs"
	"time"
)

// getFileTimes returns the creation and modification times of a file.
// On Unix systems without cgo, birthtime isn't cleanly available, so it falls back to ModTime.
func getFileTimes(info fs.FileInfo) (time.Time, time.Time) {
	return info.ModTime(), info.ModTime()
}
