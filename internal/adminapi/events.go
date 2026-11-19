package adminapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/events"
	"github.com/dottio123/ferricade/internal/store/db"
)

// Tests shorten the visible-set debounce without waiting for its production interval.
var userEventsDebounce = time.Second

const (
	// maxStreamsPerSession caps open event streams per session: a browser
	// needs one, and the cap keeps a stuck client from exhausting sockets.
	maxStreamsPerSession = 5
	maxStreamsPerUser    = 20
	// defaultEventsPing is how often an idle stream carries a comment, so that
	// proxies keep it open and a dead peer is noticed.
	defaultEventsPing = 25 * time.Second
	// sessionKeepAlive bounds the time an open stream can go without touching
	// its session. Tests may shorten it through EventsPing.
	sessionKeepAlive = time.Minute
	// defaultEventsWriteTimeout bounds one write to a stream: a peer that stops
	// reading must not pin the handler and a slot of the cap.
	defaultEventsWriteTimeout = 10 * time.Second
	// eventsRetry is the reconnect delay, in milliseconds, told to EventSource.
	eventsRetry = 3000
)

// streamCounts counts open event streams per session ID and user ID.
type streamCounts struct {
	mu    sync.Mutex
	n     map[string]int
	users map[string]int
}

// acquire takes a slot for session and user and reports whether both caps allow it.
func (s *streamCounts) acquire(session, user string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.n == nil {
		s.n = map[string]int{}
	}
	if s.users == nil {
		s.users = map[string]int{}
	}
	if s.n[session] >= maxStreamsPerSession || s.users[user] >= maxStreamsPerUser {
		return false
	}
	s.n[session]++
	s.users[user]++
	return true
}

func (s *streamCounts) release(session, user string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.n[session]--; s.n[session] <= 0 {
		delete(s.n, session)
	}
	if s.users[user]--; s.users[user] <= 0 {
		delete(s.users, user)
	}
}

