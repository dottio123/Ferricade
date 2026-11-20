package setup

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/mail"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

// Settings keys. KeyOwnerTOTPVerified records that the wizard's owner proved
// possession of the TOTP secret now stored for it; BeginOwnerTOTP,
// CreateOwner and ForgetOwnerTOTP clear it, so a replaced secret must be
// verified again.
const (
	KeySetupComplete     = "setup_complete"
	KeyEnrollmentPolicy  = "enrollment_policy"
	KeyOwnerTOTPVerified = "setup_owner_totp_verified"
)

// Audit actions written by the wizard.
const (
	ActionOwnerCreated = "setup.owner_created"
	ActionServerSaved  = "setup.server_saved"
	ActionCompleted    = "setup.completed"
	ActionTOTPEnrolled = "auth.totp_enrolled"
)

// Field limits.
const (
	maxPasswordBytes   = 1024
	maxDisplayNameLen  = 128 // characters
	maxEmailLen        = 254
	maxServerNameLen   = 128 // characters
	defaultServerName  = "default"
	ownerRole          = "owner"
	targetTypeUser     = "user"
	targetTypeServer   = "server"
	serverKeyBytes     = 32
	enrollmentApproval = `"approval"`
)

var (
	// ErrIncomplete means a step's prerequisites are missing: no owner yet, an
	// unverified owner TOTP, or no server.
	ErrIncomplete = errors.New("setup: incomplete")
	// ErrComplete means setup has finished; every step is refused.
	ErrComplete = errors.New("setup: already complete")
	// ErrInvalidKey means the public key is not base64 of 32 bytes.
	ErrInvalidKey = errors.New("setup: public key must be base64 of 32 bytes")
	// ErrInvalidCode means a TOTP code was wrong.
	ErrInvalidCode = errors.New("setup: invalid TOTP code")
	// ErrCodeUsed means a TOTP code was right but its time step was already
	// used; the next code will work.
	ErrCodeUsed = errors.New("setup: TOTP code already used")
)

// InputError is a request field that fails validation. Its text is meant for
// the person filling in the wizard.
type InputError string

func (e InputError) Error() string { return string(e) }

// dnsLabel is one label of a host name: letters, digits and '-', 1 to 63
// characters, not starting or ending with '-'.
var dnsLabel = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)

// maxDNSName is the longest host name accepted, in bytes.
const maxDNSName = 253

