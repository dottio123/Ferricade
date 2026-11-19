package adminapi

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestLogExportSyslogTestEndpoint(t *testing.T) {
	e := newEnv(t, func(d *Deps) { d.Cfg.LogExportDir = t.TempDir() })
	e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	admin, _ := e.signedIn("admin", "admin")
	path := logExportPath + "/test"
	requireError(t, admin.do(http.MethodPost, path, map[string]string{"output": "syslog"}), http.StatusForbidden, codeForbidden)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	port := ln.Addr().(*net.TCPAddr).Port
	input := logExportInput()
	syslog := input["syslog"].(map[string]any)
	syslog["host"] = "127.0.0.1"
	syslog["port"] = port
	syslog["tls"] = false
	owner.ok(http.MethodPut, logExportPath, input)
	got := make(chan string, 1)
	go func() {
		_ = ln.(*net.TCPListener).SetDeadline(time.Now().Add(5 * time.Second))
		c, e := ln.Accept()
		if e != nil {
			return
		}
		defer c.Close()
		_ = c.SetDeadline(time.Now().Add(5 * time.Second))
		r := bufio.NewReader(c)
		n, e := r.ReadString(' ')
		if e != nil {
			return
		}
		length, e := strconv.Atoi(strings.TrimSpace(n))
		if e != nil {
			return
		}
		msg := make([]byte, length)
		if _, e = io.ReadFull(r, msg); e == nil {
			got <- string(msg)
		}
	}()
	result := owner.ok(http.MethodPost, path, map[string]string{"output": "syslog"})
	require.Equal(t, true, result["ok"])
	require.Nil(t, result["error"])
	select {
	case msg := <-got:
		require.Contains(t, msg, "ferricade.test")
	case <-time.After(10 * time.Second):
		t.Fatal("no syslog test event received")
	}
	require.NoError(t, ln.Close())
	result = owner.ok(http.MethodPost, path, map[string]string{"output": "syslog"})
	require.Equal(t, false, result["ok"])
	require.Contains(t, result["error"], "connect")
}

const logExportPath = apiPrefix + "/settings/log-export"

func logExportInput() map[string]any {
	return map[string]any{"file": map[string]any{"enabled": true}, "syslog": map[string]any{"enabled": false, "host": "", "port": 6514, "tls": true, "ca_pem": "", "facility": "local0", "format": "json"}}
}

func TestLogExportAPI(t *testing.T) {
	dir := t.TempDir()
	e := newEnv(t, func(d *Deps) { d.Cfg.LogExportDir = dir })
	e.markSetupComplete()
	owner, ownerID := e.signedIn("owner", "owner")
	admin, _ := e.signedIn("admin", "admin")
	viewer, _ := e.signedIn("viewer", "user")
	require.Equal(t, http.StatusOK, owner.do(http.MethodGet, logExportPath, nil).Code)
	require.Equal(t, http.StatusOK, admin.do(http.MethodGet, logExportPath, nil).Code)
	for _, c := range []*client{admin, viewer} {
		requireError(t, c.do(http.MethodPut, logExportPath, logExportInput()), http.StatusForbidden, codeForbidden)
		requireError(t, c.do(http.MethodPost, logExportPath+"/test", map[string]string{"output": "file"}), http.StatusForbidden, codeForbidden)
	}
	requireError(t, viewer.do(http.MethodGet, logExportPath, nil), http.StatusForbidden, codeForbidden)
	saved := owner.ok(http.MethodPut, logExportPath, logExportInput())
	require.Equal(t, ownerID.String(), saved["updated_by"].(map[string]any)["id"])
	require.Equal(t, true, saved["settings"].(map[string]any)["file"].(map[string]any)["enabled"])
	entries := e.auditEntries("settings.log_export_updated")
	require.Len(t, entries, 1)
	require.Equal(t, []any{"file.enabled"}, entries[0].Details["fields"])
	owner.ok(http.MethodPut, logExportPath, logExportInput())
	require.Len(t, e.auditEntries("settings.log_export_updated"), 1, "unchanged PUT is not audited")
	test := owner.ok(http.MethodPost, logExportPath+"/test", map[string]string{"output": "file"})
	require.Equal(t, true, test["ok"])
	require.Nil(t, test["error"])
	require.Len(t, e.auditEntries("settings.log_export_updated"), 1, "test event is not audited")
	noHost := owner.ok(http.MethodPost, logExportPath+"/test", map[string]string{"output": "syslog"})
	require.Equal(t, false, noHost["ok"])
	require.Equal(t, "no syslog host set", noHost["error"])
}

