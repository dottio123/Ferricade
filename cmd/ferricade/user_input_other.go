//go:build !linux && !windows && !darwin

package main

import "io"

func disableEcho(io.Reader) (func(), bool, error) { return nil, false, nil }
