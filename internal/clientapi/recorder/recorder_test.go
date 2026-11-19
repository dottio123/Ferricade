package recorder_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/clientapi/recorder"
	"github.com/dottio123/ferricade/internal/clientapi/wire"
	"github.com/dottio123/ferricade/internal/contract"
)

func do(t *testing.T, req *http.Request) (*httptest.ResponseRecorder, []contract.Fixture) {
	t.Helper()
	var out bytes.Buffer
	rec := httptest.NewRecorder()
	recorder.New(&out, "1.5.0").ServeHTTP(rec, req)
	var fs []contract.Fixture
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if line == "" {
			continue
		}
		var f contract.Fixture
		require.NoError(t, json.Unmarshal([]byte(line), &f), line)
		fs = append(fs, f)
	}
	return rec, fs
}

func TestRecorderHeartbeat(t *testing.T) {
	rec, fs := do(t, httptest.NewRequest(http.MethodPost, "/api/heartbeat", strings.NewReader(`{"id":"123","uuid":"u","ver":1005000,"modified_at":0}`)))
	assert.JSONEq(t, `{}`, rec.Body.String())
	require.Len(t, fs, 1)
	assert.Equal(t, "captured", fs[0].Source)
	assert.Equal(t, "1.5.0", fs[0].ClientVersion)
	assert.Equal(t, "/api/heartbeat", fs[0].Path)
	var body map[string]any
	require.NoError(t, json.Unmarshal(fs[0].Body, &body))
	assert.Equal(t, "123", body["id"])
}

func TestRecorderSysinfoText(t *testing.T) {
	rec, _ := do(t, httptest.NewRequest(http.MethodPost, "/api/sysinfo", strings.NewReader(`{"id":"1"}`)))
	assert.Equal(t, "SYSINFO_UPDATED", rec.Body.String())
}

func TestRecorderLegacyAddressBook(t *testing.T) {
	rec, _ := do(t, httptest.NewRequest(http.MethodPost, "/api/ab/personal", nil))
	assert.Equal(t, http.StatusNotFound, rec.Code)
	assert.JSONEq(t, `{"error":"not found"}`, rec.Body.String())
}

func TestRecorderRedactsSecrets(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(`{"username":"a","password":"hunter2","deviceInfo":{"secret":"s3"}}`))
	req.Header.Set("Authorization", "Bearer tok123")
	_, fs := do(t, req)
	require.Len(t, fs, 1)
	line, _ := json.Marshal(fs[0])
	assert.NotContains(t, string(line), "hunter2")
	assert.NotContains(t, string(line), "s3")
	assert.NotContains(t, string(line), "tok123")
	assert.Equal(t, "Bearer [redacted]", fs[0].Headers["Authorization"])
	assert.Contains(t, string(fs[0].Body), `"password":"[redacted]"`)
}

func TestRecorderParsesBodyWithoutContentType(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(`{"username":"a"}`))
	req.Header.Del("Content-Type")
	_, fs := do(t, req)
	require.Len(t, fs, 1)
	assert.JSONEq(t, `{"username":"a"}`, string(fs[0].Body))
}

func TestRecorderCapsBody(t *testing.T) {
	big := bytes.Repeat([]byte("a"), 2<<20)
	rec, fs := do(t, httptest.NewRequest(http.MethodPost, "/api/heartbeat", bytes.NewReader(big)))
	assert.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)
	assert.JSONEq(t, `{"error":"body too large"}`, rec.Body.String())
	require.Len(t, fs, 1)
	assert.Equal(t, "/api/heartbeat", fs[0].Path)
	assert.Empty(t, fs[0].Body)
}

func TestRecorderKeepsQuery(t *testing.T) {
	_, fs := do(t, httptest.NewRequest(http.MethodGet, "/api/peers?current=1&pageSize=100", nil))
	require.Len(t, fs, 1)
	assert.Equal(t, map[string]string{"current": "1", "pageSize": "100"}, fs[0].Query)
}

