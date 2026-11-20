package adminapi

import (
	"bytes"
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/dottio123/ferricade/internal/auth"
	"github.com/stretchr/testify/require"
)

func deploymentRequest() map[string]any {
	return map[string]any{
		"installer_source": "github", "client_version": "1.5.0",
		"url_windows": "", "url_deb": "", "url_rpm": "",
		"sha256_windows": "", "sha256_deb": "", "sha256_rpm": "",
		"allow_downgrade": false, "include_install": true,
		"include_password": true, "include_unlock_pin": true, "include_id_allow_list": false,
		"settings": map[string]any{},
	}
}

func TestDeploymentScriptRequiresPublicKey(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	_, err := e.d.Pool.Exec(context.Background(), `UPDATE servers SET public_key = ''`)
	require.NoError(t, err)
	for _, target := range []string{"windows", "linux"} {
		response := owner.do(http.MethodPost, apiPrefix+"/deployment/script", map[string]any{"os": target})
		requireError(t, response, http.StatusBadRequest, codeBadRequest)
		require.Equal(t, "public_key: server public key is required for deployment scripts", decodeBody(t, response)["error"].(map[string]any)["message"])
	}
	require.Empty(t, e.auditEntries("deployment.script_downloaded"))
}

func TestDeploymentProfileAndScript(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	admin, _ := e.signedIn("admin", "admin")
	user, _ := e.signedIn("user", "user")
	path := apiPrefix + "/deployment/profile"
	script := apiPrefix + "/deployment/script"
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		requireError(t, user.do(method, path, deploymentRequest()), http.StatusForbidden, codeForbidden)
	}
	requireError(t, user.do(http.MethodPost, script, map[string]any{"os": "windows"}), http.StatusForbidden, codeForbidden)
	requireError(t, admin.do(http.MethodPut, path, deploymentRequest()), http.StatusForbidden, codeForbidden)
	defaultProfile := owner.ok(http.MethodGet, path, nil)
	require.Equal(t, "github", defaultProfile["installer_source"])
	require.Equal(t, "latest", defaultProfile["client_version"])
	require.Nil(t, defaultProfile["updated_at"])
	require.Equal(t, defaultProfile, admin.ok(http.MethodGet, path, nil))

	put := deploymentRequest()
	put["fleet_password"] = "Password123"
	put["unlock_pin"] = "1234"
	putResponse := owner.do(http.MethodPut, path, put)
	require.Equal(t, http.StatusOK, putResponse.Code, putResponse.Body.String())
	require.NotContains(t, putResponse.Body.String(), "Password123")
	require.NotContains(t, putResponse.Body.String(), "1234")
	get := owner.do(http.MethodGet, path, nil)
	require.Equal(t, http.StatusOK, get.Code)
	require.NotContains(t, get.Body.String(), "Password123")
	require.NotContains(t, get.Body.String(), "1234")
	response := decodeBody(t, get)
	require.True(t, response["password"].(map[string]any)["set"].(bool))
	require.True(t, response["unlock_pin"].(map[string]any)["set"].(bool))

	windows := admin.do(http.MethodPost, script, map[string]any{"os": "windows"})
	require.Equal(t, http.StatusOK, windows.Code, windows.Body.String())
	require.True(t, bytes.HasPrefix(windows.Body.Bytes(), []byte{0xef, 0xbb, 0xbf}))
	require.Equal(t, "text/plain; charset=utf-8", windows.Header().Get("Content-Type"))
	require.Equal(t, "attachment; filename=ferricade-deploy.ps1", windows.Header().Get("Content-Disposition"))
	require.Equal(t, "no-store", windows.Header().Get("Cache-Control"))
	config := owner.ok(http.MethodGet, apiPrefix+"/server/client-config", nil)["config_string"].(string)
	require.Contains(t, windows.Body.String(), config)
	linux := owner.do(http.MethodPost, script, map[string]any{"os": "linux"})
	require.Equal(t, http.StatusOK, linux.Code)
	require.Equal(t, "attachment; filename=ferricade-deploy.sh", linux.Header().Get("Content-Disposition"))
	for _, entry := range e.auditEntries("deployment.script_downloaded") {
		require.Equal(t, false, entry.Details["clears_password"])
		require.Equal(t, false, entry.Details["clears_pin"])
	}

	var details []string
	rows, err := e.d.Pool.Query(context.Background(), `SELECT details::text FROM audit_events WHERE action LIKE 'deployment.%'`)
	require.NoError(t, err)
	for rows.Next() {
		var detail string
		require.NoError(t, rows.Scan(&detail))
		details = append(details, detail)
		require.NotContains(t, detail, "Password123")
		require.NotContains(t, detail, "1234")
	}
	rows.Close()
	require.NoError(t, rows.Err())
	require.Len(t, details, 5)

	delete(put, "fleet_password")
	delete(put, "unlock_pin")
	owner.ok(http.MethodPut, path, put)
	require.True(t, owner.ok(http.MethodGet, path, nil)["password"].(map[string]any)["set"].(bool))
	put["fleet_password"] = nil
	owner.ok(http.MethodPut, path, put)
	require.False(t, owner.ok(http.MethodGet, path, nil)["password"].(map[string]any)["set"].(bool))
	require.Len(t, e.auditEntries("deployment.password_removed"), 1)
	require.Equal(t, http.StatusOK, owner.do(http.MethodPost, script, map[string]any{"os": "linux"}).Code)
	entries := e.auditEntries("deployment.script_downloaded")
	require.Equal(t, true, entries[0].Details["clears_password"])
	require.Equal(t, false, entries[0].Details["clears_pin"])
	put["unlock_pin"] = nil
	owner.ok(http.MethodPut, path, put)
	require.False(t, owner.ok(http.MethodGet, path, nil)["unlock_pin"].(map[string]any)["set"].(bool))
	require.Len(t, e.auditEntries("deployment.pin_removed"), 1)
	require.Equal(t, http.StatusOK, owner.do(http.MethodPost, script, map[string]any{"os": "linux"}).Code)
	entries = e.auditEntries("deployment.script_downloaded")
	require.Equal(t, true, entries[0].Details["clears_password"])
	require.Equal(t, true, entries[0].Details["clears_pin"])

	put["fleet_password"] = "weak"
	rec := owner.do(http.MethodPut, path, put)
	requireError(t, rec, http.StatusBadRequest, codeBadRequest)
	require.Contains(t, rec.Body.String(), "fleet_password")
	put["fleet_password"] = nil
	put["settings"] = map[string]any{"not_in_catalog": map[string]any{"include": true, "value": "Y"}}
	requireError(t, owner.do(http.MethodPut, path, put), http.StatusBadRequest, codeBadRequest)
	put["settings"] = map[string]any{}
	put["installer_source"] = "url"
	owner.ok(http.MethodPut, path, put)
	rec = owner.do(http.MethodPost, script, map[string]any{"os": "linux"})
	requireError(t, rec, http.StatusBadRequest, codeBadRequest)
	require.Contains(t, rec.Body.String(), "url_deb")
	put["include_install"] = false
	owner.ok(http.MethodPut, path, put)
	rec = owner.do(http.MethodPost, script, map[string]any{"os": "linux"})
	requireError(t, rec, http.StatusBadRequest, codeBadRequest)
	require.Contains(t, rec.Body.String(), "url_deb")
}

