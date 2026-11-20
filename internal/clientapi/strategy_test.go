package clientapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/clientapi"
	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/policies"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

func strategyRoutes(t *testing.T) (http.Handler, *pgxpool.Pool, uuid.UUID, *policies.Service) {
	t.Helper()
	pool := store.NewTestDB(t)
	server, err := db.New(pool).CreateServer(context.Background(), db.CreateServerParams{
		Name: "lab", IDHost: "rd.example.com", RelayHost: "rd.example.com",
		PublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
	})
	require.NoError(t, err)
	policy := &policies.Service{Pool: pool}
	h := clientapi.Routes(clientapi.Deps{
		Devices:  &devices.Service{Pool: pool, Beats: devices.NewTracker(time.Now), MaxPending: 100},
		Policies: policy, Setup: setupState{server.ID, true},
	})
	return h, pool, server.ID, policy
}

func strategyDevice(t *testing.T, pool *pgxpool.Pool, server uuid.UUID, id, state string) uuid.UUID {
	t.Helper()
	var device uuid.UUID
	require.NoError(t, pool.QueryRow(context.Background(),
		`INSERT INTO devices (server_id, rustdesk_id, uuid, state) VALUES ($1, $2, 'ZmFrZQ==', $3) RETURNING id`,
		server, id, state).Scan(&device))
	return device
}

func strategyReply(t *testing.T, h http.Handler, id, devUUID string, reported int64) map[string]json.RawMessage {
	t.Helper()
	body, err := json.Marshal(map[string]any{"id": id, "uuid": devUUID, "modified_at": reported})
	require.NoError(t, err)
	rec := do(h, http.MethodPost, "/api/heartbeat", string(body))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var reply map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &reply))
	return reply
}

func TestHeartbeatStrategyOnlyForApprovedTrustedDevice(t *testing.T) {
	h, pool, server, _ := strategyRoutes(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `UPDATE client_policy_settings SET push_enabled = true`)
	require.NoError(t, err)
	for _, state := range []string{"pending", "rejected", "archived"} {
		strategyDevice(t, pool, server, state, state)
	}
	strategyDevice(t, pool, server, "wrong-uuid", "approved")
	strategyDevice(t, pool, server, "push-off", "approved")
	for _, tc := range []struct{ id, devUUID string }{
		{"pending", "ZmFrZQ=="}, {"rejected", "ZmFrZQ=="}, {"archived", "ZmFrZQ=="},
		{"wrong-uuid", "b3RoZXI="}, {"unknown", "ZmFrZQ=="},
	} {
		t.Run(tc.id, func(t *testing.T) {
			reply := strategyReply(t, h, tc.id, tc.devUUID, 0)
			require.NotContains(t, reply, "strategy")
			require.NotContains(t, reply, "modified_at")
		})
	}
	_, err = pool.Exec(ctx, `UPDATE client_policy_settings SET push_enabled = false`)
	require.NoError(t, err)
	reply := strategyReply(t, h, "push-off", "ZmFrZQ==", 0)
	require.NotContains(t, reply, "strategy")
	require.NotContains(t, reply, "modified_at")
}

