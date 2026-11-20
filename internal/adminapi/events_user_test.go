package adminapi

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/events"
)

func userEventsFixture(t *testing.T, listen bool) (*env, *client, *client, *events.Hub, string, string, string, string) {
	t.Helper()
	hub := events.NewHub()
	e := newEnv(t, withHub(hub, 30*time.Millisecond))
	srv := e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	viewer, viewerID := e.signedIn("viewer", "user")
	group := owner.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "Visible"})["id"].(string)
	visible := e.enroll(srv, "910000001").String()
	hidden := e.enroll(srv, "910000002").String()
	for _, id := range []string{visible, hidden} {
		owner.ok(http.MethodPost, apiPrefix+"/devices/"+id+"/approve", nil)
	}
	owner.ok(http.MethodPatch, apiPrefix+"/devices/"+visible, map[string]any{"group_id": group})
	owner.ok(http.MethodPut, apiPrefix+"/users/"+viewerID.String()+"/grants", map[string]any{
		"group_ids": []string{group}, "device_ids": []string{},
	})
	if listen {
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() {
			defer close(done)
			events.Listen(ctx, e.d.Pool, hub, slog.New(slog.NewTextHandler(io.Discard, nil)))
		}()
		t.Cleanup(func() { cancel(); <-done })
		waitListening(t, e)
	}
	return e, owner, viewer, hub, viewerID.String(), group, visible, hidden
}

func TestUserEventsOnlyVisibleDevicesAndOwnAudit(t *testing.T) {
	e, _, viewer, hub, viewerID, _, visible, hidden := userEventsFixture(t, false)
	s := openStream(t, eventsServer(t, e, nil), viewer)
	require.Equal(t, "retry: 3000", s.next(t, time.Second))
	for _, typ := range []string{events.TypeDeviceUpdated, events.TypeDeviceOnline, events.TypeDeviceOffline,
		events.TypeDeviceDeleted, events.TypeSessionStarted, events.TypeSessionUpdated, events.TypeSessionEnded} {
		hub.Publish(events.Event{Type: typ, DeviceID: hidden, SessionID: uuid.NewString()})
		hub.Publish(events.Event{Type: typ, DeviceID: visible, SessionID: uuid.NewString()})
		require.Equal(t, "event: "+typ, s.waitForPrefix(t, "event: ", time.Second))
		require.Contains(t, s.next(t, time.Second), visible)
	}
	hub.Publish(events.Event{Type: events.TypeDeviceEnrolled, DeviceID: visible})
	hub.Publish(events.Event{Type: events.TypeAuditCreated, AuditID: uuid.NewString(), ActorUserID: uuid.NewString()})
	ownAudit := uuid.NewString()
	hub.Publish(events.Event{Type: events.TypeAuditCreated, AuditID: ownAudit, ActorUserID: viewerID})
	require.Equal(t, "event: audit.created", s.waitForPrefix(t, "event: ", time.Second))
	data := s.next(t, time.Second)
	require.Contains(t, data, ownAudit)
	require.NotContains(t, data, "actor_user_id")
	hub.Publish(events.Event{Type: events.TypePreferencesUpdated, UserID: viewerID})
	require.Equal(t, "event: preferences.updated", s.waitForPrefix(t, "event: ", time.Second))
}

func TestUserEventsResyncOnGrantChange(t *testing.T) {
	e, owner, viewer, _, viewerID, _, _, _ := userEventsFixture(t, true)
	s := openStream(t, eventsServer(t, e, nil), viewer)
	require.Equal(t, "retry: 3000", s.next(t, time.Second))
	owner.ok(http.MethodPut, apiPrefix+"/users/"+viewerID+"/grants", map[string]any{
		"group_ids": []string{}, "device_ids": []string{},
	})
	require.Equal(t, `data: {"type":"resync"}`, s.waitFor(t, "event: resync", 2*time.Second))
	require.True(t, s.ended(t, time.Second))
}

func TestUserEventsResyncAfterDeviceLeavesGroup(t *testing.T) {
	old := userEventsDebounce
	userEventsDebounce = 20 * time.Millisecond
	t.Cleanup(func() { userEventsDebounce = old })
	e, owner, viewer, _, _, _, visible, _ := userEventsFixture(t, true)
	s := openStream(t, eventsServer(t, e, nil), viewer)
	require.Equal(t, "retry: 3000", s.next(t, time.Second))
	owner.ok(http.MethodPatch, apiPrefix+"/devices/"+visible, map[string]any{"group_id": nil})
	require.Equal(t, `data: {"type":"resync"}`, s.waitFor(t, "event: resync", time.Second))
	require.True(t, s.ended(t, time.Second))
}

func TestAdminEventsResyncWhenDemotedToUser(t *testing.T) {
	hub := events.NewHub()
	e := newEnv(t, withHub(hub, 30*time.Millisecond))
	e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	admin, adminID := e.signedIn("admin", "admin")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		events.Listen(ctx, e.d.Pool, hub, slog.New(slog.NewTextHandler(io.Discard, nil)))
	}()
	t.Cleanup(func() { cancel(); <-done })
	waitListening(t, e)
	s := openStream(t, eventsServer(t, e, nil), admin)
	require.Equal(t, "retry: 3000", s.next(t, time.Second))
	owner.ok(http.MethodPatch, apiPrefix+"/users/"+adminID.String(), map[string]any{"role": "user"})
	require.Equal(t, `data: {"type":"resync"}`, s.waitFor(t, "event: resync", 2*time.Second))
	require.True(t, s.ended(t, time.Second))
}