func TestDeploymentSettingsJSONAndUnknownNestedKey(t *testing.T) {
	e := newEnv(t)
	owner, _ := e.signedIn("owner", "owner")
	path := apiPrefix + "/deployment/profile"
	p := deploymentRequest()
	p["settings"] = map[string]any{
		"enable-file-transfer": map[string]any{"include": true, "value": "N"},
		"access-mode":          map[string]any{"include": true, "value": "view"},
	}
	badPreset := owner.do(http.MethodPut, path, p)
	requireError(t, badPreset, http.StatusBadRequest, codeBadRequest)
	require.Equal(t, "access-mode: must be custom when individual permissions are managed", decodeBody(t, badPreset)["error"].(map[string]any)["message"])
	p["settings"] = map[string]any{"enable-audio": map[string]any{"include": true, "value": "Y"}}
	put := owner.do(http.MethodPut, path, p)
	require.Equal(t, http.StatusOK, put.Code, put.Body.String())
	require.Contains(t, put.Body.String(), `"include":true,"value":"Y"`)
	require.NotContains(t, put.Body.String(), `"Include"`)
	get := owner.do(http.MethodGet, path, nil)
	require.Equal(t, http.StatusOK, get.Code, get.Body.String())
	require.Contains(t, get.Body.String(), `"value_labels":`)
	require.Contains(t, get.Body.String(), `"include":true,"value":"Y"`)
	require.NotContains(t, get.Body.String(), `"Include"`)
	var stored string
	require.NoError(t, e.d.Pool.QueryRow(context.Background(), `SELECT settings::text FROM deployment_profile`).Scan(&stored))
	require.Contains(t, stored, `"include": true`)
	require.NotContains(t, stored, `"Include"`)
	var auditDetails string
	require.NoError(t, e.d.Pool.QueryRow(context.Background(), `SELECT details::text FROM audit_events WHERE action = 'deployment.profile_updated' ORDER BY at DESC LIMIT 1`).Scan(&auditDetails))
	require.Contains(t, auditDetails, `"include": true`)
	require.NotContains(t, auditDetails, `"Include"`)
	p["settings"] = map[string]any{"enable-audio": map[string]any{"include": true, "value": "Y", "extra": 1}}
	requireError(t, owner.do(http.MethodPut, path, p), http.StatusBadRequest, codeBadRequest)
}

