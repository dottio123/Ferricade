package events

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"
)

// Bridge limits.
const (
	// bridgeCacheSize bounds the rustdesk_id to device ID cache; when full it
	// is emptied and refilled.
	bridgeCacheSize = 10000
	// dropWarnEvery is the most often dropped changes are logged.
	dropWarnEvery = time.Minute
)

// Resolver returns the device ID of rustdeskID, with ok false when there is
// no such device.
type Resolver func(ctx context.Context, rustdeskID string) (deviceID string, ok bool, err error)

// onlineChange is one transition reported by the online tracker.
type onlineChange struct {
	rustdeskID string
	online     bool
}

// TrackerBridge publishes the online tracker's transitions as device.online
// and device.offline events. The tracker knows devices by rustdesk_id and
// calls back with a lock held that heartbeats wait on, so OnChange only queues
// the change; Run resolves the device ID and publishes it.
type TrackerBridge struct {
	hub     *Hub
	queue   chan onlineChange
	dropped atomic.Int64 // changes dropped because the queue was full
}

// NewTrackerBridge returns a bridge to hub that queues up to size changes.
func NewTrackerBridge(hub *Hub, size int) *TrackerBridge {
	return &TrackerBridge{hub: hub, queue: make(chan onlineChange, size)}
}

// OnChange queues a transition; it matches devices.Tracker.OnChange. It never
// blocks: when the queue is full the change is dropped and counted, and Run
// logs the count.
func (b *TrackerBridge) OnChange(rustdeskID string, online bool) {
	select {
	case b.queue <- onlineChange{rustdeskID: rustdeskID, online: online}:
	default:
		b.dropped.Add(1)
	}
}

// Run publishes the queued changes until ctx ends. It resolves each
// rustdesk_id once and caches the ID, which never changes for a device. A
// change whose device is unknown, or whose lookup fails, is skipped. Dropped
// changes are logged at WARN, at most once a minute.
func (b *TrackerBridge) Run(ctx context.Context, resolve Resolver, log *slog.Logger) {
	ids := map[string]string{}
	var lastWarn time.Time
	for {
		var c onlineChange
		select {
		case <-ctx.Done():
			return
		case c = <-b.queue:
		}
		if time.Since(lastWarn) >= dropWarnEvery {
			if n := b.dropped.Swap(0); n > 0 {
				log.Warn("online events: queue full, changes dropped", "dropped", n)
				lastWarn = time.Now()
			}
		}
		id, ok := ids[c.rustdeskID]
		if !ok {
			got, found, err := resolve(ctx, c.rustdeskID)
			if err != nil {
				if ctx.Err() == nil {
					log.Error("online events: look up device", "rustdesk_id", c.rustdeskID, "err", err)
				}
				continue
			}
			if !found {
				continue
			}
			if len(ids) >= bridgeCacheSize {
				clear(ids)
			}
			ids[c.rustdeskID], id = got, got
		}
		typ := TypeDeviceOffline
		if c.online {
			typ = TypeDeviceOnline
		}
		b.hub.Publish(Event{Type: typ, DeviceID: id})
	}
}
