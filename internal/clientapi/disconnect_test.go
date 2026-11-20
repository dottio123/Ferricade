package clientapi_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHeartbeatDeliversDisconnect(t *testing.T) {
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	h, pool := auditRoutes(t, &now)
	fx := auditFixtures(t)
	f := fx["new"]
	_, err := pool.Exec(context.Background(), `UPDATE devices SET state = 'approved' WHERE rustdesk_id = '123456789'`)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, do(h, f.Method, f.Path, string(f.Body)).Code) // conn 3

	beat := func(_, body string) string {
		rec := do(h, http.MethodPost, "/api/heartbeat", body)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		return rec.Body.String()
	}
	const dev = `{"id":"123456789","uuid":"ZmFrZS11dWlk","conns":[3]}`
	assert.NotContains(t, beat("", dev), "disconnect", "nothing requested")

	_, err = pool.Exec(context.Background(),
		`UPDATE remote_sessions SET disconnect_requested_at = $1 WHERE conn_id = 3`, now)
	require.NoError(t, err)

	assert.Contains(t, beat("", dev), `"disconnect":[3]`)
	assert.NotContains(t, beat("", `{"id":"123456789","uuid":"ZmFrZS11dWlk","conns":[4]}`), "disconnect",
		"the conn is no longer reported")
	assert.NotContains(t, beat("", `{"id":"123456789","uuid":"ZmFrZS11dWlk"}`), "disconnect")

	// Another device with the same conn_id is not told to disconnect.
	require.Equal(t, http.StatusOK, do(h, http.MethodPost, "/api/heartbeat", `{"id":"222222222","uuid":"b3RoZXI="}`).Code)
	assert.NotContains(t, beat("", `{"id":"222222222","uuid":"b3RoZXI=","conns":[3]}`), "disconnect")

	c := fx["close"]
	require.Equal(t, http.StatusOK, do(h, c.Method, c.Path, string(c.Body)).Code)
	assert.NotContains(t, beat("", dev), "disconnect", "the session ended")
	assert.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM remote_sessions WHERE end_reason = 'disconnected'`))
}
