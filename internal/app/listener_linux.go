//go:build linux

package app

import (
	"syscall"

	"golang.org/x/sys/unix"
)

func adminSocketControl(_, _ string, raw syscall.RawConn) error {
	var setErr error
	if err := raw.Control(func(fd uintptr) {
		setErr = unix.SetsockoptInt(int(fd), unix.IPPROTO_TCP, unix.TCP_USER_TIMEOUT, 60000)
	}); err != nil {
		return err
	}
	return setErr
}
