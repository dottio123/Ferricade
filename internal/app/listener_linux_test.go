//go:build linux

package app

import (
	"net"
	"testing"

	"github.com/stretchr/testify/require"
	"golang.org/x/sys/unix"
)

func TestAdminListenerKeepaliveAndUserTimeout(t *testing.T) {
	ln, err := adminListen("127.0.0.1:0")
	require.NoError(t, err)
	defer ln.Close()
	peer, err := net.Dial("tcp", ln.Addr().String())
	require.NoError(t, err)
	defer peer.Close()
	conn, err := ln.Accept()
	require.NoError(t, err)
	defer conn.Close()
	raw, err := conn.(*net.TCPConn).SyscallConn()
	require.NoError(t, err)
	require.NoError(t, raw.Control(func(fd uintptr) {
		keep, e := unix.GetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_KEEPALIVE)
		require.NoError(t, e)
		require.Equal(t, 1, keep)
		idle, e := unix.GetsockoptInt(int(fd), unix.IPPROTO_TCP, unix.TCP_KEEPIDLE)
		require.NoError(t, e)
		require.Equal(t, 30, idle)
		timeout, e := unix.GetsockoptInt(int(fd), unix.IPPROTO_TCP, unix.TCP_USER_TIMEOUT)
		require.NoError(t, e)
		require.Equal(t, 60000, timeout)
	}))
}