// Service performs the wizard's steps. Every write runs in a transaction that
// first takes the setup advisory lock and checks that setup is not complete,
// so steps are serialised and none can land after Finish.
type Service struct {
	Pool   *pgxpool.Pool
	Sealer *auth.Sealer
	Params auth.Params
	Now    func() time.Time // defaults to time.Now
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// Complete reports whether setup has finished.
func (s *Service) Complete(ctx context.Context) (bool, error) {
	return complete(ctx, db.New(s.Pool))
}

// ServerID returns the server profile's ID, and false until setup is complete.
func (s *Service) ServerID(ctx context.Context) (uuid.UUID, bool, error) {
	q := db.New(s.Pool)
	done, err := complete(ctx, q)
	if err != nil || !done {
		return uuid.Nil, false, err
	}
	srv, err := q.GetServer(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, false, nil
	}
	if err != nil {
		return uuid.Nil, false, fmt.Errorf("setup: get server: %w", err)
	}
	return srv.ID, true, nil
}

// CreateOwner creates the owner account, with TOTP required. Run again before
// setup completes, it overwrites that same owner (and drops its TOTP secret
// and sessions), so the wizard can be restarted. The password must pass
// auth.ValidatePassword (auth.IsWeakPassword matches its errors); other bad
// fields give an InputError. ip is the actor's address for the audit log.
func (s *Service) CreateOwner(ctx context.Context, username, password, displayName, email string, ip netip.Addr) (uuid.UUID, error) {
	if err := validateOwner(username, password, displayName, email); err != nil {
		return uuid.Nil, err
	}
	hash, err := auth.HashPassword(ctx, password, s.Params)
	if err != nil {
		return uuid.Nil, fmt.Errorf("setup: hash password: %w", err)
	}
	var id uuid.UUID
	err = s.tx(ctx, func(q *db.Queries) error {
		owner, err := q.GetFirstOwner(ctx)
		replaced := err == nil
		switch {
		case replaced:
			id = owner.ID
			if err := q.ReplaceSetupOwner(ctx, db.ReplaceSetupOwnerParams{
				ID: id, Username: username, DisplayName: displayName, Email: email, PasswordHash: &hash,
			}); err != nil {
				return fmt.Errorf("setup: replace owner: %w", err)
			}
			if err := q.DeleteUserSessions(ctx, id); err != nil {
				return fmt.Errorf("setup: end owner sessions: %w", err)
			}
		case errors.Is(err, pgx.ErrNoRows):
			row, err := q.CreateUser(ctx, db.CreateUserParams{
				Username: username, DisplayName: displayName, Email: email,
				Role: ownerRole, PasswordHash: &hash, TOTPRequired: true,
			})
			if err != nil {
				return fmt.Errorf("setup: create owner: %w", err)
			}
			id = row.ID
		default:
			return fmt.Errorf("setup: get owner: %w", err)
		}
		if err := putBool(ctx, q, KeyOwnerTOTPVerified, false); err != nil {
			return err
		}
		return audit.Record(ctx, q, audit.Event{
			ActorIP: ip, Action: ActionOwnerCreated, TargetType: targetTypeUser, TargetID: id.String(),
			Details: map[string]any{"username": username, "replaced": replaced},
		})
	})
	if err != nil {
		return uuid.Nil, err
	}
	return id, nil
}

// BeginOwnerTOTP generates a TOTP secret for the owner and stores it sealed,
// replacing any earlier one, which then needs VerifyOwnerTOTP again. It
// returns the secret and its otpauth:// URL. It is ErrIncomplete before
// CreateOwner. Nothing is audited until the secret is verified.
func (s *Service) BeginOwnerTOTP(ctx context.Context) (secret, url string, err error) {
	secret, err = auth.NewTOTPSecret()
	if err != nil {
		return "", "", err
	}
	sealed, err := s.Sealer.Seal([]byte(secret))
	if err != nil {
		return "", "", fmt.Errorf("setup: seal totp secret: %w", err)
	}
	err = s.tx(ctx, func(q *db.Queries) error {
		owner, err := getOwner(ctx, q)
		if err != nil {
			return err
		}
		if err := q.SetTOTP(ctx, db.SetTOTPParams{ID: owner.ID, TOTPSecretEnc: sealed}); err != nil {
			return fmt.Errorf("setup: store totp secret: %w", err)
		}
		url = auth.TOTPURL(owner.Username, secret)
		return putBool(ctx, q, KeyOwnerTOTPVerified, false)
	})
	if err != nil {
		return "", "", err
	}
	return secret, url, nil
}

// VerifyOwnerTOTP checks code against the owner's stored secret and marks it
// verified. The accepted step is stored in totp_last_step, so the same code
// cannot be used again. A wrong code gives ErrInvalidCode, a right code for an
// already used step ErrCodeUsed; no owner or no secret gives ErrIncomplete.
func (s *Service) VerifyOwnerTOTP(ctx context.Context, code string, ip netip.Addr) error {
	now := s.now()
	return s.tx(ctx, func(q *db.Queries) error {
		owner, err := getOwner(ctx, q)
		if err != nil {
			return err
		}
		if owner.TOTPSecretEnc == nil {
			return ErrIncomplete
		}
		secret, err := s.Sealer.Open(owner.TOTPSecretEnc)
		if err != nil {
			return fmt.Errorf("setup: open totp secret: %w", err)
		}
		step, ok := auth.VerifyTOTP(string(secret), code, now, -1)
		if !ok {
			return ErrInvalidCode
		}
		if step <= owner.TOTPLastStep {
			return ErrCodeUsed
		}
		n, err := q.SetTOTPLastStep(ctx, db.SetTOTPLastStepParams{ID: owner.ID, Step: step})
		if err != nil {
			return fmt.Errorf("setup: store totp step: %w", err)
		}
		if n == 0 {
			return ErrCodeUsed // a concurrent use of the code won
		}
		if err := putBool(ctx, q, KeyOwnerTOTPVerified, true); err != nil {
			return err
		}
		return audit.Record(ctx, q, audit.Event{
			ActorIP: ip, Action: ActionTOTPEnrolled, TargetType: targetTypeUser, TargetID: owner.ID.String(),
		})
	})
}

// ServerProfile is a validated server profile, as ValidateServer returns it.
type ServerProfile struct {
	Name, IDHost, RelayHost, PublicKey string
}

// ValidateServer checks and normalises a server profile. Hosts are trimmed
// and must be non-empty host[:port] values (InputError otherwise); the public
// key must be base64 of 32 bytes (ErrInvalidKey) and is returned in padded
// standard base64. An empty name becomes "default".
func ValidateServer(name, idHost, relayHost, publicKey string) (ServerProfile, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = defaultServerName
	}
	if !printable(name, maxServerNameLen) {
		return ServerProfile{}, InputError(fmt.Sprintf("name must be at most %d printable characters", maxServerNameLen))
	}
	idHost, relayHost = strings.TrimSpace(idHost), strings.TrimSpace(relayHost)
	if err := validateHost("id_host", idHost); err != nil {
		return ServerProfile{}, err
	}
	if err := validateHost("relay_host", relayHost); err != nil {
		return ServerProfile{}, err
	}
	key, err := canonicalKey(publicKey)
	if err != nil {
		return ServerProfile{}, err
	}
	return ServerProfile{Name: name, IDHost: idHost, RelayHost: relayHost, PublicKey: key}, nil
}

