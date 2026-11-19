package adminapi

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/clientapi/wire"
	"github.com/dottio123/ferricade/internal/store/db"
)

var nonces int

func (e *env) setNow(t time.Time) {
	e.clock.mu.Lock()
	defer e.clock.mu.Unlock()
	e.clock.t = t
}

// session records a remote session on the device through the client path:
// opened at start, authenticated as typ (nil leaves the type unknown), and
// closed after dur, or left open when dur is 0. The clock is put back after.
func (e *env) session(srv db.Server, rustdeskID string, conn int32, typ *int, start time.Time, dur time.Duration) {
	e.t.Helper()
	_, err := e.d.Pool.Exec(context.Background(), `UPDATE devices SET state = 'approved' WHERE server_id = $1 AND rustdesk_id = $2`, srv.ID, rustdeskID)
	require.NoError(e.t, err)
	defer e.setNow(e.clock.Now())
	send := func(at time.Time, a wire.ConnAudit) {
		nonces++
		a.ID, a.UUID, a.ConnID, a.Nonce = rustdeskID, testUUID, conn, fmt.Sprintf("n%d", nonces)
		e.setNow(at)
		require.NoError(e.t, e.d.RemoteSessions.Ingest(context.Background(), srv.ID, a, deviceIP))
	}
	send(start, wire.ConnAudit{Action: wire.ConnActionNew, IP: "203.0.113.7"})
	send(start, wire.ConnAudit{Peer: []string{"555", "laptop"}, Type: typ})
	if dur > 0 {
		send(start.Add(dur), wire.ConnAudit{Action: wire.ConnActionClose})
	}
}

func intp(v int) *int { return &v }

func listSessions(t *testing.T, c *client, query string) ([]map[string]any, string) {
	t.Helper()
	body := c.ok(http.MethodGet, apiPrefix+"/sessions"+query, nil)
	return items(t, body), body["next_cursor"].(string)
}

func ids(list []map[string]any) []string {
	out := make([]string, len(list))
	for i, s := range list {
		out[i] = s["id"].(string)
	}
	return out
}

func TestListSessionsFilters(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	c, _ := e.signedIn("alice", "owner")
	devA := e.enroll(srv, "100000001")
	devB := e.enroll(srv, "100000002")
	_, err := e.d.Pool.Exec(context.Background(), `UPDATE devices SET hostname = 'host-a' WHERE id = $1`, devA)
	require.NoError(t, err)
	now := e.clock.Now()

	e.session(srv, "100000001", 1, intp(0), now.Add(-3*time.Hour), time.Hour)
	e.session(srv, "100000001", 2, intp(1), now.Add(-2*time.Hour), 0) // open
	e.session(srv, "100000002", 3, intp(0), now.Add(-time.Hour), 90*time.Second)

	all, next := listSessions(t, c, "")
	require.Len(t, all, 3)
	require.Equal(t, "", next)
	require.Equal(t, []any{"100000002", "100000001", "100000001"}, []any{all[0]["rustdesk_id"], all[1]["rustdesk_id"], all[2]["rustdesk_id"]})
	require.Equal(t, devB.String(), all[0]["device_id"])
	require.Equal(t, "100000002", all[0]["device_name"], "no alias or hostname: the rustdesk_id")
	require.Equal(t, "host-a", all[1]["device_name"])
	require.Equal(t, "555", all[0]["peer_rustdesk_id"])
	require.Equal(t, "laptop", all[0]["peer_name"])
	require.Equal(t, "203.0.113.7", all[0]["client_ip"])
	require.Equal(t, "closed", all[0]["end_reason"])
	require.EqualValues(t, 90, all[0]["duration_seconds"])
	require.EqualValues(t, 3600, all[2]["duration_seconds"])
	require.Nil(t, all[1]["ended_at"])
	require.Nil(t, all[1]["end_reason"])
	require.EqualValues(t, 7200, all[1]["duration_seconds"], "an open session runs to now")
	require.NotNil(t, all[1]["authed_at"])

	byDev, _ := listSessions(t, c, "?device_id="+devA.String())
	require.Len(t, byDev, 2)
	open, _ := listSessions(t, c, "?active=true")
	require.Equal(t, []string{all[1]["id"].(string)}, ids(open))
	ended, _ := listSessions(t, c, "?active=false")
	require.Equal(t, []string{all[0]["id"].(string), all[2]["id"].(string)}, ids(ended))
	none, _ := listSessions(t, c, "?device_id="+uuid.NewString())
	require.Empty(t, none)

	since := url.QueryEscape(now.Add(-150 * time.Minute).Format(time.RFC3339))
	until := url.QueryEscape(now.Add(-time.Hour).Format(time.RFC3339))
	ranged, _ := listSessions(t, c, "?since="+since+"&until="+until)
	require.Equal(t, []string{all[1]["id"].(string)}, ids(ranged), "since inclusive, until exclusive")

	var got []string
	cursor := ""
	for pages := 0; ; pages++ {
		require.Less(t, pages, 5)
		q := "?limit=2"
		if cursor != "" {
			q += "&cursor=" + url.QueryEscape(cursor)
		}
		list, nx := listSessions(t, c, q)
		got = append(got, ids(list)...)
		if nx == "" {
			break
		}
		require.Len(t, list, 2)
		cursor = nx
	}
	require.Equal(t, ids(all), got)

	for _, q := range []string{"cursor=bogus", "device_id=x", "active=maybe", "since=yesterday", "until=1", "limit=0"} {
		requireError(t, c.do(http.MethodGet, apiPrefix+"/sessions?"+q, nil), http.StatusBadRequest, "bad_request")
	}
}