// events handles GET /events: a server-sent event stream of the hub's events.
// It ends when the client goes away, or after a resync event when the hub
// closed the subscription (the subscriber was too slow, or the event listener
// reconnected): events may have been missed, so the client must refetch.
func (a *api) events(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	sess := sessionFrom(ctx)
	sid := string(sess.ID)
	uid := userFrom(ctx).ID.String()
	if !a.streams.acquire(sid, uid) {
		writeError(w, http.StatusTooManyRequests, codeRateLimited, "too many event streams for this user")
		return
	}
	defer a.streams.release(sid, uid)

	// Subscribe before the headers go out, so that a client that has them is
	// already receiving.
	ch, unsubscribe := a.d.Hub.Subscribe(uid)
	defer unsubscribe()
	// The role the request was authorized with may be stale: a role change that
	// committed after loadSession read it, but before the subscription above,
	// announced itself to nobody. Read it again, and keep it to compare on
	// every ping.
	cur, err := db.New(a.d.Pool).GetUserByID(ctx, userFrom(ctx).ID)
	if err != nil {
		a.writeInternal(w, r, fmt.Errorf("read event stream role: %w", err))
		return
	}
	streamRole := cur.Role
	var scope *uuid.UUID
	if streamRole == roleUser {
		scope = &cur.ID
	}
	var visible map[string]bool
	loadVisible := func() (map[string]bool, error) {
		ids, err := db.New(a.d.Pool).ListVisibleDeviceIDs(ctx, *scope)
		if err != nil {
			return nil, fmt.Errorf("list visible event devices: %w", err)
		}
		set := make(map[string]bool, len(ids))
		for _, id := range ids {
			set[id.String()] = true
		}
		return set, nil
	}
	if scope != nil {
		var err error
		visible, err = loadVisible()
		if err != nil {
			a.writeInternal(w, r, err)
			return
		}
	}

	rc := http.NewResponseController(w)
	// The server's ReadTimeout and WriteTimeout would end a stream that lives
	// for hours. Reads are not needed after the request; each write sets its
	// own deadline instead (send).
	_ = rc.SetReadDeadline(time.Time{})

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	// send writes s and flushes; false means the client is gone or stopped
	// reading for longer than the write timeout.
	send := func(s string) bool {
		_ = rc.SetWriteDeadline(time.Now().Add(a.d.EventsWriteTimeout))
		if _, err := fmt.Fprint(w, s); err != nil {
			return false
		}
		return rc.Flush() == nil
	}
	if !send(fmt.Sprintf("retry: %d\n\n", eventsRetry)) {
		return
	}
	if streamRole != userFrom(ctx).Role {
		send("event: resync\ndata: {\"type\":\"resync\"}\n\n")
		return
	}

	ping := time.NewTicker(a.d.EventsPing)
	defer ping.Stop()
	keepAliveInterval := sessionKeepAlive
	if a.d.EventsPing < keepAliveInterval {
		keepAliveInterval = a.d.EventsPing
	}
	keepAlive := time.NewTicker(keepAliveInterval)
	defer keepAlive.Stop()
	var reloadTimer *time.Timer
	var reload <-chan time.Time
	defer func() {
		if reloadTimer != nil {
			reloadTimer.Stop()
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case e, ok := <-ch:
			if !ok {
				send("event: resync\ndata: {\"type\":\"resync\"}\n\n")
				return
			}
			if scope != nil {
				// Moving, creating or deleting a group changes which devices a
				// granted group holds, without any device event.
				if e.Type == events.TypeDeviceUpdated || e.Type == events.TypeDeviceDeleted ||
					(e.Type == events.TypeAuditCreated && e.TargetType == "group") {
					if reload == nil {
						reloadTimer = time.NewTimer(userEventsDebounce)
						reload = reloadTimer.C
					}
				}
				switch e.Type {
				case events.TypeDeviceUpdated, events.TypeDeviceOnline, events.TypeDeviceOffline,
					events.TypeDeviceDeleted, events.TypeSessionStarted, events.TypeSessionUpdated, events.TypeSessionEnded:
					if !visible[e.DeviceID] {
						continue
					}
				case events.TypeAuditCreated:
					if e.ActorUserID != scope.String() {
						continue
					}
				case events.TypePreferencesUpdated:
					if e.UserID != scope.String() {
						continue
					}
				default:
					continue
				}
			}
			data, err := json.Marshal(e)
			if err != nil { // a struct of strings cannot fail
				a.log.Error("admin api: marshal event", "request_id", requestIDFrom(r.Context()), "err", err)
				return
			}
			if !send("event: " + e.Type + "\ndata: " + string(data) + "\n\n") {
				return
			}
		case <-reload:
			reload = nil
			next, err := loadVisible()
			if err != nil {
				a.log.Error("admin api: reload visible event devices", "request_id", requestIDFrom(r.Context()), "err", err)
				return
			}
			if !maps.Equal(visible, next) {
				send("event: resync\ndata: {\"type\":\"resync\"}\n\n")
				return
			}
			visible = next
		case <-ping.C:
			live, sameRole := a.sessionLive(ctx, sess, streamRole)
			if !live {
				return
			}
			if !sameRole {
				send("event: resync\ndata: {\"type\":\"resync\"}\n\n")
				return
			}
			if !send(": ping\n\n") {
				return
			}
		case <-keepAlive.C:
			if err := a.d.Sessions.Touch(ctx, db.New(a.d.Pool), sess.ID); errors.Is(err, auth.ErrNoSession) {
				return
			} else if err != nil {
				a.log.Error("admin api: touch event stream session", "request_id", requestIDFrom(r.Context()), "err", err)
			}
		}
	}
}

// sessionLive reports whether the session a stream was opened with is still valid: it
// exists, is within both expiries by its stored last_seen_at, meets the current MFA
// rule, and its user is still active. sameRole reports whether the user still has
// role, the one the stream was scoped with. The keep-alive ticker refreshes
// last_seen_at every minute while the stream remains open. A database error counts as
// live and unchanged: the next tick tries again.
func (a *api) sessionLive(ctx context.Context, opened auth.Session, role string) (live, sameRole bool) {
	q := db.New(a.d.Pool)
	cur, err := a.d.Sessions.Check(ctx, q, opened.ID)
	if errors.Is(err, auth.ErrNoSession) {
		return false, true
	}
	if err != nil {
		return ctx.Err() == nil, true
	}
	if opened.MFAPassed && !cur.MFAPassed {
		return false, true
	}
	u, err := q.GetUserByID(ctx, cur.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, true
	}
	if err != nil {
		return ctx.Err() == nil, true
	}
	if (u.TOTPSecretEnc != nil && !cur.MFAPassed) || (u.TOTPSecretEnc == nil && u.TOTPRequired) {
		return false, true
	}
	return u.Status == "active", u.Role == role
}