// SaveServer validates the server profile with ValidateServer and stores it,
// creating it or updating the one that exists.
func (s *Service) SaveServer(ctx context.Context, name, idHost, relayHost, publicKey string, ip netip.Addr) (uuid.UUID, error) {
	p, err := ValidateServer(name, idHost, relayHost, publicKey)
	if err != nil {
		return uuid.Nil, err
	}
	name, idHost, relayHost, key := p.Name, p.IDHost, p.RelayHost, p.PublicKey

	var id uuid.UUID
	err = s.tx(ctx, func(q *db.Queries) error {
		srv, err := q.GetServer(ctx)
		switch {
		case err == nil:
			srv, err = q.UpdateServer(ctx, db.UpdateServerParams{
				ID: srv.ID, Name: name, IDHost: idHost, RelayHost: relayHost, PublicKey: key, ApiUrl: srv.ApiUrl,
				LinksIncludeServer: srv.LinksIncludeServer,
			})
		case errors.Is(err, pgx.ErrNoRows):
			srv, err = q.CreateServer(ctx, db.CreateServerParams{
				Name: name, IDHost: idHost, RelayHost: relayHost, PublicKey: key,
			})
		}
		if err != nil {
			return fmt.Errorf("setup: save server: %w", err)
		}
		id = srv.ID
		return audit.Record(ctx, q, audit.Event{
			ActorIP: ip, Action: ActionServerSaved, TargetType: targetTypeServer, TargetID: id.String(),
			Details: map[string]any{"name": name, "id_host": idHost, "relay_host": relayHost, "public_key": key},
		})
	})
	if err != nil {
		return uuid.Nil, err
	}
	return id, nil
}

// Finish marks setup complete. It needs an owner with a verified TOTP secret
// and a saved server, and returns ErrIncomplete otherwise. It also sets the
// enrollment policy to "approval", the only policy in Phase 1.
func (s *Service) Finish(ctx context.Context, ip netip.Addr) error {
	return s.tx(ctx, func(q *db.Queries) error {
		owner, err := getOwner(ctx, q)
		if err != nil {
			return err
		}
		verified, err := getBool(ctx, q, KeyOwnerTOTPVerified)
		if err != nil {
			return err
		}
		if owner.TOTPSecretEnc == nil || !verified {
			return ErrIncomplete
		}
		srv, err := q.GetServer(ctx)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrIncomplete
		}
		if err != nil {
			return fmt.Errorf("setup: get server: %w", err)
		}
		if err := putBool(ctx, q, KeySetupComplete, true); err != nil {
			return err
		}
		if err := q.PutSetting(ctx, db.PutSettingParams{Key: KeyEnrollmentPolicy, Value: []byte(enrollmentApproval)}); err != nil {
			return fmt.Errorf("setup: store enrollment policy: %w", err)
		}
		return audit.Record(ctx, q, audit.Event{
			ActorIP: ip, Action: ActionCompleted, TargetType: targetTypeServer, TargetID: srv.ID.String(),
			Details: map[string]any{"owner_id": owner.ID.String()},
		})
	})
}

// ForgetOwnerTOTP is for an operator's TOTP reset of user id, run in the
// reset's transaction: while setup is incomplete and id is the wizard's
// owner, the owner's TOTP no longer counts as verified, so Finish needs a new
// one. It reports whether it cleared the flag. It takes the setup lock, so
// call it (or q.LockSetup) before locking the user's row, as the wizard does.
func ForgetOwnerTOTP(ctx context.Context, q *db.Queries, id uuid.UUID) (bool, error) {
	if err := q.LockSetup(ctx); err != nil {
		return false, fmt.Errorf("setup: lock: %w", err)
	}
	done, err := complete(ctx, q)
	if err != nil || done {
		return false, err
	}
	owner, err := q.GetFirstOwner(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("setup: get owner: %w", err)
	}
	if owner.ID != id {
		return false, nil
	}
	return true, putBool(ctx, q, KeyOwnerTOTPVerified, false)
}

// tx runs fn under the setup lock, refusing with ErrComplete once setup has
// finished.
func (s *Service) tx(ctx context.Context, fn func(q *db.Queries) error) error {
	return store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		if err := q.LockSetup(ctx); err != nil {
			return fmt.Errorf("setup: lock: %w", err)
		}
		done, err := complete(ctx, q)
		if err != nil {
			return err
		}
		if done {
			return ErrComplete
		}
		return fn(q)
	})
}

func complete(ctx context.Context, q *db.Queries) (bool, error) {
	return getBool(ctx, q, KeySetupComplete)
}

