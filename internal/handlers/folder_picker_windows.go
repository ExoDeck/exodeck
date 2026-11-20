//go:build windows

package handlers

import (
	"context"
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	coinitApartmentThreaded = 0x2
	coinitDisableOle1DDE    = 0x4
	clsctxInprocServer      = 0x1

	fosPickFolders     uint32 = 0x00000020
	fosForceFilesystem uint32 = 0x00000040
	fosPathMustExist   uint32 = 0x00000800
	sigdnFileSysPath   uint32 = 0x80058000

	hrCancelled     uint32 = 0x800704C7
	rpcEChangedMode uint32 = 0x80010106

	wsExTopmost uint32 = 0x00000008
	wsPopup     uint32 = 0x80000000
)

var (
	ole32DLL   = windows.NewLazySystemDLL("ole32.dll")
	shell32DLL = windows.NewLazySystemDLL("shell32.dll")
	user32DLL  = windows.NewLazySystemDLL("user32.dll")

	procCoInitializeEx              = ole32DLL.NewProc("CoInitializeEx")
	procCoUninitialize              = ole32DLL.NewProc("CoUninitialize")
	procCoCreateInstance            = ole32DLL.NewProc("CoCreateInstance")
	procCoTaskMemFree               = ole32DLL.NewProc("CoTaskMemFree")
	procSHCreateItemFromParsingName = shell32DLL.NewProc("SHCreateItemFromParsingName")
	procGetForegroundWindow         = user32DLL.NewProc("GetForegroundWindow")
	procGetWindowRect               = user32DLL.NewProc("GetWindowRect")
	procCreateWindowExW             = user32DLL.NewProc("CreateWindowExW")
	procDestroyWindow               = user32DLL.NewProc("DestroyWindow")

	clsidFileOpenDialog = windows.GUID{
		Data1: 0xDC1C5A9C,
		Data2: 0xE88A,
		Data3: 0x4DDE,
		Data4: [8]byte{0xA5, 0xA1, 0x60, 0xF8, 0x2A, 0x20, 0xAE, 0xF7},
	}
	iidIFileDialog = windows.GUID{
		Data1: 0x42F85136,
		Data2: 0xDB7E,
		Data3: 0x439C,
		Data4: [8]byte{0x85, 0xF1, 0xE4, 0x07, 0x5D, 0x13, 0x5F, 0xC8},
	}
	iidIShellItem = windows.GUID{
		Data1: 0x43826D1E,
		Data2: 0xE718,
		Data3: 0x42EE,
		Data4: [8]byte{0xBC, 0x55, 0xA1, 0xE2, 0x61, 0xC3, 0x7B, 0xFE},
	}
)

type iFileDialogVtbl struct {
	_          [2]uintptr // QueryInterface, AddRef
	release    uintptr
	show       uintptr
	_          [5]uintptr // SetFileTypes..Unadvise
	setOptions uintptr
	getOptions uintptr
	_          uintptr // SetDefaultFolder
	setFolder  uintptr
	_          [4]uintptr // GetFolder..GetFileName
	setTitle   uintptr
	_          [2]uintptr // SetOkButtonLabel, SetFileNameLabel
	getResult  uintptr
}

type iFileDialog struct {
	vtbl *iFileDialogVtbl
}

type iShellItemVtbl struct {
	_              [2]uintptr // QueryInterface, AddRef
	release        uintptr
	_              [2]uintptr // BindToHandler, GetParent
	getDisplayName uintptr
}

type iShellItem struct {
	vtbl *iShellItemVtbl
}

type winRect struct {
	Left   int32
	Top    int32
	Right  int32
	Bottom int32
}

type pickerResult struct {
	path      string
	cancelled bool
	err       error
}

func hresultFailed(hr uintptr) bool {
	return int32(uint32(hr)) < 0
}

func createTopmostOwnerWindow() uintptr {
	className, err := windows.UTF16PtrFromString("STATIC")
	if err != nil {
		return 0
	}

	var x, y int32
	if fg, _, _ := procGetForegroundWindow.Call(); fg != 0 {
		var rect winRect
		if ok, _, _ := procGetWindowRect.Call(fg, uintptr(unsafe.Pointer(&rect))); ok != 0 {
			x = (rect.Left + rect.Right) / 2
			y = (rect.Top + rect.Bottom) / 2
		}
	}

	hwnd, _, _ := procCreateWindowExW.Call(
		uintptr(wsExTopmost),
		uintptr(unsafe.Pointer(className)),
		0,
		uintptr(wsPopup),
		uintptr(x),
		uintptr(y),
		0,
		0,
		0,
		0,
		0,
		0,
	)
	return hwnd
}

func pickFolderNative(ctx context.Context, initialDir string) (string, bool, error) {
	if err := ctx.Err(); err != nil {
		return "", true, err
	}

	done := make(chan pickerResult, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		done <- pickFolderWindowsSTA(initialDir)
	}()

	res := <-done
	return res.path, res.cancelled, res.err
}

