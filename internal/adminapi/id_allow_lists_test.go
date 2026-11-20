package adminapi

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestIDAllowListAPI(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	admin, _ := e.signedIn("admin", "admin")
	user, _ := e.signedIn("user", "user")

	global := apiPrefix + "/settings/id-allow-list"
	require.Equal(t, []any{}, owner.ok(http.MethodGet, global, nil)["ids"])
	require.Equal(t, []any{}, admin.ok(http.MethodGet, global, nil)["ids"])
	requireError(t, user.do(http.MethodGet, global, nil), http.StatusForbidden, codeForbidden)
	requireError(t, admin.do(http.MethodPut, global, map[string]any{"ids": []string{"123456"}}), http.StatusForbidden, codeForbidden)
	requireError(t, owner.do(http.MethodPut, global, map[string]any{"ids": []string{"Abc123", "abc123"}}), http.StatusBadRequest, "validation_error")
	requireError(t, owner.do(http.MethodPut, global, map[string]any{"ids": []string{"bad-id"}}), http.StatusBadRequest, "validation_error")
	requireError(t, owner.do(http.MethodPut, global, map[string]any{}), http.StatusBadRequest, "validation_error")
	tooMany := make([]string, 201)
	for i := range tooMany {
		tooMany[i] = fmt.Sprintf("%06d", i)
	}
	requireError(t, owner.do(http.MethodPut, global, map[string]any{"ids": tooMany}), http.StatusBadRequest, "validation_error")
	owner.ok(http.MethodPut, global, map[string]any{"ids": []string{"GLOBAL1", "abc123"}})

	group := owner.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "Allow list"})
	groupID := group["id"].(string)
	child := owner.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "Child", "parent_id": groupID})
	childID := child["id"].(string)
	groupPath := apiPrefix + "/groups/" + groupID + "/id-allow-list"
	childPath := apiPrefix + "/groups/" + childID + "/id-allow-list"
	require.Equal(t, []any{}, admin.ok(http.MethodGet, groupPath, nil)["ids"])
	admin.ok(http.MethodPut, groupPath, map[string]any{"ids": []string{"abc123", "Root_1"}})
	owner.ok(http.MethodPut, childPath, map[string]any{"ids": []string{"child_1", "abc123"}})
	requireError(t, user.do(http.MethodGet, groupPath, nil), http.StatusForbidden, codeForbidden)
	requireError(t, user.do(http.MethodPut, groupPath, map[string]any{"ids": []string{}}), http.StatusForbidden, codeForbidden)
	requireError(t, admin.do(http.MethodGet, apiPrefix+"/groups/"+uuid.NewString()+"/id-allow-list", nil), http.StatusNotFound, codeNotFound)
	requireError(t, admin.do(http.MethodPut, apiPrefix+"/groups/"+uuid.NewString()+"/id-allow-list", map[string]any{"ids": []string{}}), http.StatusNotFound, codeNotFound)

	var deviceID uuid.UUID
	require.NoError(t, e.d.Pool.QueryRow(context.Background(), `INSERT INTO devices (server_id, rustdesk_id, uuid, state, group_id) VALUES ($1, 'device01', 'dXVpZC1h', 'approved', $2) RETURNING id`, srv.ID, uuid.MustParse(childID)).Scan(&deviceID))
	devicePath := apiPrefix + "/devices/" + deviceID.String() + "/id-allow-list"
	admin.ok(http.MethodPut, devicePath, map[string]any{"ids": []string{"DEVICE1", "abc123"}})
	got := admin.ok(http.MethodGet, devicePath, nil)
	require.Equal(t, []any{"DEVICE1", "abc123"}, got["ids"])
	effective := got["effective"].([]any)
	require.Len(t, effective, 7)
	for i, want := range []struct{ id, source string }{
		{"DEVICE1", "device"}, {"GLOBAL1", "global"}, {"Root_1", "group"},
		{"abc123", "device"}, {"abc123", "global"}, {"abc123", "group"}, {"child_1", "group"},
	} {
		row := effective[i].(map[string]any)
		require.Equal(t, want.id, row["id"])
		require.Equal(t, want.source, row["source"])
		if want.source == "group" {
			require.NotNil(t, row["group_id"])
			require.NotNil(t, row["group_name"])
			if want.id == "Root_1" {
				require.Equal(t, groupID, row["group_id"])
				require.Equal(t, "Allow list", row["group_name"])
			} else if want.id == "child_1" {
				require.Equal(t, childID, row["group_id"])
				require.Equal(t, "Child", row["group_name"])
			} else if want.id == "abc123" {
				require.Equal(t, childID, row["group_id"], "same-source duplicates use the nearest group")
				require.Equal(t, "Child", row["group_name"])
			}
		}
	}
	requireError(t, user.do(http.MethodGet, devicePath, nil), http.StatusForbidden, codeForbidden)
	requireError(t, user.do(http.MethodPut, devicePath, map[string]any{"ids": []string{}}), http.StatusForbidden, codeForbidden)
	requireError(t, admin.do(http.MethodGet, apiPrefix+"/devices/"+uuid.NewString()+"/id-allow-list", nil), http.StatusNotFound, codeNotFound)
	requireError(t, admin.do(http.MethodPut, apiPrefix+"/devices/"+uuid.NewString()+"/id-allow-list", map[string]any{"ids": []string{}}), http.StatusNotFound, codeNotFound)

	audits := e.auditEntries("id_allow_list.updated")
	require.Len(t, audits, 4)
	wantScopes := map[string]string{"global": "global", groupID: "group", childID: "group", deviceID.String(): "device"}
	for _, entry := range audits {
		require.Equal(t, "id_allow_list", entry.TargetType)
		require.Equal(t, wantScopes[entry.TargetID], entry.Details["scope"])
		require.Equal(t, entry.TargetID, entry.Details["target_id"])
		require.Contains(t, entry.Details, "before")
		require.Contains(t, entry.Details, "after")
	}
}