func getOwner(ctx context.Context, q *db.Queries) (db.User, error) {
	owner, err := q.GetFirstOwner(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.User{}, ErrIncomplete
	}
	if err != nil {
		return db.User{}, fmt.Errorf("setup: get owner: %w", err)
	}
	return owner, nil
}

// getBool reads a boolean setting; a missing key is false.
func getBool(ctx context.Context, q *db.Queries, key string) (bool, error) {
	raw, err := q.GetSetting(ctx, key)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("setup: get %s: %w", key, err)
	}
	var v bool
	if err := json.Unmarshal(raw, &v); err != nil {
		return false, fmt.Errorf("setup: decode %s: %w", key, err)
	}
	return v, nil
}

func putBool(ctx context.Context, q *db.Queries, key string, v bool) error {
	raw, _ := json.Marshal(v)
	if err := q.PutSetting(ctx, db.PutSettingParams{Key: key, Value: raw}); err != nil {
		return fmt.Errorf("setup: put %s: %w", key, err)
	}
	return nil
}

func validateOwner(username, password, displayName, email string) error {
	if err := auth.ValidateUsername(username); err != nil {
		return InputError(err.Error())
	}
	if len(password) > maxPasswordBytes {
		return InputError(fmt.Sprintf("password must be at most %d bytes", maxPasswordBytes))
	}
	if err := auth.ValidatePassword(username, password); err != nil {
		return err
	}
	return ValidateProfile(displayName, email)
}

// ValidateProfile checks a user's display name (at most 128 printable
// characters) and email (empty, or a bare address of at most 254 bytes). A bad
// field gives an InputError.
func ValidateProfile(displayName, email string) error {
	if !printable(displayName, maxDisplayNameLen) {
		return InputError(fmt.Sprintf("display_name must be at most %d printable characters", maxDisplayNameLen))
	}
	if email != "" {
		addr, err := mail.ParseAddress(email)
		if err != nil || addr.Name != "" || addr.Address != email || len(email) > maxEmailLen {
			return InputError("email is not a valid address")
		}
	}
	return nil
}

// printable reports whether s is valid UTF-8 of at most max characters with
// no control characters.
func printable(s string, max int) bool {
	if !utf8.ValidString(s) || utf8.RuneCountInString(s) > max {
		return false
	}
	return strings.IndexFunc(s, unicode.IsControl) < 0
}

// validateHost accepts a host name, an IPv4 address or an IPv6 address
// (bare, or in brackets), optionally followed by ":port" with port 1-65535
// (an IPv6 address with a port must be in brackets).
func validateHost(field, host string) error {
	if host == "" {
		return InputError(field + " is required")
	}
	if !validHostPort(host) {
		return InputError(field + " must be a host name or IP address, optionally with :port (1-65535)")
	}
	return nil
}

func validHostPort(s string) bool {
	if name, port, err := net.SplitHostPort(s); err == nil {
		bracketed := strings.HasPrefix(s, "[")
		return validPort(port) && validHostName(name, bracketed)
	}
	if strings.HasPrefix(s, "[") && strings.HasSuffix(s, "]") {
		return validHostName(s[1:len(s)-1], true)
	}
	if strings.Contains(s, ":") { // only a bare IPv6 address has colons without a port
		ip, err := netip.ParseAddr(s)
		return err == nil && ip.Is6() && !ip.Is4In6() && ip.Zone() == ""
	}
	return validHostName(s, false)
}

// validPort reports whether p is a decimal port number 1-65535.
func validPort(p string) bool {
	if p == "" || len(p) > 5 || strings.Trim(p, "0123456789") != "" {
		return false
	}
	n, err := strconv.Atoi(p)
	return err == nil && n >= 1 && n <= 65535
}

// validHostName reports whether h is an IP address without a zone (IPv6 only
// when bracketed is set, and then required) or a DNS name.
func validHostName(h string, bracketed bool) bool {
	if ip, err := netip.ParseAddr(h); err == nil {
		return ip.Zone() == "" && ip.Is6() == bracketed && !ip.Is4In6()
	}
	if bracketed || h == "" || len(h) > maxDNSName {
		return false
	}
	for _, label := range strings.Split(h, ".") {
		if !dnsLabel.MatchString(label) {
			return false
		}
	}
	return true
}

// canonicalKey decodes a padded or unpadded standard base64 key of 32 bytes
// and returns it padded.
func canonicalKey(k string) (string, error) {
	k = strings.TrimSpace(k)
	raw, err := base64.StdEncoding.Strict().DecodeString(k)
	if err != nil {
		raw, err = base64.RawStdEncoding.Strict().DecodeString(k)
	}
	if err != nil || len(raw) != serverKeyBytes {
		return "", ErrInvalidKey
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}
