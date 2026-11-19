// Package events fans out live changes (devices, sessions, audit entries,
// preferences) to subscribers such as the admin console's event stream. Events
// carry IDs only; a subscriber refetches whatever it shows.
package events

import "sync"

// Event types (spec, "Live updates").
const (
	TypeDeviceUpdated      = "device.updated"
	TypeDeviceEnrolled     = "device.enrolled"
	TypeDeviceDeleted      = "device.deleted"
	TypeDeviceOnline       = "device.online"
	TypeDeviceOffline      = "device.offline"
	TypeSessionStarted     = "session.started"
	TypeSessionUpdated     = "session.updated"
	TypeSessionEnded       = "session.ended"
	TypeAuditCreated       = "audit.created"
	TypePreferencesUpdated = "preferences.updated"
	TypeGrantsChanged      = "grants.changed" // internal: subscribers resync instead of receiving it
)

// subscriberBuffer is how many events a subscriber may fall behind before it
// is dropped.
const subscriberBuffer = 64

// Event is one change. Only the IDs the type concerns are set.
type Event struct {
	Type        string `json:"type"`
	DeviceID    string `json:"device_id,omitempty"`
	SessionID   string `json:"session_id,omitempty"`
	AuditID     string `json:"audit_id,omitempty"`
	UserID      string `json:"user_id,omitempty"`
	ActorUserID string `json:"-"`
	// TargetType is the audit entry's target type; internal, so that a User's
	// stream can tell group changes (which move devices in or out of its view).
	TargetType string `json:"-"`
}

// Hub delivers published events to every current subscriber. It is safe for
// concurrent use.
type Hub struct {
	mu     sync.Mutex
	subs   map[*subscriber]struct{}
	closed bool // set by Close: new subscriptions start closed
}

type subscriber struct {
	userID string
	ch     chan Event
}

// NewHub returns a Hub with no subscribers.
func NewHub() *Hub {
	return &Hub{subs: map[*subscriber]struct{}{}}
}

// Publish delivers e to every subscriber without waiting. A subscriber whose
// buffer is full is dropped and its channel closed: it has missed an event,
// so it must reconnect and refetch rather than carry on with a gap.
// preferences.updated goes only to subscribers of the same user.
func (h *Hub) Publish(e Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for s := range h.subs {
		if e.Type == TypeGrantsChanged {
			if s.userID == e.UserID {
				delete(h.subs, s)
				close(s.ch)
			}
			continue
		}
		if e.Type == TypePreferencesUpdated && s.userID != e.UserID {
			continue
		}
		select {
		case s.ch <- e:
		default:
			delete(h.subs, s)
			close(s.ch)
		}
	}
}

// Subscribe registers a subscriber for userID and returns its channel, which
// buffers 64 events, and a function that unsubscribes and closes the channel.
// The function is safe to call more than once, and after the hub has dropped
// the subscriber. After Close the channel is returned already closed.
func (h *Hub) Subscribe(userID string) (<-chan Event, func()) {
	s := &subscriber{userID: userID, ch: make(chan Event, subscriberBuffer)}
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		close(s.ch)
		return s.ch, func() {}
	}
	h.subs[s] = struct{}{}
	h.mu.Unlock()
	return s.ch, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if _, ok := h.subs[s]; ok {
			delete(h.subs, s)
			close(s.ch)
		}
	}
}

// Resync drops every current subscriber and closes its channel, as for a slow
// one: events may have been missed, so each must reconnect and refetch.
func (h *Hub) Resync() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for s := range h.subs {
		delete(h.subs, s)
		close(s.ch)
	}
}

// Close drops every subscriber, as Resync does, and makes every later
// Subscribe return a closed channel. The server calls it when it shuts down,
// so that event streams, which never finish by themselves, end at once
// instead of holding the shutdown for its whole drain period. It is safe to
// call more than once.
func (h *Hub) Close() {
	h.mu.Lock()
	h.closed = true
	h.mu.Unlock()
	h.Resync()
}

// Subscribers returns how many subscribers the hub currently has. It exists
// for tests.
func (h *Hub) Subscribers() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs)
}
