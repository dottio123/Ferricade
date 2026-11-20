package rendezvous_test

import (
	"context"
	"errors"
	"io"
	"net"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/encoding/protowire"

	"github.com/dottio123/ferricade/internal/rendezvous"
)

// field returns the bytes of the first length-delimited field num in b.
func field(t *testing.T, b []byte, num protowire.Number) [][]byte {
	t.Helper()
	var out [][]byte
	for len(b) > 0 {
		n, typ, l := protowire.ConsumeTag(b)
		require.GreaterOrEqual(t, l, 0)
		b = b[l:]
		vl := protowire.ConsumeFieldValue(n, typ, b)
		require.GreaterOrEqual(t, vl, 0)
		if n == num && typ == protowire.BytesType {
			v, _ := protowire.ConsumeBytes(b)
			out = append(out, v)
		}
		b = b[vl:]
	}
	return out
}

func TestEncodeOnlineRequest(t *testing.T) {
	msg := rendezvous.EncodeOnlineRequest([]string{"a", "b"})
	req := field(t, msg, 23)
	require.Len(t, req, 1)
	peers := field(t, req[0], 2)
	require.Len(t, peers, 2)
	assert.Equal(t, "a", string(peers[0]))
	assert.Equal(t, "b", string(peers[1]))
}

func onlineResponse(states []byte) []byte {
	inner := protowire.AppendTag(nil, 1, protowire.BytesType)
	inner = protowire.AppendBytes(inner, states)
	msg := protowire.AppendTag(nil, 24, protowire.BytesType)
	return protowire.AppendBytes(msg, inner)
}

func TestDecodeOnlineResponseNineIDs(t *testing.T) {
	ids := []string{"0", "1", "2", "3", "4", "5", "6", "7", "8"}
	got, err := rendezvous.DecodeOnlineResponse(onlineResponse([]byte{0b10100000, 0b10000000}), ids)
	require.NoError(t, err)
	want := map[string]bool{"0": true, "1": false, "2": true, "3": false, "4": false, "5": false, "6": false, "7": false, "8": true}
	assert.Equal(t, want, got)
}

func TestDecodeOnlineResponseShortStates(t *testing.T) {
	got, err := rendezvous.DecodeOnlineResponse(onlineResponse([]byte{0x80}), []string{"a", "b", "c", "d", "e", "f", "g", "h", "i"})
	require.NoError(t, err)
	assert.True(t, got["a"])
	assert.False(t, got["i"])
	assert.Len(t, got, 9)
}

func TestDecodeOnlineResponseWrongMessage(t *testing.T) {
	_, err := rendezvous.DecodeOnlineResponse(rendezvous.EncodeOnlineRequest([]string{"a"}), []string{"a"})
	require.Error(t, err)
}

func fakeHBBS(t *testing.T, serve func(net.Conn)) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); serve(c) }()
		}
	}()
	return ln.Addr().String()
}

func TestQueryOnlineAgainstFakeHBBS(t *testing.T) {
	addr := fakeHBBS(t, func(c net.Conn) {
		req, err := rendezvous.ReadFrame(c, 1<<20)
		if err != nil || len(req) == 0 {
			return
		}
		_ = rendezvous.WriteFrame(c, onlineResponse([]byte{0x80}))
	})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	got, err := rendezvous.QueryOnline(ctx, addr, []string{"x"})
	require.NoError(t, err)
	assert.Equal(t, map[string]bool{"x": true}, got)
}

func TestQueryOnlineTimeout(t *testing.T) {
	addr := fakeHBBS(t, func(c net.Conn) { _, _ = io.Copy(io.Discard, c) }) // accept, never answer
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := rendezvous.QueryOnline(ctx, addr, []string{"x"})
	require.Error(t, err)
	assert.True(t, errors.Is(err, context.DeadlineExceeded), "got %v", err)
	assert.Less(t, time.Since(start), time.Second)
}

func TestQueryOnlineEmpty(t *testing.T) {
	got, err := rendezvous.QueryOnline(context.Background(), "127.0.0.1:1", nil)
	require.NoError(t, err)
	assert.Empty(t, got)
}