func TestRecorderStoresNonJSONAsString(t *testing.T) {
	_, fs := do(t, httptest.NewRequest(http.MethodPost, "/api/record?type=new&file=x.webm", strings.NewReader("\x00\x01raw")))
	require.Len(t, fs, 1)
	var s string
	require.NoError(t, json.Unmarshal(fs[0].Body, &s))
	assert.Equal(t, "\x00\x01raw", s)
}

func TestRedactNested(t *testing.T) {
	out := recorder.Redact([]byte(`{"a":[{"tfaCode":"1"}],"address_book_password":"p","verificationCode":"v","keep":"k"}`))
	assert.JSONEq(t, `{"a":[{"tfaCode":"[redacted]"}],"address_book_password":"[redacted]","verificationCode":"[redacted]","keep":"k"}`, string(out))
}

func TestRedactKeepsLargeIntegers(t *testing.T) {
	out := recorder.Redact([]byte(`{"session_id":12345678901234567891,"password":"p"}`))
	assert.Contains(t, string(out), "12345678901234567891")
}

func TestRedactPresetPasswordAndHash(t *testing.T) {
	out := recorder.Redact([]byte(`{"preset-address-book-password":"PRESETPW","hash":"H"}`))
	assert.NotContains(t, string(out), "PRESETPW")
	assert.NotContains(t, string(out), `"H"`)
}

func TestRedactInsideJSONText(t *testing.T) {
	inner := `{"tags":[],"peers":[{"id":"1","hash":"SECRETHASH"}],"tag_colors":"{}"}`
	body, _ := json.Marshal(map[string]string{"data": inner})
	out := recorder.Redact(body)
	assert.NotContains(t, string(out), "SECRETHASH")
	var outer struct{ Data string }
	require.NoError(t, json.Unmarshal(out, &outer))
	assert.Contains(t, outer.Data, `"id":"1"`, "inner JSON text stays JSON text")
}

func TestRecorderRedactsSchemelessAuthorization(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/ab", nil)
	req.Header.Set("Authorization", "tokenwithoutscheme")
	_, fs := do(t, req)
	require.Len(t, fs, 1)
	assert.Equal(t, "[redacted]", fs[0].Headers["Authorization"])
}

// The address book and device lists only call the server once the client is
// signed in, so the recorder accepts any login with a fake lab user.
func TestRecorderLoginSignsIn(t *testing.T) {
	rec, _ := do(t, httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(`{"username":"alice","password":"x"}`)))
	assert.Equal(t, http.StatusOK, rec.Code)
	var ab wire.AuthBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ab))
	assert.Equal(t, wire.AuthTypeAccessToken, ab.Type)
	assert.NotEmpty(t, ab.AccessToken)
	assert.Equal(t, "alice", ab.User.Name)
	assert.Contains(t, rec.Body.String(), `"login_device_whitelist":[]`)
}

func TestRecorderCurrentUser(t *testing.T) {
	rec, _ := do(t, httptest.NewRequest(http.MethodPost, "/api/currentUser", strings.NewReader(`{"id":"1","uuid":"u"}`)))
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"info":{`)
}

func TestRecorderListsArePaged(t *testing.T) {
	for _, p := range []string{"/api/users", "/api/peers", "/api/device-group/accessible"} {
		rec, _ := do(t, httptest.NewRequest(http.MethodGet, p+"?current=1&pageSize=100", nil))
		assert.Equal(t, http.StatusOK, rec.Code, p)
		assert.JSONEq(t, `{"total":0,"data":[]}`, rec.Body.String(), p)
	}
}

func TestRecorderLegacyABPullAndPush(t *testing.T) {
	rec, _ := do(t, httptest.NewRequest(http.MethodGet, "/api/ab", nil))
	assert.Equal(t, http.StatusOK, rec.Code)
	var ab wire.LegacyAB
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ab))
	_, err := ab.Decode()
	require.NoError(t, err)

	rec, _ = do(t, httptest.NewRequest(http.MethodPost, "/api/ab", strings.NewReader(`{"data":"{}"}`)))
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Empty(t, rec.Body.String(), "empty body means success to the client")
}
