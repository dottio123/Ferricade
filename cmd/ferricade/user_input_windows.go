//go:build windows

package main

import (
	"io"
	"os"

	"golang.org/x/sys/windows"
)

func disableEcho(input io.Reader) (func(), bool, error) {
	f, ok := input.(*os.File)
	if !ok {
		return nil, false, nil
	}
	h := windows.Handle(f.Fd())
	var old uint32
	if err := windows.GetConsoleMode(h, &old); err != nil {
		return nil, false, nil
	}
	if err := windows.SetConsoleMode(h, old&^windows.ENABLE_ECHO_INPUT); err != nil {
		return nil, false, err
	}
	return func() { _ = windows.SetConsoleMode(h, old) }, true, nil
}
