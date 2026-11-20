package adminapi

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pb33f/libopenapi-validator/config"
	"github.com/pb33f/libopenapi-validator/schema_validation"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/events"
	"github.com/dottio123/ferricade/internal/store/db"
)

// stream is an open event stream. Its lines are read in the background so
// that tests can wait on them with a deadline.
type stream struct {
	resp   *http.Response
	cancel context.CancelFunc
	lines  chan string // closed when the body ends
	live   liveEvents  // checks each line read against LiveEvent
}

// liveEvents checks lines of an event stream against the contract: each
// data line is a LiveEvent whose type is the preceding event line's.
type liveEvents struct{ event string }

func (l *liveEvents) check(t testing.TB, line string) {
	t.Helper()
	if typ, ok := strings.CutPrefix(line, "event: "); ok {
		l.event = typ
	}
	if data, ok := strings.CutPrefix(line, "data: "); ok {
		checkLiveEvent(t, l.event, data)
	}
}

// checkLiveEvent fails t unless data validates against openapi.yaml's
// LiveEvent schema and its type is event, the message's event name.
func checkLiveEvent(t testing.TB, event, data string) {
	t.Helper()
	sp := contractModel(t).Components.Schemas.GetOrZero("LiveEvent")
	if sp == nil {
		t.Fatalf("contract: openapi.yaml has no LiveEvent schema (event %s, data %s)", event, data)
		return
	}
	ok, errs := schema_validation.NewSchemaValidator(config.WithFormatAssertions()).
		ValidateSchemaStringWithVersion(sp.Schema(), data, 3.1)
	if !ok {
		var b strings.Builder
		for _, e := range errs {
			fmt.Fprintf(&b, "\n  %s: %s", e.Message, e.Reason)
			for _, f := range e.SchemaValidationErrors {
				fmt.Fprintf(&b, "\n    %s: %s", f.FieldPath, f.Reason)
			}
		}
		t.Errorf("contract: event %s data does not match LiveEvent:%s\n  data: %s", event, b.String(), data)
	}
	var payload struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal([]byte(data), &payload); err != nil {
		t.Errorf("contract: event %s data is not JSON: %v: %s", event, err, data)
	} else if payload.Type != event {
		t.Errorf("contract: event %s carries data of type %q: %s", event, payload.Type, data)
	}
}

// liveEventTypes is every event type the server sends: the hub's, and
// resync from the stream handler.
var liveEventTypes = []string{
	events.TypeDeviceUpdated, events.TypeDeviceEnrolled, events.TypeDeviceDeleted, events.TypeDeviceOnline, events.TypeDeviceOffline,
	events.TypeSessionStarted, events.TypeSessionUpdated, events.TypeSessionEnded,
	events.TypeAuditCreated, events.TypePreferencesUpdated, "resync",
	events.TypeGroupRulesUpdated,
	events.TypeIDAllowListUpdated,
}

func TestLiveEventSchema(t *testing.T) {
	sp := contractModel(t).Components.Schemas.GetOrZero("LiveEvent")
	require.NotNil(t, sp, "openapi.yaml has a LiveEvent schema")
	var enum []string
	for _, v := range sp.Schema().Properties.GetOrZero("type").Schema().Enum {
		enum = append(enum, v.Value)
	}
	require.ElementsMatch(t, liveEventTypes, enum, "LiveEvent.type lists exactly the types the server sends")

	id := uuid.NewString()
	for _, c := range []struct{ event, data string }{
		{"device.updated", `{"type":"device.updated","device_id":"x"}`},                // not a uuid
		{"device.updated", `{"type":"device.updated","device_id":"` + id + `","x":1}`}, // closed shape
		{"nope", `{"type":"nope"}`},                    // unknown type
		{"resync", `{}`},                               // no type
		{"device.online", `{"type":"device.offline"}`}, // event name and type disagree
		{"session.started", `null`},                    // not an object
	} {
		f := &fakeTB{TB: t}
		checkLiveEvent(f, c.event, c.data)
		require.NotEmpty(t, f.failures, "event %s data %s passes", c.event, c.data)
	}
	ok := &fakeTB{TB: t}
	checkLiveEvent(ok, "session.updated", `{"type":"session.updated","session_id":"`+id+`","device_id":"`+id+`"}`)
	require.Empty(t, ok.failures)
}

