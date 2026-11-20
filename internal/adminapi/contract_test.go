package adminapi

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/pb33f/libopenapi"
	validator "github.com/pb33f/libopenapi-validator"
	"github.com/pb33f/libopenapi-validator/config"
	"github.com/pb33f/libopenapi/datamodel"
	"github.com/pb33f/libopenapi/datamodel/high/base"
	v3 "github.com/pb33f/libopenapi/datamodel/high/v3"
	"github.com/pb33f/libopenapi/orderedmap"
	"github.com/stretchr/testify/require"
)

// fakeTB records failures instead of failing the test, so that a test can
// check that validateResponse reports a mismatch. The embedded TB supplies
// everything else.
type fakeTB struct {
	testing.TB
	failures []string
}

func (f *fakeTB) Helper() {}
func (f *fakeTB) Errorf(format string, args ...any) {
	f.failures = append(f.failures, fmt.Sprintf(format, args...))
}
func (f *fakeTB) Fatalf(format string, args ...any) { f.Errorf(format, args...) }

// hand returns a recorded response with status and body for the request.
func hand(method, path string, status int, body string) (*http.Request, *httptest.ResponseRecorder) {
	req := httptest.NewRequest(method, path, nil)
	rec := httptest.NewRecorder()
	rec.Header().Set("Content-Type", "application/json")
	rec.WriteHeader(status)
	rec.WriteString(body)
	return req, rec
}

func TestContractCatchesMismatch(t *testing.T) {
	wantSchemaFailure := &fakeTB{TB: t}
	req, rec := hand(http.MethodGet, apiPrefix+"/auth/me", http.StatusOK, `{"user":{"id":"x"}}`)
	validateResponse(wantSchemaFailure, req, rec)
	require.NotEmpty(t, wantSchemaFailure.failures, "a body that misses required fields passes validation")

	// The same route with a body that matches passes, so the failure above is
	// the body's and not the validator's.
	ok := &fakeTB{TB: t}
	req, rec = hand(http.MethodGet, apiPrefix+"/auth/me", http.StatusOK, `{"user":{"id":"9f1c6d43-5b0e-4a7e-9d8c-0a4f7b0e1c2d",`+
		`"username":"alice","display_name":"","email":"","role":"owner","status":"active","totp_required":true,"sso":false,"avatar_url":null},`+
		`"mfa_passed":true,"totp_enrolled":true,"csrf_token":"t"}`)
	validateResponse(ok, req, rec)
	require.Empty(t, ok.failures)

	// An extra field is a mismatch too: the schemas are closed.
	extra := &fakeTB{TB: t}
	req, rec = hand(http.MethodGet, apiPrefix+"/auth/me", http.StatusOK, `{"user":{"id":"9f1c6d43-5b0e-4a7e-9d8c-0a4f7b0e1c2d",`+
		`"username":"alice","display_name":"","email":"","role":"owner","status":"active","totp_required":true,"sso":false,"avatar_url":null},`+
		`"mfa_passed":true,"totp_enrolled":true,"csrf_token":"t","password_hash":"x"}`)
	validateResponse(extra, req, rec)
	require.NotEmpty(t, extra.failures, "an undocumented field passes validation")

	// Also inside a referenced schema (User).
	nested := &fakeTB{TB: t}
	req, rec = hand(http.MethodGet, apiPrefix+"/auth/me", http.StatusOK, `{"user":{"id":"9f1c6d43-5b0e-4a7e-9d8c-0a4f7b0e1c2d",`+
		`"username":"alice","display_name":"","email":"","role":"owner","status":"active","totp_required":true,"sso":false,"avatar_url":null,"password_hash":"x"},`+
		`"mfa_passed":true,"totp_enrolled":true,"csrf_token":"t"}`)
	validateResponse(nested, req, rec)
	require.NotEmpty(t, nested.failures, "an undocumented field of User passes validation")

	// Formats are asserted: an id that is not a UUID fails.
	format := &fakeTB{TB: t}
	req, rec = hand(http.MethodGet, apiPrefix+"/auth/me", http.StatusOK, `{"user":{"id":"x",`+
		`"username":"alice","display_name":"","email":"","role":"owner","status":"active","totp_required":true,"sso":false,"avatar_url":null},`+
		`"mfa_passed":true,"totp_enrolled":true,"csrf_token":"t"}`)
	validateResponse(format, req, rec)
	require.NotEmpty(t, format.failures, "a malformed uuid passes validation")
}

