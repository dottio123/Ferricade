package sessions

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestCursorEncodingCompatibility(t *testing.T) {
	got := encodeCursor(time.UnixMicro(0), uuid.MustParse("00000000-0000-0000-0000-000000000001"))
	require.Equal(t, "MC4wMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDE", got)
}