func TestDeploymentNullSecretsNeverSet(t *testing.T) {
	e := newEnv(t)
	owner, _ := e.signedIn("owner", "owner")
	p := deploymentRequest()
	p["fleet_password"], p["unlock_pin"] = nil, nil
	response := owner.do(http.MethodPut, apiPrefix+"/deployment/profile", p)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Empty(t, e.auditEntries("deployment.password_removed"))
	require.Empty(t, e.auditEntries("deployment.pin_removed"))
}

func TestDeploymentRotationAndIncompleteSetup(t *testing.T) {
	e := newEnv(t)
	owner, _ := e.signedIn("owner", "owner")
	requireError(t, owner.do(http.MethodPost, apiPrefix+"/deployment/script", map[string]any{"os": "windows"}), http.StatusNotFound, codeNotFound)
	e.markSetupComplete()
	put := deploymentRequest()
	put["fleet_password"] = "Password123"
	put["unlock_pin"] = "1234"
	owner.ok(http.MethodPut, apiPrefix+"/deployment/profile", put)
	other, err := auth.NewSealer([]byte("abcdef0123456789abcdef0123456789"))
	require.NoError(t, err)
	e.d.Sealer = other
	e.h = New(e.d)
	get := owner.ok(http.MethodGet, apiPrefix+"/deployment/profile", nil)
	require.True(t, get["password"].(map[string]any)["set"].(bool))
	require.True(t, get["unlock_pin"].(map[string]any)["set"].(bool))
	require.Empty(t, e.auditEntries("deployment.script_downloaded"))
	response := owner.do(http.MethodPost, apiPrefix+"/deployment/script", map[string]any{"os": "windows"})
	requireError(t, response, http.StatusBadRequest, codeBadRequest)
	require.Contains(t, decodeBody(t, response)["error"].(map[string]any)["message"], "fleet_password: the stored value cannot be decrypted")
	require.Empty(t, e.auditEntries("deployment.script_downloaded"))
	put["include_password"] = false
	delete(put, "fleet_password")
	delete(put, "unlock_pin")
	owner.ok(http.MethodPut, apiPrefix+"/deployment/profile", put)
	response = owner.do(http.MethodPost, apiPrefix+"/deployment/script", map[string]any{"os": "linux"})
	requireError(t, response, http.StatusBadRequest, codeBadRequest)
	require.Contains(t, decodeBody(t, response)["error"].(map[string]any)["message"], "unlock_pin: the stored value cannot be decrypted")
	require.Empty(t, e.auditEntries("deployment.script_downloaded"))
}

func TestDeploymentValidationFields(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	path := apiPrefix + "/deployment/profile"
	latest := deploymentRequest()
	latest["client_version"] = "latest"
	require.Equal(t, "latest", owner.ok(http.MethodPut, path, latest)["client_version"])
	latest["installer_source"] = "url"
	latestError := owner.do(http.MethodPut, path, latest)
	requireError(t, latestError, http.StatusBadRequest, codeBadRequest)
	require.Equal(t, "client_version: latest needs the GitHub installer source", decodeBody(t, latestError)["error"].(map[string]any)["message"])
	latest["installer_source"] = "github"
	latest["sha256_windows"] = strings.Repeat("a", 64)
	checksumError := owner.do(http.MethodPut, path, latest)
	requireError(t, checksumError, http.StatusBadRequest, codeBadRequest)
	require.Equal(t, "sha256_windows: not allowed with the latest release", decodeBody(t, checksumError)["error"].(map[string]any)["message"])
	cases := []struct {
		name, field string
		change      func(map[string]any)
	}{
		{"installer source", "installer_source", func(p map[string]any) { p["installer_source"] = "bad" }},
		{"client version", "client_version", func(p map[string]any) { p["client_version"] = "bad" }},
		{"windows checksum", "sha256_windows", func(p map[string]any) { p["sha256_windows"] = "bad" }},
		{"debian checksum", "sha256_deb", func(p map[string]any) { p["sha256_deb"] = "bad" }},
		{"rpm checksum", "sha256_rpm", func(p map[string]any) { p["sha256_rpm"] = "bad" }},
		{"password", "fleet_password", func(p map[string]any) { p["fleet_password"] = "weak" }},
		{"pin", "unlock_pin", func(p map[string]any) { p["unlock_pin"] = "123" }},
		{"unknown setting", "settings.unknown", func(p map[string]any) {
			p["settings"] = map[string]any{"unknown": map[string]any{"include": true, "value": "Y"}}
		}},
		{"invalid setting", "settings.enable-audio", func(p map[string]any) {
			p["settings"] = map[string]any{"enable-audio": map[string]any{"include": true, "value": "bad"}}
		}},
		{"empty setting", "settings.enable-audio", func(p map[string]any) {
			p["settings"] = map[string]any{"enable-audio": map[string]any{"include": true, "value": ""}}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := deploymentRequest()
			tc.change(p)
			rec := owner.do(http.MethodPut, path, p)
			requireError(t, rec, http.StatusBadRequest, codeBadRequest)
			message := decodeBody(t, rec)["error"].(map[string]any)["message"].(string)
			require.Regexp(t, "^"+tc.field+": ", message)
		})
	}
	p := deploymentRequest()
	p["installer_source"] = "url"
	owner.ok(http.MethodPut, path, p)
	for _, tc := range []struct{ os, field string }{{"windows", "url_windows"}, {"linux", "url_deb or url_rpm"}} {
		t.Run(tc.os+" URL", func(t *testing.T) {
			rec := owner.do(http.MethodPost, apiPrefix+"/deployment/script", map[string]any{"os": tc.os})
			requireError(t, rec, http.StatusBadRequest, codeBadRequest)
			message := decodeBody(t, rec)["error"].(map[string]any)["message"].(string)
			require.Regexp(t, "^"+tc.field+": ", message)
		})
	}
}

