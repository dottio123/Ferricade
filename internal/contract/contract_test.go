package contract_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/contract"
)

func TestDerivedFixturesHaveNoFindings(t *testing.T) {
	fs, err := contract.LoadDir("../../testdata/contracts/derived-1.5.0")
	require.NoError(t, err)
	require.Len(t, fs, 21)
	for _, f := range fs {
		assert.Empty(t, contract.Check(f), "%s %s (%s)", f.Method, f.Path, f.Ref)
	}
}

func TestCapturedFixturesReport(t *testing.T) {
	fs, err := contract.LoadDir("../../testdata/contracts/captured")
	require.NoError(t, err)
	for _, f := range fs {
		for _, fd := range contract.Check(f) {
			switch fd.Kind {
			case contract.TypeMismatch, contract.MissingField:
				t.Errorf("client %s: %+v", f.ClientVersion, fd)
			default:
				t.Logf("client %s: %+v", f.ClientVersion, fd)
			}
		}
	}
}

func heartbeat(body string) contract.Fixture {
	return contract.Fixture{Method: "POST", Path: "/api/heartbeat", Body: json.RawMessage(body)}
}

func TestCheckReportsUnknownField(t *testing.T) {
	got := contract.Check(heartbeat(`{"id":"1","uuid":"u","ver":1,"modified_at":0,"x":1}`))
	assert.Equal(t, []contract.Finding{{Path: "/api/heartbeat", Field: "x", Kind: contract.UnknownField}}, got)
}

func TestCheckReportsMissingField(t *testing.T) {
	got := contract.Check(heartbeat(`{"uuid":"u","ver":1}`))
	assert.Equal(t, []contract.Finding{{Path: "/api/heartbeat", Field: "id", Kind: contract.MissingField}}, got)
}

func TestCheckReportsTypeMismatch(t *testing.T) {
	got := contract.Check(heartbeat(`{"id":"1","uuid":"u","ver":"1.5.0"}`))
	require.Len(t, got, 1)
	assert.Equal(t, contract.TypeMismatch, got[0].Kind)
}

func TestCheckReportsNoRoute(t *testing.T) {
	got := contract.Check(contract.Fixture{Method: "POST", Path: "/api/brand-new"})
	assert.Equal(t, []contract.Finding{{Path: "/api/brand-new", Kind: contract.NoRoute}}, got)
}

func TestCheckRequiresUserInfoInAuthResponse(t *testing.T) {
	f := contract.Fixture{Method: "GET", Path: "/api/oidc/auth-query",
		Response: json.RawMessage(`{"access_token":"t","type":"access_token","user":{"name":"a"}}`)}
	got := contract.Check(f)
	assert.Contains(t, got, contract.Finding{Path: "/api/oidc/auth-query", Field: "response.user.info", Kind: contract.MissingField})
}

func TestCheckAcceptsErrorResponse(t *testing.T) {
	f := contract.Fixture{Method: "GET", Path: "/api/oidc/auth-query", Response: json.RawMessage(`{"error":"No authed oidc is found"}`)}
	assert.Empty(t, contract.Check(f))
}

func TestCheckAllowsSysinfoPresets(t *testing.T) {
	f := contract.Fixture{Method: "POST", Path: "/api/sysinfo", Body: json.RawMessage(`{"id":"1","uuid":"u","preset-device-group-name":"Ops"}`)}
	assert.Empty(t, contract.Check(f))
}

func TestLoadDirReadsJSONL(t *testing.T) {
	dir := t.TempDir()
	line := `{"source":"captured","client_version":"1.5.0","method":"POST","path":"/api/heartbeat"}`
	require.NoError(t, os.WriteFile(filepath.Join(dir, "a.jsonl"), []byte(line+"\n"+line+"\n"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "README.md"), []byte("ignored"), 0o600))
	fs, err := contract.LoadDir(dir)
	require.NoError(t, err)
	assert.Len(t, fs, 2)
}

func TestLoadDirReportsBadLine(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "a.jsonl"), []byte("{oops\n"), 0o600))
	_, err := contract.LoadDir(dir)
	require.ErrorContains(t, err, "a.jsonl:1")
}
