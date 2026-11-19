package clientapi_test

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/clientapi"
	"github.com/dottio123/ferricade/internal/sessions"
)

// warnings returns the WARN records in logs, oldest first.
func warnings(t *testing.T, logs *bytes.Buffer) []map[string]any {
	t.Helper()
	var out []map[string]any
	dec := json.NewDecoder(bytes.NewReader(logs.Bytes()))
	for dec.More() {
		var r map[string]any
		require.NoError(t, dec.Decode(&r))
		if r["level"] == "WARN" {
			out = append(out, r)
		}
	}
	return out
}

// Rejected audit/conn posts are logged at WARN, once per reason per 10 s,
// with the reason and the RustDesk ID when the body names one, and never the
// uuid, the nonce or the body.
func TestAuditConnRejectionsLogged(t *testing.T) {
	var logs bytes.Buffer
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	h := clientapi.Routes(clientapi.Deps{
		Sessions: &sessions.Service{}, // never reached: every post here is refused first
		Setup:    setupState{uuid.New(), true},
		Log:      slog.New(slog.NewJSONHandler(&logs, nil)),
		Now:      func() time.Time { return now },
	})
	const secretUUID, secretNonce = "U0VDUkVULVVVSUQ=", "secret-nonce-value"
	longNonce := strings.Repeat("q", sessions.MaxNonceLen+1)
	cases := []struct{ reason, rustdeskID, body string }{
		{"bad_json", "", `{"id":"123456789","uuid":"` + secretUUID + `","nonce":"` + secretNonce + `"`},
		{"missing_id", "", `{"uuid":"` + secretUUID + `","conn_id":3,"nonce":"` + secretNonce + `"}`},
		{"missing_uuid", "123456789", `{"id":"123456789","conn_id":3,"nonce":"` + secretNonce + `"}`},
		{"missing_nonce", "123456789", `{"id":"123456789","uuid":"` + secretUUID + `","conn_id":3}`},
		{"nonce_too_long", "123456789", `{"id":"123456789","uuid":"` + secretUUID + `","conn_id":3,"nonce":"` + longNonce + `"}`},
		{"nul", "123456789", `{"id":"123456789","uuid":"` + secretUUID + `","conn_id":3,"nonce":"` + secretNonce + `","peer":["9\u00009","bob"]}`},
	}
	post := func() {
		for _, c := range cases {
			rec := do(h, http.MethodPost, "/api/audit/conn", c.body)
			require.Equal(t, http.StatusBadRequest, rec.Code, c.body)
		}
	}
	check := func(got []map[string]any, suppressed float64) {
		t.Helper()
		require.Len(t, got, len(cases), logs.String())
		for i, c := range cases {
			r := got[i]
			assert.Equal(t, "client api: rejected audit/conn", r["msg"])
			assert.Equal(t, c.reason, r["reason"])
			if c.rustdeskID == "" {
				assert.NotContains(t, r, "rustdesk_id", c.reason)
			} else {
				assert.Equal(t, c.rustdeskID, r["rustdesk_id"], c.reason)
			}
			assert.Equal(t, suppressed, r["suppressed"], c.reason)
		}
	}

	post()
	first := warnings(t, &logs)
	check(first, 0)

	// The same rejections again within 10 s are not logged, only counted.
	now = now.Add(9 * time.Second)
	post()
	require.Len(t, warnings(t, &logs), len(cases), "repeats within 10 s are not logged")

	now = now.Add(time.Second)
	post()
	all := warnings(t, &logs)
	check(all[len(cases):], 1)

	out := logs.String()
	for _, secret := range []string{secretUUID, secretNonce, longNonce[:32], "bob", `\u0000`} {
		assert.NotContains(t, out, secret)
	}
}
