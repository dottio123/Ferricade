// Package rendezvous talks to hbbs, the RustDesk ID server.
package rendezvous

import (
	"errors"
	"fmt"
	"io"
)

// MaxFrame is the largest payload hbb_common's BytesCodec can describe.
const MaxFrame = 0x3FFFFFFF

// WriteFrame writes p with hbb_common's BytesCodec header: 1 to 4
// little-endian bytes holding len<<2 | (headerLen-1).
func WriteFrame(w io.Writer, p []byte) error {
	n := len(p)
	var hdr []byte
	switch {
	case n <= 0x3F:
		hdr = []byte{byte(n << 2)}
	case n <= 0x3FFF:
		v := n<<2 | 1
		hdr = []byte{byte(v), byte(v >> 8)}
	case n <= 0x3FFFFF:
		v := n<<2 | 2
		hdr = []byte{byte(v), byte(v >> 8), byte(v >> 16)}
	case n <= MaxFrame:
		v := uint32(n)<<2 | 3
		hdr = []byte{byte(v), byte(v >> 8), byte(v >> 16), byte(v >> 24)}
	default:
		return fmt.Errorf("frame too large: %d bytes", n)
	}
	if _, err := w.Write(append(hdr, p...)); err != nil {
		return err
	}
	return nil
}

// ReadFrame reads one frame, refusing payloads larger than max before
// allocating them.
func ReadFrame(r io.Reader, max int) ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:1]); err != nil {
		return nil, err
	}
	headLen := int(hdr[0]&3) + 1
	if headLen > 1 {
		if _, err := io.ReadFull(r, hdr[1:headLen]); err != nil {
			return nil, unexpectedEOF(err)
		}
	}
	var v uint32
	for i := headLen - 1; i >= 0; i-- {
		v = v<<8 | uint32(hdr[i])
	}
	n := int(v >> 2)
	if n > max {
		return nil, fmt.Errorf("frame of %d bytes exceeds limit %d", n, max)
	}
	p := make([]byte, n)
	if _, err := io.ReadFull(r, p); err != nil {
		return nil, unexpectedEOF(err)
	}
	return p, nil
}

func unexpectedEOF(err error) error {
	if errors.Is(err, io.EOF) {
		return io.ErrUnexpectedEOF
	}
	return err
}
