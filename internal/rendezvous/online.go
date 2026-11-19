package rendezvous

import (
	"context"
	"errors"
	"fmt"
	"net"
	"time"

	"google.golang.org/protobuf/encoding/protowire"
)

// Field numbers from hbb_common/protos/rendezvous.proto. Two messages do not
// justify a protoc toolchain yet; switch to generated code when more are needed.
const (
	fieldOnlineRequest  protowire.Number = 23 // RendezvousMessage.online_request
	fieldOnlineResponse protowire.Number = 24 // RendezvousMessage.online_response
	fieldPeers          protowire.Number = 2  // OnlineRequest.peers
	fieldStates         protowire.Number = 1  // OnlineResponse.states
)

const maxResponse = 1 << 20

// EncodeOnlineRequest builds RendezvousMessage{online_request: {peers: ids}}.
// OnlineRequest.id (the asker's own ID) is left empty; hbbs does not read it.
func EncodeOnlineRequest(ids []string) []byte {
	var inner []byte
	for _, id := range ids {
		inner = protowire.AppendTag(inner, fieldPeers, protowire.BytesType)
		inner = protowire.AppendString(inner, id)
	}
	msg := protowire.AppendTag(nil, fieldOnlineRequest, protowire.BytesType)
	return protowire.AppendBytes(msg, inner)
}

// DecodeOnlineResponse maps ids to their bit in the response. Bit i is
// states[i/8] & (1 << (7 - i%8)); ids beyond the returned bits are offline.
func DecodeOnlineResponse(msg []byte, ids []string) (map[string]bool, error) {
	resp, ok, err := bytesField(msg, fieldOnlineResponse)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("rendezvous: reply is not an OnlineResponse")
	}
	states, _, err := bytesField(resp, fieldStates)
	if err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(ids))
	for i, id := range ids {
		b := i / 8
		out[id] = b < len(states) && states[b]&(1<<(7-i%8)) != 0
	}
	return out, nil
}

// QueryOnline asks hbbs (its NAT-test port, 21115 by default) which ids
// registered within the last 30 seconds. hbbs needs no key for this, but
// addr must not be loopback: hbbs answers loopback peers on that port as a
// plain-text admin console and closes without a reply.
func QueryOnline(ctx context.Context, addr string, ids []string) (map[string]bool, error) {
	if len(ids) == 0 {
		return map[string]bool{}, nil
	}
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	// Close the connection when ctx ends, so a silent hbbs cannot block us.
	stop := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Unix(1, 0)) })
	defer stop()
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}

	if err := WriteFrame(conn, EncodeOnlineRequest(ids)); err != nil {
		return nil, ctxErr(ctx, err)
	}
	msg, err := ReadFrame(conn, maxResponse)
	if err != nil {
		return nil, ctxErr(ctx, err)
	}
	return DecodeOnlineResponse(msg, ids)
}

func ctxErr(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return fmt.Errorf("rendezvous: %w", ctx.Err())
	}
	// The conn deadline equals ctx's and can fire a moment before ctx.Err is set.
	var ne net.Error
	if dl, ok := ctx.Deadline(); ok && errors.As(err, &ne) && ne.Timeout() && !time.Now().Before(dl) {
		return fmt.Errorf("rendezvous: %w", context.DeadlineExceeded)
	}
	return err
}

// bytesField returns the last length-delimited field num at the top level of b.
func bytesField(b []byte, num protowire.Number) ([]byte, bool, error) {
	var out []byte
	found := false
	for len(b) > 0 {
		n, typ, l := protowire.ConsumeTag(b)
		if l < 0 {
			return nil, false, protowire.ParseError(l)
		}
		b = b[l:]
		vl := protowire.ConsumeFieldValue(n, typ, b)
		if vl < 0 {
			return nil, false, protowire.ParseError(vl)
		}
		if n == num && typ == protowire.BytesType {
			out, _ = protowire.ConsumeBytes(b)
			found = true
		}
		b = b[vl:]
	}
	return out, found, nil
}