func TestSessionTypes(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	c, _ := e.signedIn("alice", "owner")
	e.enroll(srv, "100000001")
	now := e.clock.Now()
	codes := []*int{intp(0), intp(1), intp(2), intp(3), intp(4), nil, intp(9)}
	want := []string{"remote", "file_transfer", "port_forward", "camera", "terminal", "unknown", "unknown"}
	for i, code := range codes {
		e.session(srv, "100000001", int32(i+1), code, now.Add(-time.Duration(len(codes)-i)*time.Minute), 10*time.Second)
	}
	list, _ := listSessions(t, c, "")
	require.Len(t, list, len(codes))
	for i, s := range list { // newest first: the reverse of insertion
		require.Equal(t, want[len(want)-1-i], s["type"], "session %d", i)
	}
}

type statsDay struct {
	day          string
	count, total float64
}

func perDay(t *testing.T, body map[string]any) []statsDay {
	t.Helper()
	var out []statsDay
	for _, v := range body["per_day"].([]any) {
		m := v.(map[string]any)
		out = append(out, statsDay{m["day"].(string), m["count"].(float64), m["total_seconds"].(float64)})
	}
	return out
}

func TestSessionStatsDaysAndTZ(t *testing.T) {
	e := newEnv(t) // now: 2026-10-06 12:00 UTC
	srv := e.markSetupComplete()
	c, _ := e.signedIn("alice", "owner")
	e.enroll(srv, "100000001")
	// 02:00 UTC on the 6th is 22:00 on the 5th in New York (EDT); 20:00 UTC on
	// the 5th is 16:00 there.
	e.session(srv, "100000001", 1, intp(0), time.Date(2026, 10, 6, 2, 0, 0, 0, time.UTC), time.Hour)
	e.session(srv, "100000001", 2, intp(0), time.Date(2026, 10, 5, 20, 0, 0, 0, time.UTC), 3*time.Hour)

	utc := c.ok(http.MethodGet, apiPrefix+"/sessions/stats", nil)
	require.Equal(t, "7d", utc["range"])
	require.Equal(t, "UTC", utc["tz"])
	days := perDay(t, utc)
	require.Len(t, days, 7)
	require.Equal(t, "2026-09-30", days[0].day)
	require.Equal(t, statsDay{"2026-10-05", 1, 10800}, days[5])
	require.Equal(t, statsDay{"2026-10-06", 1, 3600}, days[6])
	require.Equal(t, statsDay{"2026-10-01", 0, 0}, days[1], "empty days are present")
	require.EqualValues(t, 7200, utc["average_seconds"])

	ny := c.ok(http.MethodGet, apiPrefix+"/sessions/stats?range=7d&tz=America/New_York", nil)
	require.Equal(t, "America/New_York", ny["tz"])
	days = perDay(t, ny)
	require.Len(t, days, 7)
	require.Equal(t, statsDay{"2026-10-05", 2, 14400}, days[5])
	require.Equal(t, statsDay{"2026-10-06", 0, 0}, days[6])

	require.Len(t, c.ok(http.MethodGet, apiPrefix+"/sessions/stats?range=30d", nil)["per_day"], 30)
	empty := c.ok(http.MethodGet, apiPrefix+"/sessions/stats?range=30d&tz=Asia/Tokyo", nil)
	require.Equal(t, 30, len(perDay(t, empty)))

	for _, q := range []string{"tz=Mars/Base", "tz=Local", "range=1d", "range=7"} {
		requireError(t, c.do(http.MethodGet, apiPrefix+"/sessions/stats?"+q, nil), http.StatusBadRequest, "bad_request")
	}
}