func TestContractCatchesUnknownStatus(t *testing.T) {
	f := &fakeTB{TB: t}
	req, rec := hand(http.MethodGet, apiPrefix+"/devices", http.StatusTeapot, `{"error":{"code":"internal","message":"x"}}`)
	validateResponse(f, req, rec)
	require.NotEmpty(t, f.failures)
	require.Contains(t, strings.Join(f.failures, "\n"), "status not declared")
}

func TestContractCatchesMalformedRedirect(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		location   bool
	}{
		{name: "content", body: "unexpected", location: true},
		{name: "missing Location"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeTB{TB: t}
			req, rec := hand(http.MethodGet, apiPrefix+"/auth/oidc/start", http.StatusFound, tc.body)
			if tc.location {
				rec.Header().Set("Location", "/provider")
			}
			validateResponse(f, req, rec)
			require.NotEmpty(t, f.failures)
		})
	}
}

func TestContractCatchesUnknownRoute(t *testing.T) {
	for _, r := range []struct{ method, path string }{
		{http.MethodGet, apiPrefix + "/nope"},
		{http.MethodDelete, apiPrefix + "/devices"},
	} {
		f := &fakeTB{TB: t}
		req, rec := hand(r.method, r.path, http.StatusNotFound, `{"error":{"code":"not_found","message":"not found"}}`)
		validateResponse(f, req, rec)
		require.NotEmpty(t, f.failures, "%s %s", r.method, r.path)
		require.Contains(t, strings.Join(f.failures, "\n"), "not in openapi.yaml")
	}
}

// TestContractCoversAllRoutes adds to TestOpenAPICoversRoutes: each
// operation declares a success response, each success response with a body
// has a schema, each error response is the Error schema, and every object in
// a response schema says whether it is closed, so that the UI's generated
// types are exact.
func TestContractCoversAllRoutes(t *testing.T) {
	doc := contractModel(t)
	valid, errs := contract.validator.ValidateDocument()
	for _, e := range errs {
		t.Errorf("openapi.yaml is not valid OpenAPI: %s: %s", e.Message, e.Reason)
		for _, f := range e.SchemaValidationErrors {
			t.Errorf("  %s (%s): %s", f.FieldPath, f.KeywordLocation, f.Reason)
		}
	}
	require.True(t, valid)
	var open []string
	seen := map[string]bool{}
	n := 0
	for path, item := range doc.Paths.PathItems.FromOldest() {
		for method, op := range item.GetOperations().FromOldest() {
			n++
			name := strings.ToUpper(method) + " " + path
			success := false
			for code, resp := range op.Responses.Codes.FromOldest() {
				content := resp.Content
				switch {
				case strings.HasPrefix(code, "2"):
					success = true
					if code == "204" {
						require.Zero(t, orderedmap.Len(content), "%s: 204 has a body", name)
						continue
					}
					require.NotZero(t, orderedmap.Len(content), "%s %s: no content", name, code)
					for mt, m := range content.FromOldest() {
						require.NotNil(t, m.Schema, "%s %s %s: no schema", name, code, mt)
						unclosedObjects(m.Schema, name+" "+code, seen, &open)
					}
				case strings.HasPrefix(code, "3"):
					loc, ok := resp.Headers.Get("Location")
					require.True(t, ok, "%s %s: no Location header", name, code)
					require.True(t, loc.Required, "%s %s: Location is not required", name, code)
					require.Zero(t, orderedmap.Len(content), "%s %s: redirect has content", name, code)
				case strings.HasPrefix(code, "4"), strings.HasPrefix(code, "5"):
					m, ok := content.Get("application/json")
					require.True(t, ok, "%s %s: no application/json content", name, code)
					require.NotNil(t, m.Schema, "%s %s: no schema", name, code)
					require.Equal(t, "#/components/schemas/Error", m.Schema.GetReference(), "%s %s", name, code)
				default:
					t.Errorf("%s: unexpected response %s", name, code)
				}
			}
			if !success {
				hasRedirect := false
				for code := range op.Responses.Codes.FromOldest() {
					hasRedirect = hasRedirect || strings.HasPrefix(code, "3")
				}
				require.True(t, hasRedirect, "%s: no 2xx response", name)
			}
		}
	}
	require.NotZero(t, n)
	unclosedObjects(doc.Components.Schemas.GetOrZero("Error"), "Error", seen, &open)
	require.Empty(t, open, "object schemas without additionalProperties (false for a fixed shape, true for an open one)")
}

