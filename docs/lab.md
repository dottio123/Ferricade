# Lab: capturing RustDesk client traffic

The contract tests in `internal/contract` check our wire types against two
kinds of fixtures: ones derived from reading the RustDesk 1.5.0 source
(`testdata/contracts/derived-1.5.0`) and ones captured from real clients
(`testdata/contracts/captured`). This runbook produces the second kind.

## What you need

- A Linux machine with Docker (the lab host).
- Two or more lab machines with the RustDesk client: one Windows, at least
  one other OS. Use throwaway machines and accounts; captures keep hostnames
  and IP addresses.
- Client versions: the current release (1.5.0) and the previous minor (1.4.x).

## 1. Start the lab

`deploy/lab/docker-compose.yml` is only for capturing: its recorder takes
port 21114 in place of ferricade. To run ferricade itself with `hbbs` and
`hbbr`, use `deploy/compose.yml --profile rustdesk` as the README shows.

```sh
cd deploy/lab
export LAB_HOST=203.0.113.10      # the lab host's LAN address
export CLIENT_VERSION=1.5.0       # the client you are about to capture
mkdir -p captures data
LAB_UID=$(id -u) LAB_GID=$(id -g) docker compose up -d --build
docker compose logs hbbs | grep -A1 'Key:'   # the public key clients need, on the next line
```

Ports default to RustDesk's own: 21114 (API, the recorder), 21115 and
21116 (hbbs), and 21117 (hbbr). Override any of them with `API_PORT`,
`HBBS_NAT_PORT`, `HBBS_PORT` or `HBBR_PORT`.

## 2. Point a client at the lab

In the client, open Settings → Network → ID/Relay server and set:

- ID server: `203.0.113.10` (your `LAB_HOST`)
- Key: the key from the hbbs log
- API server: **leave empty**

The first thing to verify: with the API server empty, the client should
derive `http://<ID server>:21114` and start sending heartbeats to the
recorder within about 15 seconds. Check with `tail -f captures/captures.jsonl`.
If nothing arrives, set the API server to `http://203.0.113.10:21114` and
note the difference in your capture notes.

## 3. Capture checklist

Do each step on the controlled device (A) or the controlling device (B):

1. A and B: start the client; wait for a heartbeat and a sysinfo record.
2. B: sign in with any user name and password. The recorder accepts every
   login as a fake lab user, so the address book and device lists below
   start calling the server. (The SSO button does not appear: the recorder
   offers no providers.)
3. B: open the Address Book tab, add a peer, add a tag, rename it.
4. B: open the Accessible devices tab.
5. B: connect to A with a password; type in the session for a few seconds.
6. B: transfer one file each way.
7. B: disconnect.
8. B: enter a wrong password for A eight times within one minute (the
   alarm fires once more than six failures are counted in that minute).
9. A, as admin: run `rustdesk --assign --token test --device_group_name Lab`.

## 4. Commit the capture

```sh
docker compose down
cp captures/captures.jsonl ../../testdata/contracts/captured/1.5.0-windows.jsonl
cd ../.. && go test ./internal/contract/... -v -run Captured
```

The recorder's replies to sign-in, lists and the address book are our own
canned responses, so captures check what clients *send*; what clients
*accept* is still only checked by the derived fixtures until Phase 1 runs
against real clients.

Read the logged `unknown-field` and `no-route` findings. Each one needs a
decision written into the spec before Phase 1: model it, or note why we
ignore it. `type-mismatch` and `missing-field` fail the test and mean a
wire type is wrong.

Repeat with `CLIENT_VERSION=1.4.x` and the other OS. Clear
`captures/captures.jsonl` between runs (the recorder appends).
