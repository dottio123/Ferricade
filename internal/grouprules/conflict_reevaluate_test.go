package grouprules

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/devices"
)

func TestRemoveRuleReevaluatesOpenConflicts(t *testing.T) {
	for _, tc := range []struct {
		name        string
		third       bool
		secondRule  bool
		wantOpen    bool
		wantUpdated bool
	}{
		{name: "resolve below two"},
		{name: "keep other conflict groups", third: true, wantOpen: true, wantUpdated: true},
		{name: "keep group when another rule matches", secondRule: true, wantOpen: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newSortEnv(t)
			ctx := context.Background()
			a := e.group(t, "A", "w-*-it-*")
			b := e.group(t, "B", "w-sf-*")
			var ruleID uuid.UUID
			require.NoError(t, e.Pool.QueryRow(ctx, `SELECT id FROM group_rules WHERE group_id=$1`, b).Scan(&ruleID))
			if tc.secondRule {
				_, err := e.Pool.Exec(ctx, `INSERT INTO group_rules(group_id,pattern) VALUES($1,'w-*-it-*')`, b)
				require.NoError(t, err)
			}
			groups := []uuid.UUID{a, b}
			if tc.third {
				groups = append(groups, e.group(t, "C", "w-*-it-*"))
			}
			outside := e.group(t, "Outside", "*")
			deviceID := e.device(t, "w-sf-it-1", "pending", nil)
			details, err := json.Marshal(map[string]any{"group_ids": groups})
			require.NoError(t, err)
			_, err = e.Pool.Exec(ctx, `INSERT INTO device_alerts(device_id,kind,details) VALUES($1,'group_conflict',$2)`, deviceID, details)
			require.NoError(t, err)
			unaffectedID := e.device(t, "w-sf-it-1", "pending", nil)
			unaffectedDetails, err := json.Marshal(map[string]any{"group_ids": []uuid.UUID{a, outside}})
			require.NoError(t, err)
			_, err = e.Pool.Exec(ctx, `INSERT INTO device_alerts(device_id,kind,details) VALUES($1,'group_conflict',$2)`, unaffectedID, unaffectedDetails)
			require.NoError(t, err)
			err = e.Remove(ctx, e.a, b, ruleID)
			require.NoError(t, err)
			var open bool
			var got []uuid.UUID
			require.NoError(t, e.Pool.QueryRow(ctx, `SELECT resolved_at IS NULL, ARRAY(SELECT jsonb_array_elements_text(details->'group_ids')::uuid) FROM device_alerts WHERE device_id=$1`, deviceID).Scan(&open, &got))
			require.Equal(t, tc.wantOpen, open)
			if tc.wantOpen && tc.wantUpdated {
				require.ElementsMatch(t, []uuid.UUID{a, groups[2]}, got)
			}
			if tc.wantOpen && !tc.wantUpdated {
				require.ElementsMatch(t, groups, got)
			}
			if !tc.wantOpen {
				require.ElementsMatch(t, groups, got)
			}
			var placement *uuid.UUID
			require.NoError(t, e.Pool.QueryRow(ctx, `SELECT group_id FROM devices WHERE id=$1`, deviceID).Scan(&placement))
			require.Nil(t, placement)
			require.Equal(t, 1, count(t, e.Pool, `SELECT count(*) FROM device_alerts WHERE device_id=$1 AND resolved_at IS NULL AND details->'group_ids' ? $2`, unaffectedID, outside.String()))
			var auditRaw []byte
			require.NoError(t, e.Pool.QueryRow(ctx, `SELECT details FROM audit_events WHERE action='group.rule_removed'`).Scan(&auditRaw))
			var auditDetails map[string]any
			require.NoError(t, json.Unmarshal(auditRaw, &auditDetails))
			if tc.wantUpdated {
				require.Equal(t, []any{deviceID.String()}, auditDetails["conflicts_updated"])
			}
			if !tc.wantOpen {
				require.Equal(t, []any{deviceID.String()}, auditDetails["conflicts_resolved"])
				require.NotContains(t, auditDetails, "conflicts_updated")
			}
		})
	}
}

func TestDeleteGroupReevaluatesPendingConflict(t *testing.T) {
	e := newSortEnv(t)
	ctx := context.Background()
	a := e.group(t, "A", "w-*-it-*")
	b := e.group(t, "B", "")
	deviceID := e.device(t, "w-sf-it-1", "pending", nil)
	details, err := json.Marshal(map[string]any{"group_ids": []uuid.UUID{a, b}})
	require.NoError(t, err)
	_, err = e.Pool.Exec(ctx, `INSERT INTO device_alerts(device_id,kind,details) VALUES($1,'group_conflict',$2)`, deviceID, details)
	require.NoError(t, err)
	require.NoError(t, (&devices.Groups{Pool: e.Pool}).Delete(ctx, e.a, b))
	require.Equal(t, 1, count(t, e.Pool, `SELECT count(*) FROM device_alerts WHERE device_id=$1 AND resolved_at IS NOT NULL AND resolved_by=$2`, deviceID, e.a.UserID))
	var raw []byte
	require.NoError(t, e.Pool.QueryRow(ctx, `SELECT details FROM audit_events WHERE action='group.deleted'`).Scan(&raw))
	var auditDetails map[string]any
	require.NoError(t, json.Unmarshal(raw, &auditDetails))
	require.Equal(t, []any{deviceID.String()}, auditDetails["conflicts_resolved"])
}
