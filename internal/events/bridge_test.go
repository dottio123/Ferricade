package events_test

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/events"
)

// resolver knows the devices in ids, fails for "boom", and counts lookups.
type resolver struct {
	ids   map[string]string
	calls atomic.Int32
}

func (r *resolver) resolve(_ context.Context, rustdeskID string) (string, bool, error) {
	r.calls.Add(1)
	if rustdeskID == "boom" {
		return "", false, errors.New("database down")
	}
	id, ok := r.ids[rustdeskID]
	return id, ok, nil
}

// runBridge runs b until the test ends.
func runBridge(t *testing.T, b *events.TrackerBridge, r *resolver, logs *syncBuffer) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		b.Run(ctx, r.resolve, slog.New(slog.NewJSONHandler(logs, nil)))
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
}

func TestBridgePublishesOnlineAndOffline(t *testing.T) {
	hub := events.NewHub()
	ch, unsub := hub.Subscribe("")
	t.Cleanup(unsub)
	b := events.NewTrackerBridge(hub, 16)
	r := &resolver{ids: map[string]string{"111": "d1"}}
	runBridge(t, b, r, &syncBuffer{})

	b.OnChange("111", true)
	b.OnChange("111", false)
	assert.Equal(t, events.Event{Type: events.TypeDeviceOnline, DeviceID: "d1"}, recv(t, ch))
	assert.Equal(t, events.Event{Type: events.TypeDeviceOffline, DeviceID: "d1"}, recv(t, ch))
	assert.Equal(t, int32(1), r.calls.Load(), "the device ID is looked up once and cached")
}

func TestBridgeSkipsUnknownAndFailedLookups(t *testing.T) {
	hub := events.NewHub()
	ch, unsub := hub.Subscribe("")
	t.Cleanup(unsub)
	b := events.NewTrackerBridge(hub, 16)
	r := &resolver{ids: map[string]string{"111": "d1"}}
	var logs syncBuffer
	runBridge(t, b, r, &logs)

	b.OnChange("999", true)  // no such device
	b.OnChange("boom", true) // lookup fails
	b.OnChange("111", true)
	assert.Equal(t, events.Event{Type: events.TypeDeviceOnline, DeviceID: "d1"}, recv(t, ch),
		"unknown and unresolvable devices publish nothing")
	assert.Contains(t, logs.String(), "database down", "a failed lookup is logged")
}

func TestBridgeDropsWhenFullWithoutBlocking(t *testing.T) {
	hub := events.NewHub()
	ch, unsub := hub.Subscribe("")
	t.Cleanup(unsub)
	b := events.NewTrackerBridge(hub, 2)
	r := &resolver{ids: map[string]string{"111": "d1", "222": "d2", "333": "d3"}}

	b.OnChange("111", true)
	b.OnChange("222", true)
	returned := make(chan struct{})
	go func() {
		b.OnChange("333", true) // the queue is full
		close(returned)
	}()
	select {
	case <-returned:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("OnChange blocked on a full queue")
	}

	var logs syncBuffer
	runBridge(t, b, r, &logs)
	assert.Equal(t, "d1", recv(t, ch).DeviceID)
	assert.Equal(t, "d2", recv(t, ch).DeviceID)
	select {
	case e := <-ch:
		t.Fatalf("the dropped change was published: %+v", e)
	case <-time.After(100 * time.Millisecond):
	}
	var warned bool
	for line := range strings.Lines(logs.String()) {
		if strings.Contains(line, `"level":"WARN"`) && strings.Contains(line, `"dropped":1`) {
			warned = true
		}
	}
	require.True(t, warned, "the drop is logged at WARN: %s", logs.String())
}