func pickFolderWindowsSTA(initialDir string) pickerResult {
	hr, _, _ := procCoInitializeEx.Call(0, uintptr(coinitApartmentThreaded|coinitDisableOle1DDE))
	hr32 := uint32(hr)
	if int32(hr32) < 0 && hr32 != rpcEChangedMode {
		return pickerResult{err: fmt.Errorf("CoInitializeEx failed: 0x%08x", hr32)}
	}
	if hr32 != rpcEChangedMode {
		defer func() {
			_, _, _ = procCoUninitialize.Call()
		}()
	}

	var dialog *iFileDialog
	hr, _, _ = procCoCreateInstance.Call(
		uintptr(unsafe.Pointer(&clsidFileOpenDialog)),
		0,
		uintptr(clsctxInprocServer),
		uintptr(unsafe.Pointer(&iidIFileDialog)),
		uintptr(unsafe.Pointer(&dialog)),
	)
	if hresultFailed(hr) || dialog == nil {
		return pickerResult{err: fmt.Errorf("CoCreateInstance(IFileOpenDialog) failed: 0x%08x", uint32(hr))}
	}
	defer func() {
		_, _, _ = syscall.SyscallN(dialog.vtbl.release, uintptr(unsafe.Pointer(dialog)))
	}()

	var opts uint32
	hr, _, _ = syscall.SyscallN(dialog.vtbl.getOptions, uintptr(unsafe.Pointer(dialog)), uintptr(unsafe.Pointer(&opts)))
	if hresultFailed(hr) {
		return pickerResult{err: fmt.Errorf("IFileDialog::GetOptions failed: 0x%08x", uint32(hr))}
	}

	opts |= fosPickFolders | fosForceFilesystem | fosPathMustExist
	hr, _, _ = syscall.SyscallN(dialog.vtbl.setOptions, uintptr(unsafe.Pointer(dialog)), uintptr(opts))
	if hresultFailed(hr) {
		return pickerResult{err: fmt.Errorf("IFileDialog::SetOptions failed: 0x%08x", uint32(hr))}
	}

	if titlePtr, err := windows.UTF16PtrFromString("Select Workspace Folder"); err == nil {
		_, _, _ = syscall.SyscallN(dialog.vtbl.setTitle, uintptr(unsafe.Pointer(dialog)), uintptr(unsafe.Pointer(titlePtr)))
		runtime.KeepAlive(titlePtr)
	}

	if initialDir != "" {
		if dirPtr, err := windows.UTF16PtrFromString(initialDir); err == nil {
			var folderItem *iShellItem
			hr, _, _ = procSHCreateItemFromParsingName.Call(
				uintptr(unsafe.Pointer(dirPtr)),
				0,
				uintptr(unsafe.Pointer(&iidIShellItem)),
				uintptr(unsafe.Pointer(&folderItem)),
			)
			runtime.KeepAlive(dirPtr)
			if !hresultFailed(hr) && folderItem != nil {
				_, _, _ = syscall.SyscallN(dialog.vtbl.setFolder, uintptr(unsafe.Pointer(dialog)), uintptr(unsafe.Pointer(folderItem)))
				_, _, _ = syscall.SyscallN(folderItem.vtbl.release, uintptr(unsafe.Pointer(folderItem)))
			}
		}
	}

	ownerHwnd := createTopmostOwnerWindow()
	if ownerHwnd != 0 {
		defer func() {
			_, _, _ = procDestroyWindow.Call(ownerHwnd)
		}()
	}

	hr, _, _ = syscall.SyscallN(dialog.vtbl.show, uintptr(unsafe.Pointer(dialog)), ownerHwnd)
	if uint32(hr) == hrCancelled {
		return pickerResult{cancelled: true}
	}
	if hresultFailed(hr) {
		return pickerResult{err: fmt.Errorf("IFileDialog::Show failed: 0x%08x", uint32(hr))}
	}

	var item *iShellItem
	hr, _, _ = syscall.SyscallN(dialog.vtbl.getResult, uintptr(unsafe.Pointer(dialog)), uintptr(unsafe.Pointer(&item)))
	if hresultFailed(hr) || item == nil {
		return pickerResult{err: fmt.Errorf("IFileDialog::GetResult failed: 0x%08x", uint32(hr))}
	}
	defer func() {
		_, _, _ = syscall.SyscallN(item.vtbl.release, uintptr(unsafe.Pointer(item)))
	}()

	var pathPtr *uint16
	hr, _, _ = syscall.SyscallN(
		item.vtbl.getDisplayName,
		uintptr(unsafe.Pointer(item)),
		uintptr(sigdnFileSysPath),
		uintptr(unsafe.Pointer(&pathPtr)),
	)
	if hresultFailed(hr) || pathPtr == nil {
		return pickerResult{err: fmt.Errorf("IShellItem::GetDisplayName failed: 0x%08x", uint32(hr))}
	}
	defer func() {
		_, _, _ = procCoTaskMemFree.Call(uintptr(unsafe.Pointer(pathPtr)))
	}()

	return pickerResult{path: windows.UTF16PtrToString(pathPtr)}
}