func TestHeartbeatStrategyApprovedDevice(t *testing.T) {
	h, pool, server, _ := strategyRoutes(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `UPDATE client_policy_settings SET push_enabled = true`)
	require.NoError(t, err)
	plain := strategyDevice(t, pool, server, "plain", "approved")
	reply := strategyReply(t, h, "plain", "ZmFrZQ==", 0)
	var got struct {
		ConfigOptions policies.Settings `json:"config_options"`
	}
	require.NoError(t, json.Unmarshal(reply["strategy"], &got))
	want := policies.DefaultSettings()
	want["id-whitelist"] = ""
	require.Equal(t, want, got.ConfigOptions)
	var version int64
	require.NoError(t, json.Unmarshal(reply["modified_at"], &version))
	require.Equal(t, policies.Version(got.ConfigOptions), version)
	var seen *int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT strategy_version_seen FROM devices WHERE id = $1`, plain).Scan(&seen))
	zero := int64(0)
	require.Equal(t, &zero, seen)

	grouped := strategyDevice(t, pool, server, "grouped", "approved")
	var group uuid.UUID
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO client_policies (name, settings) VALUES ('Group', '{"approve-mode":"click","verification-method":"use-temporary-password","enable-file-transfer":"N"}') RETURNING id`).Scan(&group))
	var groupID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO device_groups (name, policy_id) VALUES ('Group', $1) RETURNING id`, group).Scan(&groupID))
	_, err = pool.Exec(ctx, `UPDATE devices SET group_id = $1 WHERE id = $2`, groupID, grouped)
	require.NoError(t, err)
	reply = strategyReply(t, h, "grouped", "ZmFrZQ==", 0)
	require.NoError(t, json.Unmarshal(reply["strategy"], &got))
	require.Equal(t, "N", got.ConfigOptions["enable-file-transfer"])
	require.Equal(t, "custom", got.ConfigOptions["access-mode"])
}

func TestHeartbeatStrategyNeverSendsNonCatalogKeys(t *testing.T) {
	h, pool, server, _ := strategyRoutes(t)
	strategyDevice(t, pool, server, "filtered", "approved")
	_, err := pool.Exec(context.Background(), `UPDATE client_policy_settings SET push_enabled = true`)
	require.NoError(t, err)
	_, err = pool.Exec(context.Background(), `UPDATE client_policies SET settings = '{"approve-mode":"click","verification-method":"use-both-passwords","custom-rendezvous-server":"evil.example","api-server":"http://evil"}' WHERE is_default`)
	require.NoError(t, err)
	reply := strategyReply(t, h, "filtered", "ZmFrZQ==", 0)
	var got struct {
		ConfigOptions policies.Settings `json:"config_options"`
	}
	require.NoError(t, json.Unmarshal(reply["strategy"], &got))
	require.Equal(t, policies.Settings{"approve-mode": "click", "verification-method": "use-both-passwords", "id-whitelist": ""}, got.ConfigOptions)
}

func TestHeartbeatReportsVersionSeen(t *testing.T) {
	h, pool, server, _ := strategyRoutes(t)
	id := strategyDevice(t, pool, server, "versions", "approved")
	_, err := pool.Exec(context.Background(), `UPDATE client_policy_settings SET push_enabled = true`)
	require.NoError(t, err)
	v := policies.Version(policies.DefaultSettings())
	strategyReply(t, h, "versions", "ZmFrZQ==", v)
	var seen *int64
	var xmin string
	require.NoError(t, pool.QueryRow(context.Background(), `SELECT strategy_version_seen, xmin::text FROM devices WHERE id = $1`, id).Scan(&seen, &xmin))
	require.Equal(t, &v, seen)
	strategyReply(t, h, "versions", "ZmFrZQ==", v)
	var after string
	require.NoError(t, pool.QueryRow(context.Background(), `SELECT xmin::text FROM devices WHERE id = $1`, id).Scan(&after))
	require.Equal(t, xmin, after)
}

func TestHeartbeatWindowOverlayAndBoundary(t *testing.T) {
	h, pool, server, policy := strategyRoutes(t)
	id := strategyDevice(t, pool, server, "window", "approved")
	_, err := pool.Exec(context.Background(), `UPDATE client_policy_settings SET push_enabled = true`)
	require.NoError(t, err)
	_, err = pool.Exec(context.Background(), `UPDATE client_policies SET settings = '{"approve-mode":"click","verification-method":"use-temporary-password"}' WHERE is_default`)
	require.NoError(t, err)
	end := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	policy.Now = func() time.Time { return end.Add(-time.Nanosecond) }
	_, err = pool.Exec(context.Background(), `INSERT INTO access_windows (device_id, ends_at) VALUES ($1, $2)`, id, end)
	require.NoError(t, err)
	reply := strategyReply(t, h, "window", "ZmFrZQ==", 0)
	var got struct {
		ConfigOptions policies.Settings `json:"config_options"`
	}
	require.NoError(t, json.Unmarshal(reply["strategy"], &got))
	require.Equal(t, "password-click", got.ConfigOptions["approve-mode"])
	require.Equal(t, "use-both-passwords", got.ConfigOptions["verification-method"])
	policy.Now = func() time.Time { return end }
	reply = strategyReply(t, h, "window", "ZmFrZQ==", 0)
	require.NoError(t, json.Unmarshal(reply["strategy"], &got))
	require.Equal(t, "click", got.ConfigOptions["approve-mode"])
	require.Equal(t, "use-temporary-password", got.ConfigOptions["verification-method"])
}

func TestHeartbeatWindowWithoutEndStaysOpen(t *testing.T) {
	h, pool, server, policy := strategyRoutes(t)
	id := strategyDevice(t, pool, server, "window-no-end", "approved")
	ctx := context.Background()
	_, err := pool.Exec(ctx, `UPDATE client_policy_settings SET push_enabled = true`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE client_policies SET settings = '{"approve-mode":"click","verification-method":"use-temporary-password"}' WHERE is_default`)
	require.NoError(t, err)
	policy.Now = func() time.Time { return time.Date(2027, 10, 17, 12, 0, 0, 0, time.UTC) }
	_, err = pool.Exec(ctx, `INSERT INTO access_windows (device_id, ends_at) VALUES ($1, NULL)`, id)
	require.NoError(t, err)
	reply := strategyReply(t, h, "window-no-end", "ZmFrZQ==", 0)
	var got struct {
		ConfigOptions policies.Settings `json:"config_options"`
	}
	require.NoError(t, json.Unmarshal(reply["strategy"], &got))
	want := policies.DefaultSettings()
	want["id-whitelist"] = ""
	require.Equal(t, want, got.ConfigOptions)

	_, err = pool.Exec(ctx, `UPDATE access_windows SET closed_at = $2, close_reason = 'manual' WHERE device_id = $1`, id, policy.Now())
	require.NoError(t, err)
	reply = strategyReply(t, h, "window-no-end", "ZmFrZQ==", 0)
	require.NoError(t, json.Unmarshal(reply["strategy"], &got))
	require.Equal(t, policies.Settings{"approve-mode": "click", "verification-method": "use-temporary-password", "id-whitelist": ""}, got.ConfigOptions)
}

