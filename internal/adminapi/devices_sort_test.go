package adminapi

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/store/db"
)

func TestDeviceSortPaging(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	c, _ := e.signedIn("sort-owner", "owner")
	ctx := context.Background()
	other, err := db.New(e.d.Pool).CreateServer(ctx, db.CreateServerParams{Name: "other", IDHost: "other.example.com", RelayHost: "other.example.com", PublicKey: validKey})
	require.NoError(t, err)
	groups := []string{
		c.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "Alpha"})["id"].(string),
		c.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "beta"})["id"].(string),
	}
	rows := []struct {
		rd, alias, host, os, state string
		group                      int
	}{
		{"107", "Zulu", "ignored", "Windows", "approved", 1},
		{"102", "apple", "ignored", "Linux", "pending", 0},
		{"103", "", "APPLE", "linux", "approved", 0},
		{"104", "", "Yak", "", "rejected", -1},
		{"105", "zeta", "ignored", "windows", "archived", 1},
		{"106", "", "", "", "archived", -1},
		{"102", "Apple", "ignored", "Linux", "approved", -1},
	}
	ids := make([]string, len(rows))
	for i, row := range rows {
		server := srv.ID
		if i == 6 {
			server = other.ID
		}
		ids[i] = fmt.Sprintf("00000000-0000-4000-8000-%012d", i+1)
		var group *string
		if row.group >= 0 {
			group = &groups[row.group]
		}
		_, err := e.d.Pool.Exec(ctx, `INSERT INTO devices (id, server_id, rustdesk_id, uuid, alias, hostname, os, state, group_id) VALUES ($1,$2,$3,'test',$4,$5,$6,$7,$8)`, ids[i], server, row.rd, row.alias, row.host, row.os, row.state, group)
		require.NoError(t, err)
	}
	_, err = e.d.Pool.Exec(ctx, `INSERT INTO device_alerts (device_id, kind, details) VALUES ($1,'uuid_mismatch','{}')`, ids[0])
	require.NoError(t, err)
	e.clock.Add(time.Minute)
	e.d.Tracker.Beat("103", nil)
	paged := func(t *testing.T, who *client, query string) []string {
		t.Helper()
		var got []string
		cursor := ""
		for page := 0; ; page++ {
			require.Less(t, page, 10, "paging must terminate")
			body := who.ok(http.MethodGet, apiPrefix+"/devices?limit=2&"+query+"&cursor="+url.QueryEscape(cursor), nil)
			for _, d := range items(t, body) {
				got = append(got, d["id"].(string))
			}
			cursor = body["next_cursor"].(string)
			if cursor == "" {
				return got
			}
		}
	}
	expected := map[string][]int{
		"rustdesk_id": {1, 6, 2, 3, 4, 5, 0},
		"name":        {5, 1, 6, 2, 3, 4, 0},
		"status":      {0, 1, 2, 6, 3, 4, 5},
		"state":       {1, 6, 2, 0, 3, 4, 5},
		"os":          {1, 6, 2, 4, 0, 3, 5},
		"group":       {1, 2, 4, 0, 6, 3, 5},
	}
	for key, indices := range expected {
		for _, order := range []string{"asc", "desc"} {
			t.Run(key+"/"+order, func(t *testing.T) {
				want := make([]string, len(indices))
				for i, index := range indices {
					want[i] = ids[index]
				}
				if order == "desc" {
					slices.Reverse(want)
				}
				require.Equal(t, want, paged(t, c, "sort="+key+"&order="+order))
			})
		}
	}
	t.Run("default", func(t *testing.T) { require.Equal(t, paged(t, c, "sort=rustdesk_id&order=asc"), paged(t, c, "")) })
	t.Run("invalid", func(t *testing.T) {
		for _, query := range []string{"sort=unknown", "order=up", "sort=", "order="} {
			requireError(t, c.do(http.MethodGet, apiPrefix+"/devices?"+query, nil), 400, codeBadRequest)
		}
	})
	t.Run("cursor binding", func(t *testing.T) {
		cursor := c.ok(http.MethodGet, apiPrefix+"/devices?sort=name&limit=2", nil)["next_cursor"].(string)
		for _, query := range []string{"sort=os", "sort=name&order=desc", "sort=name&state=approved"} {
			res := c.do(http.MethodGet, apiPrefix+"/devices?"+query+"&cursor="+url.QueryEscape(cursor), nil)
			requireError(t, res, 400, codeBadRequest)
			if query != "sort=name&state=approved" {
				require.Contains(t, res.Body.String(), "cursor does not match sort")
			}
		}
	})
	t.Run("User hidden groups", func(t *testing.T) {
		user, userID := e.signedIn("sort-user", "user")
		// The hidden beta group sorts with ungrouped devices, even though its
		// name would otherwise precede their missing group names.
		for _, id := range ids {
			_, err := e.d.Pool.Exec(ctx, `UPDATE devices SET state='approved' WHERE id=$1`, id)
			require.NoError(t, err)
		}
		c.ok(http.MethodPut, apiPrefix+"/users/"+userID.String()+"/grants", map[string]any{"group_ids": []string{groups[0]}, "device_ids": ids})
		want := []string{ids[1], ids[2], ids[6], ids[3], ids[4], ids[5], ids[0]}
		require.Equal(t, want, paged(t, user, "sort=group"))
		slices.Reverse(want)
		require.Equal(t, want, paged(t, user, "sort=group&order=desc"))
		for _, d := range items(t, user.ok(http.MethodGet, apiPrefix+"/devices?sort=group&limit=200", nil)) {
			if d["id"] == ids[0] || d["id"] == ids[4] {
				require.Nil(t, d["group_id"])
			}
		}
	})
}
