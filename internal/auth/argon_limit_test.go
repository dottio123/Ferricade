package auth

import (
	"context"
	"runtime"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestArgonLimitDefaults(t *testing.T) {
	g := argonGate.Load()
	require.Equal(t, max(2, runtime.NumCPU()), cap(g.slots))
	require.Equal(t, 2*time.Second, g.wait)
}

// With one slot held, every Argon2id computation waits for it and gives up
// with ErrBusy after the wait, or at once when its context ends.
func TestArgonLimitBoundsConcurrentHashes(t *testing.T) {
	ctx := context.Background()
	enc, err := HashPassword(ctx, "pw", TestParams)
	require.NoError(t, err)

	defer SetArgonLimit(1, 50*time.Millisecond)()
	release, err := AcquireArgonSlot(ctx)
	require.NoError(t, err)

	start := time.Now()
	_, err = VerifyPassword(ctx, enc, "pw")
	require.ErrorIs(t, err, ErrBusy)
	require.GreaterOrEqual(t, time.Since(start), 50*time.Millisecond, "it waited for the slot")
	_, err = HashPassword(ctx, "pw", TestParams)
	require.ErrorIs(t, err, ErrBusy)

	cctx, cancel := context.WithCancel(ctx)
	cancel()
	_, err = VerifyPassword(cctx, enc, "pw")
	require.ErrorIs(t, err, ErrBusy, "an ended context does not wait")

	// A slot freed while waiting is taken.
	defer SetArgonLimit(1, 5*time.Second)()
	release, err = AcquireArgonSlot(ctx)
	require.NoError(t, err)
	go func() {
		time.Sleep(30 * time.Millisecond)
		release()
	}()
	ok, err := VerifyPassword(ctx, enc, "pw")
	require.NoError(t, err)
	require.True(t, ok)

	// Each computation returned its slot.
	release, err = AcquireArgonSlot(ctx)
	require.NoError(t, err)
	release()
}

func TestArgonLimitReleaseIsIdempotent(t *testing.T) {
	defer SetArgonLimit(1, 10*time.Millisecond)()
	release, err := AcquireArgonSlot(context.Background())
	require.NoError(t, err)
	release()
	release()
	r2, err := AcquireArgonSlot(context.Background())
	require.NoError(t, err)
	_, err = AcquireArgonSlot(context.Background())
	require.ErrorIs(t, err, ErrBusy, "a double release must not free a second slot")
	r2()
}
