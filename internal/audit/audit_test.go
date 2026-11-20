package audit_test

import (
	"context"
	"errors"
	"net/netip"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

var testIP = netip.MustParseAddr("192.0.2.7")

func ev(action string) audit.Event {
	return audit.Event{ActorIP: testIP, Action: action, TargetType: "device", TargetID: "t-" + action}
}

func TestRecordAndList(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)

	var userID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users (username, role, password_hash) VALUES ('alice', 'admin', 'x') RETURNING id`).Scan(&userID))

	first := ev("one")
	first.ActorUserID = &userID
	first.Details = map[string]any{"name": "laptop", "count": float64(3), "nested": map[string]any{"ok": true}}
	require.NoError(t, audit.Record(ctx, q, first))
	require.NoError(t, audit.Record(ctx, q, ev("two")))
	require.NoError(t, audit.Record(ctx, q, ev("three")))

	got, next, err := audit.List(ctx, q, audit.Filter{})
	require.NoError(t, err)
	require.Empty(t, next)
	require.Len(t, got, 3)
	require.Equal(t, []string{"three", "two", "one"}, []string{got[0].Action, got[1].Action, got[2].Action})

	for _, e := range got {
		require.NotEqual(t, uuid.Nil, e.ID)
		require.Equal(t, testIP, e.ActorIP)
		require.Equal(t, "device", e.TargetType)
		require.Equal(t, time.UTC, e.At.Location())
		require.WithinDuration(t, time.Now(), e.At, time.Minute)
		require.NotNil(t, e.Details, "Details must be non-nil for every entry")
	}
	require.Nil(t, got[0].ActorUserID)
	require.Equal(t, "t-three", got[0].TargetID)
	require.Empty(t, got[0].Details)
	require.NotNil(t, got[2].ActorUserID)
	require.Equal(t, userID, *got[2].ActorUserID)
	require.Equal(t, first.Details, got[2].Details)
}

func TestRecordRejectsInvalidActorIP(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)

	err := audit.Record(ctx, q, audit.Event{Action: "x"})
	require.Error(t, err)

	got, _, err := audit.List(ctx, q, audit.Filter{})
	require.NoError(t, err)
	require.Empty(t, got)
}

func TestRecordRejectsUnmarshalableDetails(t *testing.T) {
	pool := store.NewTestDB(t)
	e := ev("x")
	e.Details = map[string]any{"bad": make(chan int)}
	require.Error(t, audit.Record(context.Background(), db.New(pool), e))
}

func TestListFiltersByAction(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)

	for _, a := range []string{"a", "b", "a"} {
		require.NoError(t, audit.Record(ctx, q, ev(a)))
	}
	got, _, err := audit.List(ctx, q, audit.Filter{Action: "a"})
	require.NoError(t, err)
	require.Len(t, got, 2)
	for _, e := range got {
		require.Equal(t, "a", e.Action)
	}
}

func TestListFiltersByTargetActorAndTime(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)

	var userID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users (username, role, password_hash) VALUES ('bob', 'admin', 'x') RETURNING id`).Scan(&userID))

	before := time.Now().Add(-time.Minute)
	e1 := ev("a")
	e1.ActorUserID = &userID
	require.NoError(t, audit.Record(ctx, q, e1))
	require.NoError(t, audit.Record(ctx, q, ev("b")))

	got, _, err := audit.List(ctx, q, audit.Filter{TargetID: "t-b"})
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, "b", got[0].Action)

	got, _, err = audit.List(ctx, q, audit.Filter{ActorUserID: &userID})
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, "a", got[0].Action)

	got, _, err = audit.List(ctx, q, audit.Filter{Since: before, Until: time.Now().Add(time.Minute)})
	require.NoError(t, err)
	require.Len(t, got, 2)

	got, _, err = audit.List(ctx, q, audit.Filter{Since: time.Now().Add(time.Minute)})
	require.NoError(t, err)
	require.Empty(t, got)

	got, _, err = audit.List(ctx, q, audit.Filter{Until: before})
	require.NoError(t, err)
	require.Empty(t, got)
}

func TestListPaginates(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)

	want := []string{"e5", "e4", "e3", "e2", "e1"}
	for i := len(want) - 1; i >= 0; i-- {
		require.NoError(t, audit.Record(ctx, q, ev(want[i])))
	}

	var seen []string
	var sizes []int
	cursor := ""
	for range 10 {
		page, next, err := audit.List(ctx, q, audit.Filter{Limit: 2, Cursor: cursor})
		require.NoError(t, err)
		sizes = append(sizes, len(page))
		for _, e := range page {
			seen = append(seen, e.Action)
		}
		cursor = next
		if cursor == "" {
			break
		}
	}
	require.Equal(t, []int{2, 2, 1}, sizes)
	require.Equal(t, want, seen)
	require.Empty(t, cursor)
}

func TestListPaginatesEventsSharingATimestamp(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()

	// Insert directly so every row has the identical `at`; the id breaks ties.
	_, err := pool.Exec(ctx, `INSERT INTO audit_events (at, actor_ip, action)
		SELECT '2026-01-01T00:00:00Z', '192.0.2.1', 's' || g FROM generate_series(1, 5) g`)
	require.NoError(t, err)

	q := db.New(pool)
	seen := map[uuid.UUID]bool{}
	cursor := ""
	for range 10 {
		page, next, err := audit.List(ctx, q, audit.Filter{Limit: 2, Cursor: cursor})
		require.NoError(t, err)
		for _, e := range page {
			require.False(t, seen[e.ID], "duplicate entry across pages")
			seen[e.ID] = true
		}
		cursor = next
		if cursor == "" {
			break
		}
	}
	require.Len(t, seen, 5)
}

func TestListLimitDefaultsAndCaps(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)

	_, err := pool.Exec(ctx, `INSERT INTO audit_events (actor_ip, action)
		SELECT '192.0.2.1', 'bulk' FROM generate_series(1, 260)`)
	require.NoError(t, err)

	got, next, err := audit.List(ctx, q, audit.Filter{})
	require.NoError(t, err)
	require.Len(t, got, 50)
	require.NotEmpty(t, next)

	got, next, err = audit.List(ctx, q, audit.Filter{Limit: 1000})
	require.NoError(t, err)
	require.Len(t, got, 200)
	require.NotEmpty(t, next)
}

func TestListRejectsBadCursor(t *testing.T) {
	pool := store.NewTestDB(t)
	_, _, err := audit.List(context.Background(), db.New(pool), audit.Filter{Cursor: "!!not-a-cursor"})
	require.ErrorIs(t, err, audit.ErrInvalidCursor)
}

func TestRecordRollsBackWithTx(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()

	boom := errors.New("boom")
	err := store.Tx(ctx, pool, func(q *db.Queries) error {
		if err := audit.Record(ctx, q, ev("x")); err != nil {
			return err
		}
		return boom
	})
	require.ErrorIs(t, err, boom)

	got, _, err := audit.List(ctx, db.New(pool), audit.Filter{})
	require.NoError(t, err)
	require.Empty(t, got)
}