// TestEventsStreamEveryType sends one event of each hub type through a
// stream; next checks each against LiveEvent.
func TestEventsStreamEveryType(t *testing.T) {
	hub := events.NewHub()
	e := newEnv(t, withHub(hub, 0))
	e.markSetupComplete()
	c, userID := e.signedIn("alice", "owner")
	srv := eventsServer(t, e, nil)
	s := openStream(t, srv, c)
	require.Equal(t, "retry: 3000", s.next(t, time.Second))

	id := uuid.NewString()
	sent := []events.Event{
		{Type: events.TypeDeviceUpdated, DeviceID: id},
		{Type: events.TypeDeviceEnrolled, DeviceID: id},
		{Type: events.TypeDeviceOnline, DeviceID: id},
		{Type: events.TypeDeviceOffline, DeviceID: id},
		{Type: events.TypeSessionStarted, SessionID: id, DeviceID: id},
		{Type: events.TypeSessionUpdated, SessionID: id, DeviceID: id},
		{Type: events.TypeSessionEnded, SessionID: id, DeviceID: id},
		{Type: events.TypeAuditCreated, AuditID: id},
		{Type: events.TypePreferencesUpdated, UserID: userID.String()},
		{Type: events.TypeGroupRulesUpdated},
		{Type: events.TypeIDAllowListUpdated},
	}
	for _, ev := range sent {
		hub.Publish(ev)
	}
	for _, ev := range sent {
		require.Equal(t, "event: "+ev.Type, s.waitForPrefix(t, "event: ", 2*time.Second))
		require.True(t, strings.HasPrefix(s.next(t, time.Second), "data: "))
	}
	hub.Resync()
	require.Equal(t, `data: {"type":"resync"}`, s.waitFor(t, "event: resync", 2*time.Second))
}

func TestEventsStreamHidesIDAllowListUpdatesFromUsers(t *testing.T) {
	hub := events.NewHub()
	e := newEnv(t, withHub(hub, 0))
	e.markSetupComplete()
	c, userID := e.signedIn("alice", "user")
	srv := eventsServer(t, e, nil)
	s := openStream(t, srv, c)
	require.Equal(t, "retry: 3000", s.next(t, time.Second))

	hub.Publish(events.Event{Type: events.TypeIDAllowListUpdated})
	hub.Publish(events.Event{Type: events.TypeAuditCreated, ActorUserID: userID.String()})
	require.Equal(t, "event: audit.created", s.waitForPrefix(t, "event: ", time.Second))
}

// getEvents sends GET /events to srv as c.
func getEvents(t *testing.T, srv *httptest.Server, c *client) (*http.Response, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+apiPrefix+"/events", nil)
	require.NoError(t, err)
	req.Header.Set("Origin", publicURL)
	if c.cookie != nil {
		req.AddCookie(c.cookie)
	}
	resp, err := srv.Client().Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { resp.Body.Close() })
	return resp, cancel
}

// openStream opens GET /events and reads its body from a goroutine that ends
// with the test.
func openStream(t *testing.T, srv *httptest.Server, c *client) *stream {
	t.Helper()
	resp, cancel := getEvents(t, srv, c)
	s := &stream{resp: resp, cancel: cancel, lines: make(chan string, 1<<16)}
	go func() {
		defer close(s.lines)
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			s.lines <- sc.Text()
		}
	}()
	return s
}

// next returns the next line, failing the test after d or at the end of the
// body. A data line must be a LiveEvent of the preceding event line's type.
func (s *stream) next(t *testing.T, d time.Duration) string {
	t.Helper()
	select {
	case l, ok := <-s.lines:
		require.True(t, ok, "stream ended")
		return s.checked(t, l)
	case <-time.After(d):
		require.FailNow(t, "no line within "+d.String())
		return ""
	}
}

// checked runs line through the stream's LiveEvent check and returns it.
func (s *stream) checked(t testing.TB, line string) string {
	t.Helper()
	s.live.check(t, line)
	return line
}

// waitFor reads lines until one equals want and returns the line after it.
func (s *stream) waitFor(t *testing.T, want string, d time.Duration) string {
	t.Helper()
	deadline := time.Now().Add(d)
	for {
		if l := s.next(t, time.Until(deadline)); l == want {
			return s.next(t, time.Until(deadline))
		}
	}
}