func TestSessionStatsTopDevices(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	c, _ := e.signedIn("alice", "owner")
	now := e.clock.Now()
	var devs []uuid.UUID
	for i := 1; i <= 6; i++ {
		rid := fmt.Sprintf("10000000%d", i)
		devs = append(devs, e.enroll(srv, rid))
		e.session(srv, rid, 1, intp(0), now.Add(-24*time.Hour), time.Duration(i)*time.Minute)
	}
	_, err := e.d.Pool.Exec(context.Background(), `UPDATE devices SET alias = 'Front desk' WHERE id = $1`, devs[5])
	require.NoError(t, err)
	// Device 1 has a second session, still open: it counts up to now.
	e.session(srv, "100000001", 2, intp(0), now.Add(-30*time.Minute), 0)

	body := c.ok(http.MethodGet, apiPrefix+"/sessions/stats", nil)
	top := body["top_devices"].([]any)
	require.Len(t, top, 5)
	first := top[0].(map[string]any)
	require.Equal(t, devs[0].String(), first["device_id"]) // 60 s + 30 min
	require.EqualValues(t, 2, first["count"])
	require.EqualValues(t, 1860, first["total_seconds"])
	second := top[1].(map[string]any)
	require.Equal(t, "Front desk", second["device_name"]) // 6 min
	require.EqualValues(t, 360, second["total_seconds"])
	require.Equal(t, "100000005", top[2].(map[string]any)["device_name"])
	require.Equal(t, "100000003", top[4].(map[string]any)["device_name"]) // the 2-minute device is sixth
	require.EqualValues(t, 437, body["average_seconds"])                  // (21 min + 30 min) / 7 sessions
}

func TestSessionsRequireMFA(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	e.createUser("bob", userOpts{totpSecret: newSecret(t)})
	c := e.client()
	require.Equal(t, http.StatusOK, c.login("bob", goodPassword).Code)
	for _, p := range []string{"/sessions", "/sessions/stats"} {
		requireError(t, c.do(http.MethodGet, apiPrefix+p, nil), http.StatusForbidden, "mfa_required")
		requireError(t, e.client().do(http.MethodGet, apiPrefix+p, nil), http.StatusUnauthorized, "unauthenticated")
	}
}

// A cursor outside timestamptz's range is a 400, not a database error.
func TestListSessionsForgedCursor(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	c, _ := e.signedIn("alice", "owner")
	for _, micro := range []string{"9223372036854775807", "-9223372036854775808", "0", "1e3"} {
		cur := base64.RawURLEncoding.EncodeToString([]byte(micro + "." + uuid.NewString()))
		requireError(t, c.do(http.MethodGet, apiPrefix+"/sessions?cursor="+cur, nil), http.StatusBadRequest, "bad_request")
	}
}

// attempt records a connection that never authenticated: "new", then a close
// after dur (left open when dur is 0).
func (e *env) attempt(srv db.Server, rustdeskID string, conn int32, start time.Time, dur time.Duration) {
	e.t.Helper()
	_, err := e.d.Pool.Exec(context.Background(), `UPDATE devices SET state = 'approved' WHERE server_id = $1 AND rustdesk_id = $2`, srv.ID, rustdeskID)
	require.NoError(e.t, err)
	defer e.setNow(e.clock.Now())
	send := func(at time.Time, a wire.ConnAudit) {
		nonces++
		a.ID, a.UUID, a.ConnID, a.Nonce = rustdeskID, testUUID, conn, fmt.Sprintf("n%d", nonces)
		e.setNow(at)
		require.NoError(e.t, e.d.RemoteSessions.Ingest(context.Background(), srv.ID, a, deviceIP))
	}
	send(start, wire.ConnAudit{Action: wire.ConnActionNew, IP: "203.0.113.9"})
	if dur > 0 {
		send(start.Add(dur), wire.ConnAudit{Action: wire.ConnActionClose})
	}
}

