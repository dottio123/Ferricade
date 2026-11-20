module github.com/dottio123/ferricade

go 1.26.0

// npm dependencies can ship Go files (web/node_modules/flatted); keep them out of ./...
ignore ./web/node_modules

require (
	github.com/coreos/go-oidc/v3 v3.21.0
	github.com/go-chi/chi/v5 v5.3.2
	github.com/google/uuid v1.6.0
	github.com/jackc/pgx/v5 v5.11.0
	github.com/pb33f/libopenapi v0.41.3
	github.com/pb33f/libopenapi-validator v0.15.2
	github.com/pressly/goose/v3 v3.28.0
	github.com/stretchr/testify v1.12.1
	go.yaml.in/yaml/v3 v3.0.5
	golang.org/x/crypto v0.59.0
	golang.org/x/oauth2 v0.37.0
	golang.org/x/sys v0.50.0
	golang.org/x/time v0.16.0
	google.golang.org/protobuf v1.36.12
)

require (
	github.com/bahlo/generic-list-go v0.2.0 // indirect
	github.com/basgys/goxml2json v1.1.1-0.20231018121955-e66ee54ceaad // indirect
	github.com/buger/jsonparser v1.1.2 // indirect
	github.com/go-jose/go-jose/v4 v4.1.4 // indirect
	github.com/go-openapi/jsonpointer v1.0.2 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/mfridman/interpolate v0.0.2 // indirect
	github.com/pb33f/go-yaml v0.1.1 // indirect
	github.com/pb33f/jsonpath v0.8.4 // indirect
	github.com/pb33f/jsonschema/v6 v6.0.3 // indirect
	github.com/pb33f/ordered-map/v2 v2.3.2 // indirect
	github.com/sethvargo/go-retry v0.4.0 // indirect
	go.uber.org/multierr v1.11.0 // indirect
	golang.org/x/net v0.62.0 // indirect
	golang.org/x/sync v0.25.0 // indirect
	golang.org/x/text v0.44.0 // indirect
)