// waitForPrefix returns the first line that starts with prefix.
func (s *stream) waitForPrefix(t *testing.T, prefix string, d time.Duration) string {
	t.Helper()
	deadline := time.Now().Add(d)
	for {
		if l := s.next(t, time.Until(deadline)); strings.HasPrefix(l, prefix) {
			return l
		}
	}
}

// ended reports whether the body ends within d, checking but otherwise
// ignoring the remaining lines.
func (s *stream) ended(t testing.TB, d time.Duration) bool {
	t.Helper()
	timeout := time.After(d)
	for {
		select {
		case l, ok := <-s.lines:
			if !ok {
				return true
			}
			s.checked(t, l)
		case <-timeout:
			return false
		}
	}
}

func withHub(h *events.Hub, ping time.Duration) func(*Deps) {
	return func(d *Deps) { d.Hub, d.EventsPing = h, ping }
}

// eventsServer serves e's handler on a real listener, where streaming works.
func eventsServer(t *testing.T, e *env, mod func(*httptest.Server)) *httptest.Server {
	t.Helper()
	srv := httptest.NewUnstartedServer(e.h)
	if mod != nil {
		mod(srv)
	}
	srv.Start()
	t.Cleanup(srv.Close)
	return srv
}

// waitListening waits until the event listener has run LISTEN.
func waitListening(t *testing.T, e *env) {
	t.Helper()
	require.Eventually(t, func() bool {
		var n int
		err := e.d.Pool.QueryRow(context.Background(),
			`SELECT count(*) FROM pg_stat_activity
			 WHERE datname = current_database() AND query = 'LISTEN ferricade_events' AND state = 'idle'`).Scan(&n)
		return err == nil && n > 0
	}, 5*time.Second, 20*time.Millisecond, "the listener never ran LISTEN")
}

func startEventsListener(t *testing.T, e *env) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		events.Listen(ctx, e.d.Pool, e.d.Hub, quietLog())
	}()
	t.Cleanup(func() { cancel(); <-done })
	waitListening(t, e)
}

func TestDisableUserImmediatelyEndsEventsStream(t *testing.T) {
	e := newEnv(t, withHub(events.NewHub(), time.Hour))
	e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	bob, id := e.signedIn("bob", "admin")
	startEventsListener(t, e)
	s := openStream(t, eventsServer(t, e, nil), bob)
	require.Equal(t, "retry: 3000", s.next(t, time.Second))
	owner.ok(http.MethodPatch, apiPrefix+"/users/"+id.String(), map[string]string{"status": "disabled"})
	require.True(t, s.ended(t, 2*time.Second), "disable did not notify the stream")
}

func TestResetPasswordImmediatelyEndsEventsStream(t *testing.T) {
	e := newEnv(t, withHub(events.NewHub(), time.Hour))
	e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	bob, id := e.signedIn("bob", "admin")
	startEventsListener(t, e)
	s := openStream(t, eventsServer(t, e, nil), bob)
	require.Equal(t, "retry: 3000", s.next(t, time.Second))
	owner.ok(http.MethodPost, apiPrefix+"/users/"+id.String()+"/password", map[string]string{"password": "a brand new passphrase"})
	require.True(t, s.ended(t, 2*time.Second), "password reset did not notify the stream")
}

func TestEventsEndWhenTOTPRequiredOrEnrolled(t *testing.T) {
	for _, change := range []string{"required", "enrolled"} {
		t.Run(change, func(t *testing.T) {
			e := newEnv(t, withHub(events.NewHub(), time.Hour))
			e.markSetupComplete()
			owner, _ := e.signedIn("owner", "owner")
			bob, id := e.signedIn("bob", "admin")
			other := e.client()
			require.Equal(t, http.StatusOK, other.login("bob", goodPassword).Code)
			startEventsListener(t, e)
			s := openStream(t, eventsServer(t, e, nil), bob)
			require.Equal(t, "retry: 3000", s.next(t, time.Second))
			if change == "required" {
				owner.ok(http.MethodPatch, apiPrefix+"/users/"+id.String(), map[string]bool{"totp_required": true})
			} else {
				secret := other.ok(http.MethodPost, apiPrefix+"/auth/totp/enroll", nil)["secret"].(string)
				body := other.ok(http.MethodPost, apiPrefix+"/auth/totp/enroll/verify", map[string]string{"code": e.totpCode(secret)})
				other.csrf = body["csrf_token"].(string)
				require.Equal(t, http.StatusOK, other.do(http.MethodGet, protectedPath, nil).Code, "enrolling session survives")
			}
			require.True(t, s.ended(t, 2*time.Second), "MFA change did not notify the stream")
			if change == "enrolled" {
				requireError(t, bob.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, "unauthenticated")
			}
		})
	}
}

