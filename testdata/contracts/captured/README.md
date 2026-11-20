# Captured fixtures

Real client traffic recorded with `ferricade record` (see `docs/lab.md`).
Name files `<client-version>-<os>.jsonl`, for example `1.5.0-windows.jsonl`.

The recorder redacts passwords, tokens and secrets, but captures still
contain hostnames, IP addresses and user names from the lab machines.
Use throwaway lab machines and review a file before committing it.

`go test ./internal/contract/...` fails on `type-mismatch` and
`missing-field` findings here and logs the rest.
