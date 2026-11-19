package app

import (
	"context"
	"net"
	"time"
)

// adminListen ensures dead SSE peers stop holding sessions after a failed write.
func adminListen(addr string) (net.Listener, error) {
	lc := net.ListenConfig{KeepAlive: 30 * time.Second, Control: adminSocketControl}
	return lc.Listen(context.Background(), "tcp", addr)
}
