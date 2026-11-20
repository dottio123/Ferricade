package contract

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"

	"github.com/dottio123/ferricade/internal/clientapi/wire"
)

type Kind string

const (
	UnknownField Kind = "unknown-field" // a key the wire type does not know: a newer client, or a gap
	MissingField Kind = "missing-field" // a key the other side relies on is absent
	TypeMismatch Kind = "type-mismatch" // the JSON does not decode into the wire type
	NoRoute      Kind = "no-route"      // a call the harness has no wire type for
)

type Finding struct {
	Path  string
	Field string
	Kind  Kind
}

// side describes one direction of a call: the wire type, the keys that must
// be present (dotted for nesting), and key prefixes allowed beyond the type.
type side struct {
	typ      any
	required []string
	prefixes []string
}

type route struct {
	req, resp *side
}

var userResp = &side{typ: wire.UserPayload{}, required: []string{"name", "info"}}
var authResp = &side{typ: wire.AuthBody{}, required: []string{"type", "user", "user.info"}}

var routes = map[string]route{
	"POST /api/heartbeat":              {req: &side{typ: wire.HeartbeatRequest{}, required: []string{"id", "uuid", "ver"}}, resp: &side{typ: wire.HeartbeatResponse{}}},
	"POST /api/sysinfo":                {req: &side{typ: wire.SysinfoRequest{}, required: []string{"id", "uuid"}, prefixes: []string{"preset-"}}},
	"POST /api/login":                  {req: &side{typ: wire.LoginRequest{}}, resp: authResp},
	"GET /api/login-options":           {resp: &side{typ: []string{}}},
	"POST /api/oidc/auth":              {req: &side{typ: wire.OIDCAuthRequest{}, required: []string{"op", "id", "uuid"}}, resp: &side{typ: wire.OIDCAuthResponse{}, required: []string{"code", "url"}}},
	"GET /api/oidc/auth-query":         {resp: authResp},
	"POST /api/currentUser":            {req: &side{typ: wire.DeviceRef{}, required: []string{"id", "uuid"}}, resp: userResp},
	"POST /api/logout":                 {req: &side{typ: wire.DeviceRef{}, required: []string{"id", "uuid"}}},
	"GET /api/users":                   {resp: &side{typ: wire.Page[wire.UserPayload]{}, required: []string{"total", "data"}}},
	"GET /api/peers":                   {resp: &side{typ: wire.Page[wire.PeerPayload]{}, required: []string{"total", "data"}}},
	"GET /api/device-group/accessible": {resp: &side{typ: wire.Page[wire.DeviceGroupPayload]{}, required: []string{"total", "data"}}},
	"GET /api/ab":                      {resp: &side{typ: wire.LegacyAB{}, required: []string{"data"}}},
	"POST /api/ab":                     {req: &side{typ: wire.LegacyAB{}, required: []string{"data"}}},
	"POST /api/audit/conn":             {req: &side{typ: wire.ConnAudit{}, required: []string{"id", "uuid", "conn_id", "nonce"}}},
	"POST /api/audit/file":             {req: &side{typ: wire.FileAudit{}, required: []string{"id", "uuid", "conn_id", "nonce"}}},
	"POST /api/audit/alarm":            {req: &side{typ: wire.AlarmAudit{}, required: []string{"id", "uuid", "typ", "nonce"}}},
	"POST /api/devices/cli":            {req: &side{typ: wire.DevicesCLIRequest{}, required: []string{"id", "uuid"}}},
}

// Check compares a fixture's request and response with the wire types.
// Unknown keys are reported at the top level of each body only.
func Check(f Fixture) []Finding {
	r, ok := routes[f.Method+" "+f.Path]
	if !ok {
		return []Finding{{Path: f.Path, Kind: NoRoute}}
	}
	var out []Finding
	if r.req != nil && len(f.Body) > 0 {
		out = append(out, checkSide(f.Path, "", f.Body, r.req)...)
	}
	if r.resp != nil && len(f.Response) > 0 && !isError(f.Response) {
		out = append(out, checkSide(f.Path, "response.", f.Response, r.resp)...)
	}
	return out
}

func checkSide(path, prefix string, raw json.RawMessage, s *side) []Finding {
	ptr := reflect.New(reflect.TypeOf(s.typ))
	if err := json.Unmarshal(raw, ptr.Interface()); err != nil {
		return []Finding{{Path: path, Field: prefix + errField(err), Kind: TypeMismatch}}
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) != nil {
		return nil // arrays and scalars: decoding was the whole check
	}
	var out []Finding
	known := jsonKeys(reflect.TypeOf(s.typ))
	keys := make([]string, 0, len(obj))
	for k := range obj {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if !known[k] && !hasPrefix(k, s.prefixes) {
			out = append(out, Finding{Path: path, Field: prefix + k, Kind: UnknownField})
		}
	}
	for _, req := range s.required {
		if !present(obj, req) {
			out = append(out, Finding{Path: path, Field: prefix + req, Kind: MissingField})
		}
	}
	return out
}

func isError(raw json.RawMessage) bool {
	var e map[string]json.RawMessage
	if json.Unmarshal(raw, &e) != nil {
		return false
	}
	_, ok := e["error"]
	return ok
}

func errField(err error) string {
	if te, ok := err.(*json.UnmarshalTypeError); ok {
		return te.Field
	}
	return ""
}

func present(obj map[string]any, dotted string) bool {
	var cur any = obj
	for _, part := range strings.Split(dotted, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return false
		}
		if cur, ok = m[part]; !ok || cur == nil {
			return false
		}
	}
	return true
}

func hasPrefix(k string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(k, p) {
			return true
		}
	}
	return false
}

func jsonKeys(t reflect.Type) map[string]bool {
	keys := map[string]bool{}
	if t.Kind() != reflect.Struct {
		return keys
	}
	for i := 0; i < t.NumField(); i++ {
		name, _, _ := strings.Cut(t.Field(i).Tag.Get("json"), ",")
		if name != "" && name != "-" {
			keys[name] = true
		}
	}
	return keys
}