func TestSessionLiveRequiresMFA(t *testing.T) {
	for _, enrolled := range []bool{false, true} {
		t.Run(fmt.Sprint(enrolled), func(t *testing.T) {
			e := newEnv(t)
			_, id := e.signedIn("bob", "admin")
			ctx := context.Background()
			var sessionID []byte
			require.NoError(t, e.d.Pool.QueryRow(ctx, `SELECT id FROM sessions WHERE user_id = $1`, id).Scan(&sessionID))
			sess, err := e.d.Sessions.Check(ctx, db.New(e.d.Pool), sessionID)
			require.NoError(t, err)
			a := &api{d: e.d}
			live, _ := a.sessionLive(ctx, sess, "admin")
			require.True(t, live)
			if enrolled {
				require.NoError(t, db.New(e.d.Pool).SetTOTP(ctx, db.SetTOTPParams{ID: id, TOTPSecretEnc: []byte("sealed secret")}))
			} else {
				_, err := e.d.Pool.Exec(ctx, `UPDATE users SET totp_required = true WHERE id = $1`, id)
				require.NoError(t, err)
			}
			live, _ = a.sessionLive(ctx, sess, "admin")
			require.False(t, live, "stream must meet the current MFA rule")
		})
	}
}

func TestEventsStreamDelivers(t *testing.T) {
	hub := events.NewHub()
	e := newEnv(t, withHub(hub, 0))
	srv0 := e.markSetupComplete()
	c, _ := e.signedIn("alice", "owner")
	id := e.enroll(srv0, "100000001")

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		events.Listen(ctx, e.d.Pool, hub, slog.New(slog.NewTextHandler(io.Discard, nil)))
	}()
	t.Cleanup(func() { cancel(); <-done })
	waitListening(t, e)

	srv := eventsServer(t, e, nil)
	s := openStream(t, srv, c)
	require.Equal(t, http.StatusOK, s.resp.StatusCode)
	require.Equal(t, "text/event-stream", s.resp.Header.Get("Content-Type"))
	require.Equal(t, "no-store", s.resp.Header.Get("Cache-Control"))
	require.Equal(t, "no", s.resp.Header.Get("X-Accel-Buffering"))
	require.Equal(t, "retry: 3000", s.next(t, 2*time.Second))

	require.Equal(t, http.StatusOK, c.do(http.MethodPost, apiPrefix+"/devices/"+id.String()+"/approve", nil).Code)

	data := s.waitFor(t, "event: device.updated", 2*time.Second)
	require.True(t, strings.HasPrefix(data, "data: "), data)
	require.Contains(t, data, `"type":"device.updated"`)
	require.Contains(t, data, `"device_id":"`+id.String()+`"`)
}

func TestEventsRequireAuthAndMFA(t *testing.T) {
	e := newEnv(t, withHub(events.NewHub(), 0))
	e.markSetupComplete()
	e.createUser("bob", userOpts{totpSecret: newSecret(t)})
	c := e.client()
	require.Equal(t, http.StatusOK, c.login("bob", goodPassword).Code)
	requireError(t, c.do(http.MethodGet, apiPrefix+"/events", nil), http.StatusForbidden, "mfa_required")
	requireError(t, e.client().do(http.MethodGet, apiPrefix+"/events", nil), http.StatusUnauthorized, "unauthenticated")
}

func TestEventsStreamCap(t *testing.T) {
	hub := events.NewHub()
	e := newEnv(t, withHub(hub, 0))
	e.markSetupComplete()
	c, _ := e.signedIn("alice", "owner")
	srv := eventsServer(t, e, nil)

	var open []*stream
	for range 5 {
		s := openStream(t, srv, c)
		require.Equal(t, http.StatusOK, s.resp.StatusCode)
		open = append(open, s)
	}
	require.Equal(t, 5, hub.Subscribers())

	resp, _ := getEvents(t, srv, c)
	require.Equal(t, http.StatusTooManyRequests, resp.StatusCode)
	require.Equal(t, "application/json", resp.Header.Get("Content-Type"))
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.Contains(t, string(body), `"rate_limited"`)
	require.Equal(t, 5, hub.Subscribers(), "a refused stream does not subscribe")

	// Another session of the same user has its own five.
	other := e.client()
	require.Equal(t, http.StatusOK, other.login("alice", goodPassword).Code)
	require.Equal(t, http.StatusOK, openStream(t, srv, other).resp.StatusCode)

	// Closing one frees a slot.
	open[0].cancel()
	require.Eventually(t, func() bool {
		resp, cancel := getEvents(t, srv, c)
		defer cancel()
		return resp.StatusCode == http.StatusOK
	}, 2*time.Second, 20*time.Millisecond)
}

