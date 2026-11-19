package devices_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/store/db"
)

func TestApprovalSkipsConcurrentlyDeletedRuleGroup(t *testing.T) {
	f := newFixture(t, 500)
	a := f.actor(t)
	ctx := context.Background()
	g, err := (&devices.Groups{Pool: f.pool}).Create(ctx, a, "Gone", nil)
	require.NoError(t, err)
	f.enroll(t, "rule-race")
	id := f.device(t, "rule-race").ID
	f.svc.GroupPlacement = func(ctx context.Context, _ *db.Queries, _ string) ([]uuid.UUID, string, error) {
		// The rule lookup finishes just before the empty group is deleted.
		_, err := f.pool.Exec(ctx, "DELETE FROM device_groups WHERE id=$1", g.ID)
		return []uuid.UUID{g.ID}, "*", err
	}
	require.NoError(t, f.svc.Transition(ctx, a, id, devices.StateApproved))
	d, err := f.svc.Get(ctx, id)
	require.NoError(t, err)
	require.Equal(t, devices.StateApproved, d.State)
	require.Nil(t, d.GroupID)
}

func TestReapprovalPlacementResolvesConflict(t *testing.T) {
	f := newFixture(t, 500)
	a := f.actor(t)
	ctx := context.Background()
	groups := &devices.Groups{Pool: f.pool}
	first, err := groups.Create(ctx, a, "First", nil)
	require.NoError(t, err)
	second, err := groups.Create(ctx, a, "Second", nil)
	require.NoError(t, err)
	f.enroll(t, "reapprove")
	id := f.device(t, "reapprove").ID
	candidates := []uuid.UUID{first.ID, second.ID}
	f.svc.GroupPlacement = func(context.Context, *db.Queries, string) ([]uuid.UUID, string, error) {
		return candidates, "*", nil
	}
	require.NoError(t, f.svc.Transition(ctx, a, id, devices.StateApproved))
	d, err := f.svc.Get(ctx, id)
	require.NoError(t, err)
	require.Len(t, d.OpenAlerts, 1)
	alertID := d.OpenAlerts[0].ID
	require.NoError(t, f.svc.Transition(ctx, a, id, devices.StatePending))
	candidates = candidates[:1]
	require.NoError(t, f.svc.Transition(ctx, a, id, devices.StateApproved))
	d, err = f.svc.Get(ctx, id)
	require.NoError(t, err)
	require.Equal(t, &first.ID, d.GroupID)
	require.Empty(t, d.OpenAlerts)
	var resolvedBy uuid.UUID
	require.NoError(t, f.pool.QueryRow(ctx, "SELECT resolved_by FROM device_alerts WHERE id=$1 AND resolved_at IS NOT NULL", alertID).Scan(&resolvedBy))
	require.Equal(t, a.UserID, resolvedBy)
}