func TestLogExportValidation(t *testing.T) {
	e := newEnv(t, func(d *Deps) { d.Cfg.LogExportDir = t.TempDir() })
	e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	bad := []struct {
		name   string
		change func(map[string]any)
		field  string
	}{
		{"host required", func(v map[string]any) { v["syslog"].(map[string]any)["enabled"] = true }, "syslog.host"},
		{"host URL", func(v map[string]any) { v["syslog"].(map[string]any)["host"] = "https://collector" }, "syslog.host"},
		{"PEM", func(v map[string]any) { v["syslog"].(map[string]any)["ca_pem"] = "secret-invalid-cert" }, "syslog.ca_pem"},
		{"port", func(v map[string]any) { v["syslog"].(map[string]any)["port"] = 0 }, "syslog.port"},
		{"format", func(v map[string]any) { v["syslog"].(map[string]any)["format"] = "xml" }, "syslog.format"},
		{"nested unknown", func(v map[string]any) { v["syslog"].(map[string]any)["secret"] = "x" }, ""},
	}
	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			input := logExportInput()
			tc.change(input)
			rec := owner.do(http.MethodPut, logExportPath, input)
			requireError(t, rec, http.StatusBadRequest, codeBadRequest)
			if tc.field != "" {
				require.True(t, strings.Contains(rec.Body.String(), tc.field), rec.Body.String())
			}
		})
	}
	require.Empty(t, e.auditEntries("settings.log_export_updated"))
}

func TestLogExportCAPEMLength(t *testing.T) {
	e := newEnv(t, func(d *Deps) { d.Cfg.LogExportDir = t.TempDir() })
	e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	input := logExportInput()
	ca := testLogExportCA(t)
	input["syslog"].(map[string]any)["ca_pem"] = ca + strings.Repeat(" ", 32768-len(ca))
	require.Equal(t, http.StatusOK, owner.do(http.MethodPut, logExportPath, input).Code)
	input["syslog"].(map[string]any)["ca_pem"] = ca + strings.Repeat(" ", 32769-len(ca))
	res := owner.do(http.MethodPut, logExportPath, input)
	requireError(t, res, http.StatusBadRequest, codeBadRequest)
	require.Contains(t, res.Body.String(), "syslog.ca_pem")
}

func testLogExportCA(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	cert := &x509.Certificate{SerialNumber: big.NewInt(2), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	require.NoError(t, err)
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

func TestLogExportCSRF(t *testing.T) {
	e := newEnv(t, func(d *Deps) { d.Cfg.LogExportDir = t.TempDir() })
	e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	owner.csrf = ""
	requireError(t, owner.do(http.MethodPut, logExportPath, logExportInput()), http.StatusForbidden, codeCSRF)
	requireError(t, owner.do(http.MethodPost, logExportPath+"/test", map[string]string{"output": "file"}), http.StatusForbidden, codeCSRF)
	require.Empty(t, e.auditEntries("settings.log_export_updated"))
}

func TestLogExportAuditFieldNames(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	require.NoError(t, err)
	ca := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	e := newEnv(t, func(d *Deps) { d.Cfg.LogExportDir = t.TempDir() })
	e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	input := logExportInput()
	syslog := input["syslog"].(map[string]any)
	syslog["host"] = "collector.example.com"
	syslog["ca_pem"] = ca
	owner.ok(http.MethodPut, logExportPath, input)
	entries := e.auditEntries("settings.log_export_updated")
	require.Len(t, entries, 1)
	require.Equal(t, []any{"file.enabled", "syslog.ca_pem", "syslog.host"}, entries[0].Details["fields"])
	raw, err := json.Marshal(entries[0].Details)
	require.NoError(t, err)
	require.NotContains(t, string(raw), ca)
}
