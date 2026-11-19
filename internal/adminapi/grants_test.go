package adminapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/store/db"
)

func TestUserGrantsReplace(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	owner, ownerID := e.signedIn("alice", "owner")
	_, viewerID := e.signedIn("viewer", "user")
	admin, adminID := e.signedIn("bob", "admin")
	path := apiPrefix + "/users/" + viewerID.String() + "/grants"
	group := owner.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "Granted"})["id"].(string)
	deviceID := e.enroll(srv, "900000001")
	owner.ok(http.MethodPost, apiPrefix+"/devices/"+deviceID.String()+"/approve", nil)

	rec := owner.do(http.MethodPut, path, map[string]any{"group_ids": []string{group}, "device_ids": []string{deviceID.String()}})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, []any{group}, decodeBody(t, rec)["group_ids"])
	require.Equal(t, []any{deviceID.String()}, decodeBody(t, rec)["device_ids"])
	require.Equal(t, decodeBody(t, rec), owner.ok(http.MethodGet, path, nil))
	require.Len(t, e.auditEntries("user.grants_updated"), 1)
	require.Equal(t, &ownerID, e.auditEntries("user.grants_updated")[0].ActorUserID)
	require.Equal(t, map[string]any{
		"added_group_ids": []any{group}, "removed_group_ids": []any{},
		"added_device_ids": []any{deviceID.String()}, "removed_device_ids": []any{},
	}, e.auditEntries("user.grants_updated")[0].Details)

	for _, body := range []map[string]any{
		{"group_ids": []string{uuid.NewString()}, "device_ids": []string{}},
		{"group_ids": []string{}, "device_ids": []string{uuid.NewString()}},
		{"group_ids": []string{group, group}, "device_ids": []string{}},
		{"group_ids": []string{}, "device_ids": []string{deviceID.String(), deviceID.String()}},
		{"group_ids": make([]string, 257), "device_ids": []string{}},
		{"group_ids": []string{}, "device_ids": make([]string, 257)},
	} {
		requireError(t, owner.do(http.MethodPut, path, body), http.StatusBadRequest, codeBadRequest)
	}
	require.Len(t, e.auditEntries("user.grants_updated"), 1)
	require.Equal(t, []any{group}, owner.ok(http.MethodGet, path, nil)["group_ids"])
	requireError(t, owner.do(http.MethodGet, apiPrefix+"/users/"+uuid.NewString()+"/grants", nil), http.StatusNotFound, codeNotFound)
	requireError(t, owner.do(http.MethodPut, apiPrefix+"/users/"+uuid.NewString()+"/grants", emptyGrants()), http.StatusNotFound, codeNotFound)
	for _, target := range []uuid.UUID{ownerID, adminID} {
		requireError(t, owner.do(http.MethodPut, apiPrefix+"/users/"+target.String()+"/grants", emptyGrants()), http.StatusConflict, codeBadTransition)
		require.Equal(t, []any{}, owner.ok(http.MethodGet, apiPrefix+"/users/"+target.String()+"/grants", nil)["group_ids"])
	}
	requireError(t, admin.do(http.MethodGet, path, nil), http.StatusForbidden, codeForbidden)
	requireError(t, admin.do(http.MethodPut, path, emptyGrants()), http.StatusForbidden, codeForbidden)

	rec = owner.do(http.MethodPut, path, emptyGrants())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, []any{}, decodeBody(t, rec)["group_ids"])
	require.Equal(t, []any{}, decodeBody(t, rec)["device_ids"])
	require.Equal(t, map[string]any{
		"added_group_ids": []any{}, "removed_group_ids": []any{group},
		"added_device_ids": []any{}, "removed_device_ids": []any{deviceID.String()},
	}, e.auditEntries("user.grants_updated")[0].Details)
}

func TestGrantAuditCommitFailureRollsBackGrants(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	owner, _ := e.signedIn("alice", "owner")
	_, viewerID := e.signedIn("viewer", "user")
	group := owner.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "Granted"})["id"].(string)
	ctx := context.Background()
	_, err := e.d.Pool.Exec(ctx, `CREATE FUNCTION fail_grants_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.action = 'user.grants_updated' THEN RAISE EXCEPTION 'forced audit failure'; END IF; RETURN NEW; END $$`)
	require.NoError(t, err)
	_, err = e.d.Pool.Exec(ctx, `CREATE CONSTRAINT TRIGGER fail_grants_audit AFTER INSERT ON audit_events
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_grants_audit()`)
	require.NoError(t, err)
	path := apiPrefix + "/users/" + viewerID.String() + "/grants"
	require.Equal(t, http.StatusInternalServerError, owner.do(http.MethodPut, path,
		map[string]any{"group_ids": []string{group}, "device_ids": []string{}}).Code)
	require.Equal(t, []any{}, owner.ok(http.MethodGet, path, nil)["group_ids"])
	require.Empty(t, e.auditEntries("user.grants_updated"))
}

func TestRoleChangesClearGrantsAndNotify(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	owner, _ := e.signedIn("alice", "owner")
	_, viewerID := e.signedIn("viewer", "user")
	group := owner.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "Granted"})["id"].(string)
	owner.ok(http.MethodPut, apiPrefix+"/users/"+viewerID.String()+"/grants", map[string]any{
		"group_ids": []string{group}, "device_ids": []string{},
	})
	conn, err := e.d.Pool.Acquire(context.Background())
	require.NoError(t, err)
	defer conn.Release()
	_, err = conn.Exec(context.Background(), "LISTEN ferricade_events")
	require.NoError(t, err)
	path := apiPrefix + "/users/" + viewerID.String()
	for _, role := range []string{"admin", "user"} {
		require.Equal(t, role, owner.ok(http.MethodPatch, path, map[string]any{"role": role})["role"])
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		found := false
		for !found {
			n, err := conn.Conn().WaitForNotification(ctx)
			require.NoError(t, err)
			var payload map[string]any
			require.NoError(t, json.Unmarshal([]byte(n.Payload), &payload))
			found = payload["kind"] == "grants" && payload["user_id"] == viewerID.String()
		}
		cancel()
		rows, err := db.New(e.d.Pool).ListUserGrants(context.Background(), viewerID)
		require.NoError(t, err)
		require.Empty(t, rows)
	}
}