func TestHeartbeatStrategyIncludesIDAllowListUnionAndVersion(t *testing.T) {
	_, pool, server, policy := strategyRoutes(t)
	ctx := context.Background()
	device := strategyDevice(t, pool, server, "allowlist", "approved")
	var root, child uuid.UUID
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO device_groups (name) VALUES ('Root') RETURNING id`).Scan(&root))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO device_groups (name, parent_id) VALUES ('Child', $1) RETURNING id`, root).Scan(&child))
	_, err := pool.Exec(ctx, `UPDATE devices SET group_id = $1 WHERE id = $2`, child, device)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE client_policy_settings SET push_enabled = true`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE global_id_allow_list SET ids = $1 WHERE id = true`, []string{"ABC123", "GLB001"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE device_groups SET id_allow_list = $1 WHERE id = $2`, []string{"abc123", "ROOT01"}, root)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE device_groups SET id_allow_list = $1 WHERE id = $2`, []string{"CHILD1"}, child)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE devices SET id_allow_list = $1 WHERE id = $2`, []string{"child1", "DEV001"}, device)
	require.NoError(t, err)

	strategy, version, err := policy.Strategy(ctx, server, "allowlist", "ZmFrZQ==", 0)
	require.NoError(t, err)
	require.Equal(t, "ABC123,GLB001,ROOT01,CHILD1,DEV001", strategy.ConfigOptions["id-whitelist"])
	require.NotZero(t, version)
	_, err = pool.Exec(ctx, `UPDATE device_groups SET id_allow_list = $1 WHERE id = $2`, []string{"CHANGED1"}, child)
	require.NoError(t, err)
	_, nextVersion, err := policy.Strategy(ctx, server, "allowlist", "ZmFrZQ==", *version)
	require.NoError(t, err)
	require.NotEqual(t, *version, *nextVersion)

	_, err = pool.Exec(ctx, `UPDATE global_id_allow_list SET ids = '{}' WHERE id = true`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE device_groups SET id_allow_list = '{}'`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE devices SET id_allow_list = '{}' WHERE id = $1`, device)
	require.NoError(t, err)
	strategy, _, err = policy.Strategy(ctx, server, "allowlist", "ZmFrZQ==", 0)
	require.NoError(t, err)
	require.Equal(t, "", strategy.ConfigOptions["id-whitelist"])
}
