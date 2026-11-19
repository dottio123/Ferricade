package sessions_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/sessions"
)

func TestTypeName(t *testing.T) {
	want := map[int16]string{0: "remote", 1: "file_transfer", 2: "port_forward", 3: "camera", 4: "terminal", 5: "unknown", 9: "unknown", -1: "unknown"}
	for code, name := range want {
		assert.Equal(t, name, sessions.TypeName(&code), "code %d", code)
	}
	assert.Equal(t, "unknown", sessions.TypeName(nil))
}

func TestListInvalidCursor(t *testing.T) {
	e := newEnv(t, "approved")
	_, _, err := e.svc.List(context.Background(), sessions.Filter{Cursor: "bogus"})
	require.ErrorIs(t, err, sessions.ErrInvalidCursor)
}

// seed inserts n closed, authenticated sessions of the env's device, all
// started at at when same is true, else one second apart.
func (e *env) seed(t *testing.T, n int, at time.Time, same bool) {
	t.Helper()
	step := 1
	if same {
		step = 0
	}
	_, err := e.pool.Exec(context.Background(), `
		INSERT INTO remote_sessions (device_id, conn_id, started_at, authed_at, ended_at, end_reason, conn_seen_at)
		SELECT $1, g, $2::timestamptz + make_interval(secs => g * $3), $2::timestamptz + make_interval(secs => g * $3),
		       $2::timestamptz + interval '1 hour', 'closed', $2
		FROM generate_series(1, $4) g`, e.deviceID, at, step, n)
	require.NoError(t, err)
}

// insertSession inserts one closed session of device on conn, from start for
// dur, authenticated or not.
func (e *env) insertSession(t *testing.T, device uuid.UUID, conn int, start time.Time, dur time.Duration, authed bool) {
	t.Helper()
	var authedAt *time.Time
	if authed {
		authedAt = &start
	}
	_, err := e.pool.Exec(context.Background(), `
		INSERT INTO remote_sessions (device_id, conn_id, started_at, authed_at, ended_at, end_reason, conn_seen_at)
		VALUES ($1, $2, $3, $4, $5, 'closed', $5)`, device, conn, start, authedAt, start.Add(dur))
	require.NoError(t, err)
}

// Statistics count only sessions that were authenticated: a connection that
// was refused or abandoned before the peer authenticated is not a session.
func TestStatsCountOnlyAuthenticated(t *testing.T) {
	e := newEnv(t, "approved")
	other := e.addDevice(t, "987", "dXVpZA==", "approved")
	day := t0.Add(-2 * time.Hour)
	e.insertSession(t, e.deviceID, 1, day, time.Minute, true)
	e.insertSession(t, e.deviceID, 2, day, 10*time.Minute, false)
	e.insertSession(t, other, 1, day, time.Hour, false) // only unauthenticated sessions

	st, err := e.svc.Stats(context.Background(), "7d", time.UTC)
	require.NoError(t, err)
	assert.Equal(t, sessions.DayStats{Day: "2026-10-06", Count: 1, TotalSeconds: 60}, st.PerDay[6])
	assert.EqualValues(t, 60, st.AverageSeconds)
	require.Len(t, st.TopDevices, 1)
	assert.Equal(t, e.deviceID, st.TopDevices[0].DeviceID)
	assert.EqualValues(t, 1, st.TopDevices[0].Count)
	assert.EqualValues(t, 60, st.TopDevices[0].TotalSeconds)
}

// List keeps every session; Authenticated narrows it.
func TestListAuthenticatedFilter(t *testing.T) {
	e := newEnv(t, "approved")
	e.insertSession(t, e.deviceID, 1, t0.Add(-2*time.Hour), time.Minute, true)
	e.insertSession(t, e.deviceID, 2, t0.Add(-time.Hour), time.Minute, false)
	ctx := context.Background()
	all, _, err := e.svc.List(ctx, sessions.Filter{})
	require.NoError(t, err)
	require.Len(t, all, 2)
	yes, no := true, false
	authed, _, err := e.svc.List(ctx, sessions.Filter{Authenticated: &yes})
	require.NoError(t, err)
	require.Len(t, authed, 1)
	assert.NotNil(t, authed[0].AuthedAt)
	unauthed, _, err := e.svc.List(ctx, sessions.Filter{Authenticated: &no})
	require.NoError(t, err)
	require.Len(t, unauthed, 1)
	assert.Nil(t, unauthed[0].AuthedAt)
}

