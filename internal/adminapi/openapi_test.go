package adminapi

import (
	_ "embed"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
	"go.yaml.in/yaml/v3"
)

//go:embed openapi.yaml
var openapiYAML []byte

// chiParam matches a chi path parameter, with or without a regexp.
var chiParam = regexp.MustCompile(`\{([A-Za-z0-9_]+)(:[^}]*)?\}`)

// TestOpenAPICoversRoutes checks that every /admin/api/v1 and /setup route
// registered on the router is documented in openapi.yaml, and that
// openapi.yaml documents no route the router lacks.
func TestOpenAPICoversRoutes(t *testing.T) {
	var spec struct {
		Paths map[string]map[string]any `yaml:"paths"`
	}
	require.NoError(t, yaml.Unmarshal(openapiYAML, &spec))

	// A path item also holds keys that are not operations, like parameters.
	methods := map[string]bool{"get": true, "put": true, "post": true, "delete": true, "options": true, "head": true, "patch": true, "trace": true}
	documented := map[string]bool{}
	for path, ops := range spec.Paths {
		for key := range ops {
			if methods[key] {
				documented[strings.ToUpper(key)+" "+path] = true
			}
		}
	}

	routes, ok := New(Deps{Log: quietLog()}).(chi.Routes)
	require.True(t, ok, "New returns a chi router")
	registered := map[string]bool{}
	require.NoError(t, chi.Walk(routes, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if !strings.HasPrefix(route, apiPrefix+"/") && !strings.HasPrefix(route, "/setup/") {
			return nil
		}
		path := chiParam.ReplaceAllString(strings.TrimSuffix(route, "/"), "{$1}")
		registered[method+" "+path] = true
		return nil
	}))
	require.NotEmpty(t, registered)

	var undocumented, unrouted []string
	for r := range registered {
		if !documented[r] {
			undocumented = append(undocumented, r)
		}
	}
	for d := range documented {
		if !registered[d] {
			// t25 adds the OIDC contract before the server implementation lands.
			if strings.Contains(d, "/auth/oidc") || strings.Contains(d, "/settings/oidc") ||
				strings.HasSuffix(d, "/users/{id}/avatar") || strings.HasSuffix(d, "/users/{id}/oidc") {
				continue
			}
			unrouted = append(unrouted, d)
		}
	}
	sort.Strings(undocumented)
	sort.Strings(unrouted)
	require.Empty(t, undocumented, "routes missing from openapi.yaml")
	require.Empty(t, unrouted, "openapi.yaml paths with no route")
}