// unclosedObjects appends to out each object schema reachable from sp that
// does not set additionalProperties. at names sp in the message; seen stops
// at schemas already walked (Group refers to itself).
func unclosedObjects(sp *base.SchemaProxy, at string, seen map[string]bool, out *[]string) {
	if sp == nil {
		return
	}
	if ref := sp.GetReference(); ref != "" {
		if seen[ref] {
			return
		}
		seen[ref] = true
		at = ref
	}
	s := sp.Schema()
	if s == nil {
		return
	}
	if slices.Contains(s.Type, "object") && s.AdditionalProperties == nil {
		*out = append(*out, at)
	}
	for name, p := range s.Properties.FromOldest() {
		unclosedObjects(p, at+"."+name, seen, out)
	}
	if s.Items != nil && s.Items.IsA() {
		unclosedObjects(s.Items.A, at+"[]", seen, out)
	}
	for _, list := range [][]*base.SchemaProxy{s.AllOf, s.AnyOf, s.OneOf} {
		for _, c := range list {
			unclosedObjects(c, at, seen, out)
		}
	}
}

// contract is openapi.yaml loaded once for every test in the package.
var contract struct {
	once      sync.Once
	model     *v3.Document
	validator validator.Validator
	routes    []contractRoute
	err       error
}

// contractRoute is a documented path as a pattern for request paths.
type contractRoute struct {
	re     *regexp.Regexp
	params int
	item   *v3.PathItem
}

// specParam matches an OpenAPI path parameter.
var specParam = regexp.MustCompile(`\{[^}/]+\}`)

func loadContract() {
	// Group.children is an array of Group: an empty array ends the loop, so
	// it is not the infinite reference libopenapi reports by default.
	doc, err := libopenapi.NewDocumentWithConfiguration(openapiYAML, &datamodel.DocumentConfiguration{
		IgnoreArrayCircularReferences: true,
	})
	if err != nil {
		contract.err = fmt.Errorf("parse openapi.yaml: %w", err)
		return
	}
	// Format assertions make "uuid" and "date-time" checked, not annotations,
	// since the UI relies on them.
	v, errs := validator.NewValidator(doc, config.WithFormatAssertions())
	if len(errs) > 0 {
		contract.err = fmt.Errorf("build openapi.yaml validator: %w", errors.Join(errs...))
		return
	}
	m, err := doc.BuildV3Model()
	if err != nil {
		contract.err = fmt.Errorf("build openapi.yaml model: %w", err)
		return
	}
	contract.model, contract.validator = &m.Model, v
	for path, item := range m.Model.Paths.PathItems.FromOldest() {
		parts := specParam.Split(path, -1)
		for i, p := range parts {
			parts[i] = regexp.QuoteMeta(p)
		}
		contract.routes = append(contract.routes, contractRoute{
			re:     regexp.MustCompile("^" + strings.Join(parts, "[^/]+") + "$"),
			params: len(parts) - 1,
			item:   item,
		})
	}
	// A literal segment wins over a parameter, as in chi: /devices/summary
	// before /devices/{id}.
	sort.SliceStable(contract.routes, func(i, j int) bool { return contract.routes[i].params < contract.routes[j].params })
}

// contractModel returns the openapi.yaml model.
func contractModel(t testing.TB) *v3.Document {
	t.Helper()
	contract.once.Do(loadContract)
	if contract.err != nil {
		t.Fatalf("contract: %v", contract.err)
		return nil
	}
	return contract.model
}

// inContract reports whether path is one validateResponse checks: the
// admin API and the setup wizard. The client API is RustDesk's and has its
// own contract tests.
func inContract(path string) bool {
	return path == apiPrefix || strings.HasPrefix(path, apiPrefix+"/") || path == "/setup" || strings.HasPrefix(path, "/setup/")
}

// contractOperation returns the operation openapi.yaml documents for method
// and path, or why there is none.
func contractOperation(t testing.TB, method, path string) (*v3.Operation, string) {
	t.Helper()
	if contractModel(t) == nil {
		return nil, "openapi.yaml did not load"
	}
	for _, r := range contract.routes {
		if !r.re.MatchString(path) {
			continue
		}
		if op, ok := r.item.GetOperations().Get(strings.ToLower(method)); ok {
			return op, ""
		}
		return nil, "method not in openapi.yaml"
	}
	return nil, "route not in openapi.yaml"
}

