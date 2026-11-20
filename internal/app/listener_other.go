//go:build !linux

package app

import "syscall"

func adminSocketControl(_, _ string, _ syscall.RawConn) error { return nil }
