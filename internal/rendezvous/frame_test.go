package rendezvous_test

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/rendezvous"
)

func TestFrameBoundaries(t *testing.T) {
	cases := []struct{ n, head int }{
		{0, 1}, {63, 1}, {64, 2}, {16383, 2}, {16384, 3}, {4194303, 3}, {4194304, 4},
	}
	for _, c := range cases {
		p := bytes.Repeat([]byte{0xAB}, c.n)
		var buf bytes.Buffer
		require.NoError(t, rendezvous.WriteFrame(&buf, p))
		assert.Equal(t, c.n+c.head, buf.Len(), "len %d", c.n)
		got, err := rendezvous.ReadFrame(&buf, 1<<23)
		require.NoError(t, err, "len %d", c.n)
		assert.Equal(t, c.n, len(got))
		assert.Equal(t, p, got)
	}
}

func TestFrameHeaderBytes(t *testing.T) {
	var buf bytes.Buffer
	require.NoError(t, rendezvous.WriteFrame(&buf, make([]byte, 64)))
	// 64<<2 | 1 = 0x101, little endian.
	assert.Equal(t, []byte{0x01, 0x01}, buf.Bytes()[:2])
}

func TestReadFrameRejectsOversize(t *testing.T) {
	n := uint32(1<<29)<<2 | 3
	hdr := []byte{byte(n), byte(n >> 8), byte(n >> 16), byte(n >> 24)}
	_, err := rendezvous.ReadFrame(bytes.NewReader(hdr), 1<<20)
	require.Error(t, err)
}

func TestWriteFrameRejectsTooLarge(t *testing.T) {
	err := rendezvous.WriteFrame(&bytes.Buffer{}, make([]byte, 0x40000000))
	require.Error(t, err)
}

func TestReadFrameTruncated(t *testing.T) {
	_, err := rendezvous.ReadFrame(bytes.NewReader([]byte{10 << 2, 1, 2}), 1<<20)
	require.Error(t, err)
}