// validateResponse fails t when the response to req is not what openapi.yaml
// declares: the route or method is not documented, the status is not one of
// the operation's responses, or the headers or body do not match that
// response.
func validateResponse(t testing.TB, req *http.Request, rec *httptest.ResponseRecorder) {
	t.Helper()
	path := req.URL.Path
	if !inContract(path) {
		return
	}
	name := req.Method + " " + path
	op, why := contractOperation(t, req.Method, path)
	if op == nil {
		t.Errorf("contract: %s: %s (status %d)", why, name, rec.Code)
		return
	}
	resp, ok := op.Responses.Codes.Get(strconv.Itoa(rec.Code))
	if !ok {
		t.Errorf("contract: status not declared in openapi.yaml: %s %d: %s", name, rec.Code, rec.Body.String())
		return
	}
	if rec.Code >= 300 && rec.Code < 400 {
		header, declared := resp.Headers.Get("Location")
		if !declared || !header.Required || rec.Header().Get("Location") == "" {
			t.Errorf("contract: %s %d requires a Location header", name, rec.Code)
		}
		if orderedmap.Len(resp.Content) != 0 {
			t.Errorf("contract: %s %d redirect declares content", name, rec.Code)
		}
	}
	if orderedmap.Len(resp.Content) == 0 {
		if rec.Body.Len() != 0 {
			t.Errorf("contract: %s %d declares no body but has one: %s", name, rec.Code, rec.Body.String())
		}
		return
	}
	// A server-sent event stream has no body to validate; its headers and
	// status are checked by its own tests.
	if _, ok := resp.Content.Get("text/event-stream"); ok && strings.HasPrefix(rec.Header().Get("Content-Type"), "text/event-stream") {
		return
	}
	// The validator passes a missing body without looking at the schema, so
	// a declared JSON body must be there, and not a bare null.
	if m, ok := resp.Content.Get("application/json"); ok && m.Schema != nil {
		if b := bytes.TrimSpace(rec.Body.Bytes()); len(b) == 0 || string(b) == "null" {
			t.Errorf("contract: %s %d declares a JSON body but has %q", name, rec.Code, rec.Body.String())
			return
		}
	}
	// A fresh response, since the recorder's Result caches a body that the
	// validator would drain.
	res := &http.Response{
		StatusCode: rec.Code,
		Header:     rec.Header().Clone(),
		Body:       io.NopCloser(bytes.NewReader(rec.Body.Bytes())),
		Request:    req,
	}
	if ok, errs := contract.validator.ValidateHttpResponse(req, res); !ok {
		var b strings.Builder
		for _, e := range errs {
			fmt.Fprintf(&b, "\n  %s: %s", e.Message, e.Reason)
			for _, f := range e.SchemaValidationErrors {
				fmt.Fprintf(&b, "\n    %s: %s", f.FieldPath, f.Reason)
			}
		}
		t.Errorf("contract: %s %d does not match openapi.yaml:%s\n  body: %s", name, rec.Code, b.String(), rec.Body.String())
	}
}

// doOutsideContract is do for a path or method that openapi.yaml does not
// document, for the tests of the router's fallbacks (JSON 404, security
// headers on every response); nothing can validate such a response. It fails
// for a documented route, which must go through do.
func (c *client) doOutsideContract(method, path string, hdrs ...http.Header) *httptest.ResponseRecorder {
	c.e.t.Helper()
	if op, _ := contractOperation(c.e.t, method, path); op != nil {
		c.e.t.Fatalf("contract: %s %s is in openapi.yaml; use do", method, path)
	}
	_, rec := c.send(method, path, nil, hdrs...)
	return rec
}

// A declared JSON body must be present: an empty, blank or null body would
// otherwise skip the schema check.
func TestContractCatchesMissingBody(t *testing.T) {
	for _, body := range []string{"", " \n\t", "null", " null\n"} {
		f := &fakeTB{TB: t}
		req, rec := hand(http.MethodGet, apiPrefix+"/auth/me", http.StatusOK, body)
		validateResponse(f, req, rec)
		require.NotEmpty(t, f.failures, "body %q passes", body)
	}
}