func TestEventsStreamReleasesOnDisconnect(t *testing.T) {
	hub := events.NewHub()
	e := newEnv(t, withHub(hub, 0))
	e.markSetupComplete()
	c, _ := e.signedIn("alice", "owner")
	srv := eventsServer(t, e, nil)

	s := openStream(t, srv, c)
	require.Equal(t, 1, hub.Subscribers())
	s.cancel()
	require.Eventually(t, func() bool { return hub.Subscribers() == 0 }, time.Second, 10*time.Millisecond)
}

func TestEventsResyncWhenHubCloses(t *testing.T) {
	hub := events.NewHub()
	e := newEnv(t, withHub(hub, 0))
	e.markSetupComplete()
	c, _ := e.signedIn("alice", "owner")
	srv := eventsServer(t, e, nil)

	s := openStream(t, srv, c)
	require.Equal(t, "retry: 3000", s.next(t, time.Second))
	hub.Resync()
	require.Equal(t, `data: {"type":"resync"}`, s.waitFor(t, "event: resync", 2*time.Second))
	require.True(t, s.ended(t, 2*time.Second), "the handler returns after the resync event")
}

func TestEventsResyncWhenSlow(t *testing.T) {
	hub := events.NewHub()
	e := newEnv(t, withHub(hub, 0))
	e.markSetupComplete()
	c, _ := e.signedIn("alice", "owner")
	srv := eventsServer(t, e, nil)

	// A client that does not read.
	resp, _ := getEvents(t, srv, c)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	// Publish until the socket buffers are full, the handler blocks in its
	// write and the hub drops the subscriber.
	id := uuid.NewString()
	deadline := time.Now().Add(20 * time.Second)
	for hub.Subscribers() > 0 {
		require.True(t, time.Now().Before(deadline), "the hub never dropped the slow subscriber")
		for range 1000 {
			hub.Publish(events.Event{Type: events.TypeDeviceUpdated, DeviceID: id})
		}
	}

	// Now read: the buffered events, then the resync event, then the end.
	sc := bufio.NewScanner(resp.Body)
	var lines []string
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		for sc.Scan() {
			if l := sc.Text(); l != "" {
				lines = append(lines, l)
			}
		}
	}()
	select {
	case <-finished:
	case <-time.After(20 * time.Second):
		require.FailNow(t, "stream did not end")
	}
	var check liveEvents
	for _, l := range lines {
		check.check(t, l)
	}
	require.Equal(t, `data: {"type":"resync"}`, lines[len(lines)-1])
}

func TestEventsSurviveWriteTimeout(t *testing.T) {
	hub := events.NewHub()
	e := newEnv(t, withHub(hub, 300*time.Millisecond))
	e.markSetupComplete()
	c, _ := e.signedIn("alice", "owner")
	srv := eventsServer(t, e, func(s *httptest.Server) { s.Config.WriteTimeout = time.Second })

	s := openStream(t, srv, c)
	require.Equal(t, "retry: 3000", s.next(t, time.Second))
	// Pings keep coming well past the 1 s write timeout.
	start := time.Now()
	pings := 0
	for time.Since(start) < 3*time.Second {
		if l := s.next(t, 2*time.Second); l == ": ping" {
			pings++
		}
	}
	require.GreaterOrEqual(t, pings, 5)

	// And an event still gets through after the timeout would have fired.
	d1 := uuid.NewString()
	hub.Publish(events.Event{Type: events.TypeDeviceUpdated, DeviceID: d1})
	require.Contains(t, s.waitFor(t, "event: device.updated", 2*time.Second), `"device_id":"`+d1+`"`)
}

