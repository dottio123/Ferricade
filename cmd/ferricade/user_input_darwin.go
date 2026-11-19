//go:build darwin

package main

import (
	"errors"
	"io"
	"os"

	"golang.org/x/sys/unix"
)

func disableEcho(input io.Reader) (func(), bool, error) {
	f, ok := input.(*os.File)
	if !ok {
		return nil, false, nil
	}
	fd := int(f.Fd())
	old, err := unix.IoctlGetTermios(fd, unix.TIOCGETA)
	if errors.Is(err, unix.ENOTTY) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	quiet := *old
	quiet.Lflag &^= unix.ECHO
	if err := unix.IoctlSetTermios(fd, unix.TIOCSETA, &quiet); err != nil {
		return nil, false, err
	}
	return func() { _ = unix.IoctlSetTermios(fd, unix.TIOCSETA, old) }, true, nil
}
