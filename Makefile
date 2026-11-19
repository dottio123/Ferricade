.PHONY: test vet build sqlc test-db web web-dev

SQLC := go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1

test:
	go test -race ./...

vet:
	go vet ./...

build:
	CGO_ENABLED=0 go build -o bin/ ./cmd/...

# Build the web UI into web/dist; the next `make build` embeds it. Without it,
# the binary serves a one-line notice at / instead of the console.
web:
	cd web && npm ci && npm run build

# The web UI's dev server (http://localhost:5173) with the mock API; no ferricade needed.
web-dev:
	cd web && npm run dev

# Regenerate internal/store/db from sqlc.yaml. The output is committed.
sqlc:
	$(SQLC) generate

# Start a Postgres 16 for the store tests. Then run, for example:
#   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres?sslmode=disable REQUIRE_DB=1 make test
test-db:
	docker run -d --name ferricade-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
