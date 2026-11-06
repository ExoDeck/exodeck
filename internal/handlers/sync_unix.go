//go:build !windows

package handlers

import (
	"syscall"
)

func hiddenWindowSysProcAttr() *syscall.SysProcAttr {
	return nil
}
