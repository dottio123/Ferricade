package events_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/events"
)

// recv returns the next event on ch, failing the test if none comes within
// a second or ch is closed.
func recv(t *testing.T, ch <-chan events.Event) events.Event {
	t.Helper()
	select {
	case e, ok := <-ch:
		require.True(t, ok, "channel closed")
		return e
	case <-time.After(time.Second):
		t.Fatal("no event within 1 s")
		return events.Event{}
	}
}

func TestHubFanOut(t *testing.T) {
	h := events.NewHub()
	var chans []<-chan events.Event
	for range 3 {
		ch, unsub := h.Subscribe("")
		t.Cleanup(unsub)
		chans = append(chans, ch)
	}

	e := events.Event{Type: events.TypeDeviceUpdated, DeviceID: "d1"}
	h.Publish(e)
	for _, ch := range chans {
		assert.Equal(t, e, recv(t, ch))
	}
}

func TestHubSlowSubscriberClosed(t *testing.T) {
	h := events.NewHub()
	slow, unsubSlow := h.Subscribe("")
	t.Cleanup(unsubSlow)
	fast, unsubFast := h.Subscribe("")
	t.Cleanup(unsubFast)

	for i := range 64 {
		h.Publish(events.Event{Type: events.TypeAuditCreated, AuditID: string(rune('a' + i%26))})
		recv(t, fast)
	}
	// The 65th event finds slow's buffer full: slow is dropped, fast still
	// gets it, and Publish does not wait.
	done := make(chan struct{})
	go func() {
		h.Publish(events.Event{Type: events.TypeAuditCreated, AuditID: "last"})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Publish blocked on a full subscriber")
	}
	assert.Equal(t, "last", recv(t, fast).AuditID)

	for range 64 {
		recv(t, slow) // the buffered events are still delivered
	}
	select {
	case _, ok := <-slow:
		assert.False(t, ok, "the slow subscriber's channel is closed")
	case <-time.After(time.Second):
		t.Fatal("the slow subscriber's channel was not closed")
	}

	unsubSlow() // safe after the hub closed it
	h.Publish(events.Event{Type: events.TypeAuditCreated, AuditID: "after"})
	assert.Equal(t, "after", recv(t, fast).AuditID)
}

func TestHubPreferencesOnlyToOwner(t *testing.T) {
	h := events.NewHub()
	alice, unsubA := h.Subscribe("alice")
	t.Cleanup(unsubA)
	bob, unsubB := h.Subscribe("bob")
	t.Cleanup(unsubB)

	h.Publish(events.Event{Type: events.TypePreferencesUpdated, UserID: "alice"})
	h.Publish(events.Event{Type: events.TypeDeviceOnline, DeviceID: "d1"})

	assert.Equal(t, events.Event{Type: events.TypePreferencesUpdated, UserID: "alice"}, recv(t, alice))
	assert.Equal(t, events.Event{Type: events.TypeDeviceOnline, DeviceID: "d1"}, recv(t, alice))
	assert.Equal(t, events.Event{Type: events.TypeDeviceOnline, DeviceID: "d1"}, recv(t, bob),
		"bob never sees alice's preferences")
}

func TestHubGrantsChangeClosesOnlyTargetUser(t *testing.T) {
	h := events.NewHub()
	a, stopA := h.Subscribe("alice")
	defer stopA()
	a2, stopA2 := h.Subscribe("alice")
	defer stopA2()
	b, stopB := h.Subscribe("bob")
	defer stopB()
	h.Publish(events.Event{Type: "grants.changed", UserID: "alice"})
	for _, ch := range []<-chan events.Event{a, a2} {
		select {
		case _, ok := <-ch:
			require.False(t, ok, "target subscription must close without receiving grants.changed")
		case <-time.After(time.Second):
			t.Fatal("subscription not closed within 1 s")
		}
	}
	require.Equal(t, 1, h.Subscribers())
	h.Publish(events.Event{Type: events.TypeDeviceOnline, DeviceID: "d1"})
	require.Equal(t, events.TypeDeviceOnline, recv(t, b).Type, "other user receives no grants.changed")
}

func TestHubUnsubscribe(t *testing.T) {
	h := events.NewHub()
	ch, unsub := h.Subscribe("")
	other, unsubOther := h.Subscribe("")
	t.Cleanup(unsubOther)

	unsub()
	select {
	case _, ok := <-ch:
		assert.False(t, ok, "unsubscribe closes the channel")
	case <-time.After(time.Second):
		t.Fatal("unsubscribe did not close the channel")
	}
	unsub() // a second call is a no-op

	h.Publish(events.Event{Type: events.TypeSessionStarted, SessionID: "s1", DeviceID: "d1"})
	assert.Equal(t, "s1", recv(t, other).SessionID)
}

func TestEventJSONCarriesOnlySetIDs(t *testing.T) {
	b, err := json.Marshal(events.Event{Type: events.TypeSessionEnded, SessionID: "s1", DeviceID: "d1"})
	require.NoError(t, err)
	assert.JSONEq(t, `{"type":"session.ended","session_id":"s1","device_id":"d1"}`, string(b))
}

func TestHubResyncClosesEverySubscriber(t *testing.T) {
	h := events.NewHub()
	a, unsubA := h.Subscribe("alice")
	b, unsubB := h.Subscribe("")
	h.Publish(events.Event{Type: events.TypeDeviceUpdated, DeviceID: "d1"})

	h.Resync()
	for _, ch := range []<-chan events.Event{a, b} {
		assert.Equal(t, "d1", recv(t, ch).DeviceID, "buffered events are still delivered")
		select {
		case _, ok := <-ch:
			assert.False(t, ok, "Resync closes the channel")
		case <-time.After(time.Second):
			t.Fatal("Resync did not close the channel")
		}
	}
	unsubA() // safe after Resync
	unsubB()

	c, unsubC := h.Subscribe("")
	t.Cleanup(unsubC)
	h.Publish(events.Event{Type: events.TypeDeviceUpdated, DeviceID: "d2"})
	assert.Equal(t, "d2", recv(t, c).DeviceID, "a new subscriber gets events")
}

// Close ends every subscription, as Resync does, and also any made after it:
// a stream opened while the server shuts down ends at once.
func TestHubClose(t *testing.T) {
	h := events.NewHub()
	before, unsub := h.Subscribe("u1")
	defer unsub()
	h.Close()
	_, ok := <-before
	require.False(t, ok, "a subscription made before Close is closed")

	after, unsubAfter := h.Subscribe("u1")
	select {
	case _, ok := <-after:
		require.False(t, ok, "a subscription made after Close is closed")
	case <-time.After(time.Second):
		t.Fatal("a subscription made after Close stays open")
	}
	unsubAfter() // safe on a closed subscription
	h.Publish(events.Event{Type: events.TypeDeviceUpdated, DeviceID: "d"})
	require.Zero(t, h.Subscribers())
	h.Close() // safe twice
}
