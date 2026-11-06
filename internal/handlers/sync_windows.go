package handlers

import (
	"syscall"
)

func hiddenWindowSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}