// Day labels do not depend on the connection's DateStyle.
func TestStatsDayLabelsIgnoreDateStyle(t *testing.T) {
	e := newEnv(t, "approved")
	e.insertSession(t, e.deviceID, 1, t0.Add(-2*time.Hour), time.Minute, true)
	cfg := e.pool.Config().Copy()
	cfg.ConnConfig.RuntimeParams["DateStyle"] = "SQL, DMY"
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	var style string
	require.NoError(t, pool.QueryRow(context.Background(), `SHOW DateStyle`).Scan(&style))
	require.Equal(t, "SQL, DMY", style)

	svc := &sessions.Service{Pool: pool, Now: func() time.Time { return t0 }}
	st, err := svc.Stats(context.Background(), "7d", time.UTC)
	require.NoError(t, err)
	assert.Equal(t, sessions.DayStats{Day: "2026-10-06", Count: 1, TotalSeconds: 60}, st.PerDay[6])
	var total int64
	for _, d := range st.PerDay {
		total += d.Count
	}
	assert.EqualValues(t, 1, total, "the session lands on a labelled day")
}

func TestListLimitCap(t *testing.T) {
	e := newEnv(t, "approved")
	e.seed(t, 201, t0.Add(-time.Hour), false)
	list, next, err := e.svc.List(context.Background(), sessions.Filter{Limit: 100000})
	require.NoError(t, err)
	assert.Len(t, list, 200)
	assert.NotEmpty(t, next)
}

// Sessions with the same started_at are told apart by id, so a page boundary
// between them loses and repeats nothing.
func TestListKeysetTieBreak(t *testing.T) {
	e := newEnv(t, "approved")
	e.seed(t, 5, t0.Add(-time.Hour), true)
	seen := map[uuid.UUID]int{}
	cursor := ""
	for range 10 {
		list, next, err := e.svc.List(context.Background(), sessions.Filter{Limit: 1, Cursor: cursor})
		require.NoError(t, err)
		for _, s := range list {
			seen[s.ID]++
		}
		if next == "" {
			break
		}
		cursor = next
	}
	require.Len(t, seen, 5)
	for id, n := range seen {
		assert.Equal(t, 1, n, "session %s", id)
	}
}

func TestStatsUnknownZone(t *testing.T) {
	e := newEnv(t, "approved")
	e.seed(t, 1, t0, false) // the zone is only evaluated for a row
	// Go accepts any name for a fixed zone; Postgres does not know this one.
	_, err := e.svc.Stats(context.Background(), "7d", time.FixedZone("Mars/Base", 0))
	require.ErrorIs(t, err, sessions.ErrUnknownZone)
}

func TestStatsRangeAndZone(t *testing.T) {
	e := newEnv(t, "approved")
	_, err := e.svc.Stats(context.Background(), "1d", time.UTC)
	require.ErrorIs(t, err, sessions.ErrInvalidRange)

	// 2026-03-08 is the day New York springs forward: the day list must still
	// hold seven distinct, consecutive dates.
	e.now = time.Date(2026, 3, 10, 12, 0, 0, 0, time.UTC)
	ny, err := time.LoadLocation("America/New_York")
	require.NoError(t, err)
	st, err := e.svc.Stats(context.Background(), "7d", ny)
	require.NoError(t, err)
	var days []string
	for _, d := range st.PerDay {
		days = append(days, d.Day)
	}
	assert.Equal(t, []string{"2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"}, days)
	assert.Zero(t, st.AverageSeconds)
	assert.Empty(t, st.TopDevices)
}