func TestEventsPreferencesOnlyForOwner(t *testing.T) {
	hub := events.NewHub()
	e := newEnv(t, withHub(hub, 0))
	e.markSetupComplete()
	alice, aliceID := e.signedIn("alice", "owner")
	bob, _ := e.signedIn("bob", "admin")
	srv := eventsServer(t, e, nil)

	sa, sb := openStream(t, srv, alice), openStream(t, srv, bob)
	hub.Publish(events.Event{Type: events.TypePreferencesUpdated, UserID: aliceID.String()})
	hub.Publish(events.Event{Type: events.TypeDeviceUpdated, DeviceID: uuid.NewString()})
	require.Contains(t, sa.waitFor(t, "event: preferences.updated", 2*time.Second), aliceID.String())
	// Bob's first event is the device one: the preferences one was not sent to him.
	require.Equal(t, "event: device.updated", sb.waitForPrefix(t, "event: ", 2*time.Second))
}

// holdsOpen reads pings from s for d, failing if the stream ends.
func holdsOpen(t *testing.T, s *stream, d time.Duration, wantPings int) {
	t.Helper()
	start := time.Now()
	pings := 0
	for time.Since(start) < d {
		if l := s.next(t, 2*time.Second); l == ": ping" {
			pings++
		}
	}
	require.GreaterOrEqual(t, pings, wantPings)
}

func TestEventsSurviveReadTimeout(t *testing.T) {
	e := newEnv(t, withHub(events.NewHub(), 300*time.Millisecond))
	e.markSetupComplete()
	c, _ := e.signedIn("alice", "owner")
	srv := eventsServer(t, e, func(s *httptest.Server) { s.Config.ReadTimeout = time.Second })

	s := openStream(t, srv, c)
	require.Equal(t, "retry: 3000", s.next(t, time.Second))
	holdsOpen(t, s, 3*time.Second, 5)
}

func TestEventsSlowReaderReleasesSlot(t *testing.T) {
	hub := events.NewHub()
	e := newEnv(t, withHub(hub, 0), func(d *Deps) { d.EventsWriteTimeout = 200 * time.Millisecond })
	e.markSetupComplete()
	c, _ := e.signedIn("alice", "owner")
	srv := eventsServer(t, e, nil)

	// Five clients that never read fill the session's slots.
	for range 5 {
		resp, _ := getEvents(t, srv, c)
		require.Equal(t, http.StatusOK, resp.StatusCode)
	}
	resp, _ := getEvents(t, srv, c)
	require.Equal(t, http.StatusTooManyRequests, resp.StatusCode)

	// Flood until the socket buffers are full and the writes block; each
	// handler gives up at its write deadline and releases its slot.
	id := uuid.NewString()
	require.Eventually(t, func() bool {
		for range 2000 {
			hub.Publish(events.Event{Type: events.TypeDeviceUpdated, DeviceID: id})
		}
		resp, cancel := getEvents(t, srv, c)
		defer cancel()
		return resp.StatusCode == http.StatusOK
	}, 20*time.Second, 50*time.Millisecond, "slots of stuck streams were never released")
}

func TestEventsUserCapAcrossSessions(t *testing.T) {
	e := newEnv(t, withHub(events.NewHub(), 0))
	e.markSetupComplete()
	e.createUser("alice", userOpts{role: "owner"})
	srv := eventsServer(t, e, nil)
	var open []*stream
	for range 5 {
		c := e.client()
		require.Equal(t, http.StatusOK, c.login("alice", goodPassword).Code)
		for range 4 {
			open = append(open, openStream(t, srv, c))
		}
	}
	defer func() {
		for _, s := range open {
			s.cancel()
		}
	}()
	c := e.client()
	require.Equal(t, http.StatusOK, c.login("alice", goodPassword).Code)
	resp, cancel := getEvents(t, srv, c)
	defer cancel()
	defer resp.Body.Close()
	require.Equal(t, http.StatusTooManyRequests, resp.StatusCode)
}

func TestEventsStreamCapReleasedByResync(t *testing.T) {
	hub := events.NewHub()
	e := newEnv(t, withHub(hub, 0))
	e.markSetupComplete()
	c, _ := e.signedIn("alice", "owner")
	srv := eventsServer(t, e, nil)

	var open []*stream
	for range 5 {
		open = append(open, openStream(t, srv, c))
	}
	hub.Resync()
	for _, s := range open {
		require.True(t, s.ended(t, 2*time.Second))
	}
	require.Eventually(t, func() bool {
		resp, cancel := getEvents(t, srv, c)
		defer cancel()
		return resp.StatusCode == http.StatusOK
	}, 2*time.Second, 20*time.Millisecond)
	// All five slots are free, not just one.
	for range 4 {
		openStream(t, srv, c)
	}
}