// Connection attempts that never authenticated are listed, and can be told
// apart with ?authenticated=, but no statistic counts them.
func TestSessionsAuthenticatedOnly(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	c, _ := e.signedIn("alice", "owner")
	e.enroll(srv, "100000001")
	dev2 := e.enroll(srv, "100000002")
	// The summary counts sessions of approved devices.
	_, err := e.d.Pool.Exec(context.Background(), `UPDATE devices SET state = 'approved'`)
	require.NoError(t, err)
	now := e.clock.Now()

	e.session(srv, "100000001", 1, intp(0), now.Add(-3*time.Hour), time.Minute)
	e.session(srv, "100000001", 2, intp(0), now.Add(-time.Hour), 0) // open
	e.attempt(srv, "100000001", 3, now.Add(-2*time.Hour), 10*time.Minute)
	e.attempt(srv, "100000002", 4, now.Add(-30*time.Minute), 0) // open, never authenticated

	all, _ := listSessions(t, c, "")
	require.Len(t, all, 4)
	authed, _ := listSessions(t, c, "?authenticated=true")
	require.Len(t, authed, 2)
	for _, s := range authed {
		require.NotNil(t, s["authed_at"])
	}
	unauthed, _ := listSessions(t, c, "?authenticated=false")
	require.Len(t, unauthed, 2)
	for _, s := range unauthed {
		require.Nil(t, s["authed_at"])
	}
	openUnauthed, _ := listSessions(t, c, "?authenticated=false&active=true")
	require.Len(t, openUnauthed, 1)
	require.Equal(t, dev2.String(), openUnauthed[0]["device_id"])
	requireError(t, c.do(http.MethodGet, apiPrefix+"/sessions?authenticated=yes", nil), http.StatusBadRequest, "bad_request")

	st := c.ok(http.MethodGet, apiPrefix+"/sessions/stats", nil)
	days := perDay(t, st)
	require.Equal(t, statsDay{"2026-10-06", 2, 60 + 3600}, days[6])
	require.EqualValues(t, 1830, st["average_seconds"])
	top := st["top_devices"].([]any)
	require.Len(t, top, 1, "a device with only attempts is not a top device")
	require.EqualValues(t, 2, top[0].(map[string]any)["count"])

	summary := c.ok(http.MethodGet, apiPrefix+"/stats/summary", nil)
	require.EqualValues(t, 1, summary["sessions"].(map[string]any)["active"])
}

func TestDisconnectSession(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	owner, _ := e.signedIn("alice", "owner")
	admin, _ := e.signedIn("carol", "admin")
	e.enroll(srv, "100000001")
	now := e.clock.Now()
	e.session(srv, "100000001", 1, intp(0), now.Add(-time.Hour), 0)             // open
	e.session(srv, "100000001", 2, intp(0), now.Add(-2*time.Hour), time.Hour/2) // ended
	all, _ := listSessions(t, owner, "")
	byConn := map[string]map[string]any{}
	for _, s := range all {
		if s["ended_at"] == nil {
			byConn["open"] = s
		} else {
			byConn["ended"] = s
		}
		require.Contains(t, s, "disconnect_requested_at")
		require.Nil(t, s["disconnect_requested_at"])
	}
	open, ended := byConn["open"]["id"].(string), byConn["ended"]["id"].(string)
	audits := func() int {
		var n int
		require.NoError(t, e.d.Pool.QueryRow(context.Background(),
			`SELECT count(*) FROM audit_events WHERE action = 'session.disconnect_requested' AND target_type = 'session' AND target_id = $1`,
			open).Scan(&n))
		return n
	}

	rec := owner.do(http.MethodPost, apiPrefix+"/sessions/"+open+"/disconnect", nil)
	require.Equal(t, http.StatusAccepted, rec.Code, rec.Body.String())
	first := decodeBody(t, rec)
	require.Equal(t, open, first["id"])
	require.NotNil(t, first["disconnect_requested_at"])
	require.Nil(t, first["ended_at"])
	require.Equal(t, 1, audits())

	e.setNow(now.Add(time.Minute))
	rec = admin.do(http.MethodPost, apiPrefix+"/sessions/"+open+"/disconnect", nil)
	require.Equal(t, http.StatusAccepted, rec.Code, rec.Body.String())
	require.Equal(t, first["disconnect_requested_at"], decodeBody(t, rec)["disconnect_requested_at"], "the original time is kept")
	require.Equal(t, 1, audits(), "no second audit row")

	requireError(t, admin.do(http.MethodPost, apiPrefix+"/sessions/"+ended+"/disconnect", nil), http.StatusConflict, "session_ended")
	requireError(t, admin.do(http.MethodPost, apiPrefix+"/sessions/"+uuid.NewString()+"/disconnect", nil), http.StatusNotFound, codeNotFound)
	requireError(t, admin.do(http.MethodPost, apiPrefix+"/sessions/not-a-uuid/disconnect", nil), http.StatusNotFound, codeNotFound)

	user, _ := e.signedIn("bob", "user")
	requireError(t, user.do(http.MethodPost, apiPrefix+"/sessions/"+open+"/disconnect", nil), http.StatusForbidden, codeForbidden)
}
