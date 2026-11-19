package auth

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// ErrBusy is returned by HashPassword, VerifyPassword and Login when no
// Argon2id slot frees up in time. Nothing was verified or counted; the
// caller should answer "busy, retry" (503).
var ErrBusy = errors.New("auth: server busy")

// DefaultArgonWait is how long an Argon2id computation waits for a slot.
const DefaultArgonWait = 2 * time.Second

// argonLimit is a process-wide semaphore around every Argon2id computation.
// Each one allocates the hash's memory (64 MiB with DefaultParams), so
// without a cap a burst of logins could exhaust memory.
type argonLimit struct {
	slots chan struct{}
	wait  time.Duration
}

var argonGate atomic.Pointer[argonLimit]

func init() { argonGate.Store(newArgonLimit(max(2, runtime.NumCPU()), DefaultArgonWait)) }

func newArgonLimit(capacity int, wait time.Duration) *argonLimit {
	return &argonLimit{slots: make(chan struct{}, capacity), wait: wait}
}

// SetArgonLimit replaces the semaphore with one of capacity slots whose
// waits give up after wait, and returns a function that restores the
// previous one. It is meant for tests; slots taken before the call are
// returned to the semaphore they came from.
func SetArgonLimit(capacity int, wait time.Duration) (restore func()) {
	prev := argonGate.Swap(newArgonLimit(max(1, capacity), wait))
	return func() { argonGate.Store(prev) }
}

// AcquireArgonSlot takes one Argon2id slot, waiting up to the configured
// wait (2 s by default) or until ctx ends, and then returns ErrBusy. The
// returned release frees the slot; calling it more than once is harmless.
func AcquireArgonSlot(ctx context.Context) (release func(), err error) {
	return acquireArgonSlot(ctx, true)
}

// acquireArgonSlot is AcquireArgonSlot; with bounded false it waits for a
// slot until ctx ends, however long that takes.
func acquireArgonSlot(ctx context.Context, bounded bool) (release func(), err error) {
	g := argonGate.Load()
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrBusy, err)
	}
	var timeout <-chan time.Time
	if bounded {
		t := time.NewTimer(g.wait)
		defer t.Stop()
		timeout = t.C
	}
	select {
	case g.slots <- struct{}{}:
	case <-timeout:
		return nil, ErrBusy
	case <-ctx.Done():
		return nil, fmt.Errorf("%w: %w", ErrBusy, ctx.Err())
	}
	var once sync.Once
	return func() { once.Do(func() { <-g.slots }) }, nil
}