func TestEventsEndWithLogout(t *testing.T) {
	e := newEnv(t, withHub(events.NewHub(), 100*time.Millisecond))
	e.markSetupComplete()
	c, _ := e.signedIn("alice", "owner")
	srv := eventsServer(t, e, nil)

	s := openStream(t, srv, c)
	require.Equal(t, "retry: 3000", s.next(t, time.Second))
	holdsOpen(t, s, 500*time.Millisecond, 2)
	require.Equal(t, http.StatusNoContent, c.do(http.MethodPost, apiPrefix+"/auth/logout", nil).Code)
	require.True(t, s.ended(t, 2*time.Second), "the stream outlived its session")
}

func TestEventsEndWhenSessionsDeletedForUser(t *testing.T) {
	e := newEnv(t, withHub(events.NewHub(), 50*time.Millisecond))
	e.markSetupComplete()
	c, userID := e.signedIn("alice", "owner")
	srv := eventsServer(t, e, nil)

	s := openStream(t, srv, c)
	require.Equal(t, "retry: 3000", s.next(t, time.Second))
	require.NoError(t, e.d.Sessions.DeleteForUser(context.Background(), db.New(e.d.Pool), userID))
	require.True(t, s.ended(t, 2*time.Second), "the stream outlived deleted user sessions")
}

func TestEventsEndWhenUserDisabled(t *testing.T) {
	e := newEnv(t, withHub(events.NewHub(), 100*time.Millisecond))
	e.markSetupComplete()
	c, id := e.signedIn("alice", "owner")
	srv := eventsServer(t, e, nil)

	s := openStream(t, srv, c)
	require.Equal(t, "retry: 3000", s.next(t, time.Second))
	_, err := e.d.Pool.Exec(context.Background(), `UPDATE users SET status = 'disabled' WHERE id = $1`, id)
	require.NoError(t, err)
	require.True(t, s.ended(t, 2*time.Second), "the stream outlived its user")
}

func TestEventsKeepSessionAlive(t *testing.T) {
	e := newEnv(t, withHub(events.NewHub(), 50*time.Millisecond))
	e.markSetupComplete()
	c, id := e.signedIn("alice", "owner")
	srv := eventsServer(t, e, nil)
	lastSeen := func() time.Time {
		var ts time.Time
		require.NoError(t, e.d.Pool.QueryRow(context.Background(),
			`SELECT last_seen_at FROM sessions WHERE user_id = $1`, id).Scan(&ts))
		return ts
	}
	before := lastSeen()

	s := openStream(t, srv, c)
	require.Equal(t, "retry: 3000", s.next(t, time.Second))
	afterOpen := lastSeen()
	require.Equal(t, before, afterOpen)
	e.clock.Add(4 * time.Minute)
	require.Eventually(t, func() bool { return lastSeen().Equal(e.clock.Now()) }, time.Second, 10*time.Millisecond)
	e.clock.Add(2 * time.Minute)
	require.Eventually(t, func() bool { return lastSeen().Equal(e.clock.Now()) }, time.Second, 10*time.Millisecond)
	q := db.New(e.d.Pool)
	var sessionID []byte
	require.NoError(t, e.d.Pool.QueryRow(context.Background(), `SELECT id FROM sessions WHERE user_id = $1`, id).Scan(&sessionID))
	_, err := e.d.Sessions.Check(context.Background(), q, sessionID)
	require.NoError(t, err, "open stream should keep session alive")
	s.cancel()
}

func TestEventsEndWhenSessionIdle(t *testing.T) {
	e := newEnv(t, withHub(events.NewHub(), 50*time.Millisecond))
	e.markSetupComplete()
	c, _ := e.signedIn("alice", "owner")
	srv := eventsServer(t, e, nil)

	s := openStream(t, srv, c)
	require.Equal(t, "retry: 3000", s.next(t, time.Second))
	e.clock.Add(auth.SessionIdleTimeout)
	require.True(t, s.ended(t, 2*time.Second), "the stream outlived its idle timeout")
}