func TestDeploymentStoreErrorIsInternal(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	ctx := context.Background()
	_, err := e.d.Pool.Exec(ctx, `CREATE FUNCTION fail_deployment_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'storage required repair'; END $$`)
	require.NoError(t, err)
	_, err = e.d.Pool.Exec(ctx, `CREATE TRIGGER fail_deployment_save BEFORE INSERT OR UPDATE ON deployment_profile FOR EACH ROW EXECUTE FUNCTION fail_deployment_save()`)
	require.NoError(t, err)
	rec := owner.do(http.MethodPut, apiPrefix+"/deployment/profile", deploymentRequest())
	requireError(t, rec, http.StatusInternalServerError, codeInternal)
	require.NotContains(t, rec.Body.String(), "storage required repair")
}

func TestDeploymentProfileIDAllowList(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	path := apiPrefix + "/deployment/profile"
	script := apiPrefix + "/deployment/script"
	allowListPath := apiPrefix + "/settings/id-allow-list"

	initial := owner.ok(http.MethodGet, path, nil)
	require.Equal(t, false, initial["include_id_allow_list"])

	// Missing required include_id_allow_list is rejected.
	missing := deploymentRequest()
	delete(missing, "include_id_allow_list")
	requireError(t, owner.do(http.MethodPut, path, missing), http.StatusBadRequest, codeBadRequest)

	// Set global ID allow list.
	owner.ok(http.MethodPut, allowListPath, map[string]any{"ids": []string{"ABC123", "DEF456"}})

	// With include_id_allow_list=false, scripts omit id-whitelist.
	for _, target := range []string{"windows", "linux"} {
		rec := owner.do(http.MethodPost, script, map[string]any{"os": target})
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		require.NotContains(t, rec.Body.String(), "id-whitelist")
	}

	// Enable include_id_allow_list and verify round-trip + audit.
	put := deploymentRequest()
	put["include_id_allow_list"] = true
	updated := owner.ok(http.MethodPut, path, put)
	require.Equal(t, true, updated["include_id_allow_list"])
	require.Equal(t, true, owner.ok(http.MethodGet, path, nil)["include_id_allow_list"])

	entries := e.auditEntries("deployment.profile_updated")
	require.NotEmpty(t, entries)
	require.Equal(t, false, entries[0].Details["before"].(map[string]any)["include_id_allow_list"])
	require.Equal(t, true, entries[0].Details["after"].(map[string]any)["include_id_allow_list"])

	// With include_id_allow_list=true and non-empty global list, scripts include id-whitelist.
	win := owner.do(http.MethodPost, script, map[string]any{"os": "windows"})
	require.Equal(t, http.StatusOK, win.Code, win.Body.String())
	require.Contains(t, win.Body.String(), "Run-Client @('--option', 'id-whitelist', 'ABC123,DEF456')")

	lin := owner.do(http.MethodPost, script, map[string]any{"os": "linux"})
	require.Equal(t, http.StatusOK, lin.Code, lin.Body.String())
	require.Contains(t, lin.Body.String(), `"$exe" --option 'id-whitelist' 'ABC123,DEF456'`)

	// When global list is empty, scripts omit id-whitelist even if flag is true.
	owner.ok(http.MethodPut, allowListPath, map[string]any{"ids": []string{}})
	for _, target := range []string{"windows", "linux"} {
		rec := owner.do(http.MethodPost, script, map[string]any{"os": target})
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		require.NotContains(t, rec.Body.String(), "id-whitelist")
	}
}
