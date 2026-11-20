package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/netip"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/dottio123/ferricade/internal/store/db"
)

// Browser sessions end five minutes after their last Lookup or event-stream
// touch and at most SessionMaxAge after creation. Persistent sessions use only
// their stored absolute expiry.
const (
	SessionIdleTimeout = 5 * time.Minute
	SessionMaxAge      = 7 * 24 * time.Hour
)

// tokenLen is the number of random bytes in a session token and a CSRF token.
const tokenLen = 32

// maxUserAgentLen bounds the stored User-Agent, in bytes.
const maxUserAgentLen = 512

// ErrNoSession is returned for a token that is malformed, unknown, idle for
// SessionIdleTimeout or past its absolute expiry.
var ErrNoSession = errors.New("auth: no session")

var tokenEncoding = base64.RawURLEncoding.Strict()

// Session is a signed-in browser session. ID is the SHA-256 of the cookie
// token; the token itself is never stored.
type Session struct {
	ID         []byte
	UserID     uuid.UUID
	CSRFToken  string
	MFAPassed  bool
	CreatedAt  time.Time
	LastSeenAt time.Time
	ExpiresAt  time.Time
	Persistent bool
	User       User
}

// Sessions creates and checks server-side sessions. Now is the clock; nil
// means time.Now. Create and Rotate require queries backed by an active
// transaction (for example store.Tx), so the settings lock lasts until the
// session write commits. Acquire locks in settings -> users -> sessions order.
type Sessions struct {
	Now func() time.Time
}

// now returns the current time in UTC, truncated to the microsecond precision
// of timestamptz so values read back from Postgres compare equal.
func (s *Sessions) now() time.Time {
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	return now().UTC().Truncate(time.Microsecond)
}

// Create starts a session for userID with mfa_passed false. It returns the
// cookie token: 32 random bytes in unpadded base64url. q must use an active
// transaction; otherwise tightening can miss a session inserted after its lock.
func (s *Sessions) Create(ctx context.Context, q *db.Queries, userID uuid.UUID, ip netip.Addr, ua string) (string, Session, error) {
	if !ip.IsValid() {
		return "", Session{}, errors.New("auth: create session: invalid ip")
	}
	settings, err := q.GetSessionSettingsForShare(ctx)
	if err != nil {
		return "", Session{}, fmt.Errorf("auth: get session settings: %w", err)
	}
	duration, _, ok := SessionLifetime(settings.Lifetime)
	if !ok {
		return "", Session{}, errors.New("auth: invalid session lifetime")
	}
	user, err := q.GetUserByIDForUpdate(ctx, userID)
	if err != nil {
		return "", Session{}, fmt.Errorf("auth: lock session user: %w", err)
	}
	now := s.now()
	return s.insert(ctx, q, db.Session{
		UserID:     userID,
		IP:         ip.WithZone(""),
		UserAgent:  sanitiseUserAgent(ua),
		CreatedAt:  now,
		LastSeenAt: now,
		ExpiresAt:  now.Add(duration),
		Persistent: settings.Lifetime != "browser" && user.TOTPSecretEnc == nil && !user.TOTPRequired,
	})
}

// insert stores row under a fresh token and CSRF token.
func (s *Sessions) insert(ctx context.Context, q *db.Queries, row db.Session) (string, Session, error) {
	token, id, err := newToken()
	if err != nil {
		return "", Session{}, err
	}
	csrf, _, err := newToken()
	if err != nil {
		return "", Session{}, err
	}
	row.ID = id
	row.CSRFToken = csrf
	if err := q.InsertSession(ctx, db.InsertSessionParams{
		ID:         row.ID,
		UserID:     row.UserID,
		CSRFToken:  row.CSRFToken,
		MFAPassed:  row.MFAPassed,
		IP:         row.IP,
		UserAgent:  row.UserAgent,
		CreatedAt:  row.CreatedAt,
		LastSeenAt: row.LastSeenAt,
		ExpiresAt:  row.ExpiresAt,
		Persistent: row.Persistent,
	}); err != nil {
		return "", Session{}, fmt.Errorf("auth: insert session: %w", err)
	}
	return token, sessionFromRow(row), nil
}

// Lookup returns the session for token and records it as seen now. A session
// non-persistent and idle for SessionIdleTimeout or more, or past its expiry, is deleted
// and reported as ErrNoSession.
func (s *Sessions) Lookup(ctx context.Context, q *db.Queries, token string) (Session, error) {
	now := s.now()
	row, user, err := s.valid(ctx, q, token, now)
	if err != nil {
		return Session{}, err
	}
	n, err := q.TouchSession(ctx, db.TouchSessionParams{ID: row.ID, LastSeenAt: now})
	if err != nil {
		return Session{}, fmt.Errorf("auth: touch session: %w", err)
	}
	if n == 0 {
		return Session{}, ErrNoSession // deleted concurrently
	}
	row.LastSeenAt = now
	out := sessionFromRow(row)
	out.User = user
	return out, nil
}

// Check reports whether the session with id (Session.ID) still exists and is
// within both expiries, without recording it as seen and without deleting an
// expired row. It is for long-lived requests such as the event stream, which
// must end with their session but must not keep it alive. It returns the
// stored row.
func (s *Sessions) Check(ctx context.Context, q *db.Queries, id []byte) (Session, error) {
	row, err := q.GetSession(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrNoSession
	}
	if err != nil {
		return Session{}, fmt.Errorf("auth: get session: %w", err)
	}
	now := s.now()
	if sessionExpired(row, now) {
		return Session{}, ErrNoSession
	}
	return sessionFromRow(row), nil
}

// Touch records an event-stream keepalive only while the session remains
// within both expiries. Unlike Lookup, it addresses the already-open session
// by its hashed ID and does not extend its absolute expiry.
func (s *Sessions) Touch(ctx context.Context, q *db.Queries, id []byte) error {
	row, err := q.GetSession(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNoSession
	}
	if err != nil {
		return fmt.Errorf("auth: get session for touch: %w", err)
	}
	now := s.now()
	if sessionExpired(row, now) {
		return ErrNoSession
	}
	n, err := q.TouchSession(ctx, db.TouchSessionParams{ID: id, LastSeenAt: now})
	if err != nil {
		return fmt.Errorf("auth: touch session: %w", err)
	}
	if n == 0 {
		return ErrNoSession
	}
	return nil
}

// Rotate replaces the session for token with one under a new token and a new
// CSRF token, with mfa_passed set to mfaPassed. The user, IP, user agent,
// and creation time carry over. Passing MFA applies the current persistence
// setting and caps the expiry without extending it. The old token stops working.
// q must use an active transaction to serialize rotation with tightening.
func (s *Sessions) Rotate(ctx context.Context, q *db.Queries, token string, mfaPassed bool) (string, Session, error) {
	// Hold the same settings lock as Create so a concurrent tightening cannot
	// miss the replacement row or be overwritten by stale session data.
	settings, err := q.GetSessionSettingsForShare(ctx)
	if err != nil {
		return "", Session{}, fmt.Errorf("auth: lock session settings for rotation: %w", err)
	}
	now := s.now()
	row, _, err := s.valid(ctx, q, token, now)
	if err != nil {
		return "", Session{}, err
	}
	// Lock the user before deleting the session, as user-management handlers do.
	if _, err := q.GetUserByIDForUpdate(ctx, row.UserID); err != nil {
		return "", Session{}, fmt.Errorf("auth: lock session user for rotation: %w", err)
	}
	// Deleting first, and requiring that this call deleted the row, means
	// that of two concurrent rotations of one token only one succeeds.
	n, err := q.DeleteSession(ctx, row.ID)
	if err != nil {
		return "", Session{}, fmt.Errorf("auth: delete session: %w", err)
	}
	if n == 0 {
		return "", Session{}, ErrNoSession
	}
	row.MFAPassed = mfaPassed
	row.LastSeenAt = now
	if mfaPassed {
		duration, _, ok := SessionLifetime(settings.Lifetime)
		if !ok {
			return "", Session{}, errors.New("auth: invalid session lifetime")
		}
		row.Persistent = settings.Lifetime != "browser"
		if cap := row.CreatedAt.Add(duration); cap.Before(row.ExpiresAt) {
			row.ExpiresAt = cap
		}
	}
	return s.insert(ctx, q, row)
}

// Delete ends the session for token. A malformed or unknown token is not an
// error.
func (s *Sessions) Delete(ctx context.Context, q *db.Queries, token string) error {
	id, ok := tokenID(token)
	if !ok {
		return nil
	}
	if _, err := q.DeleteSession(ctx, id); err != nil {
		return fmt.Errorf("auth: delete session: %w", err)
	}
	return nil
}

// DeleteForUser ends every session of userID.
func (s *Sessions) DeleteForUser(ctx context.Context, q *db.Queries, userID uuid.UUID) error {
	if err := q.DeleteUserSessions(ctx, userID); err != nil {
		return fmt.Errorf("auth: delete user sessions: %w", err)
	}
	if err := q.NotifyGrantsChanged(ctx, userID); err != nil {
		return fmt.Errorf("auth: notify session revocation: %w", err)
	}
	return nil
}

// valid loads the row for token and checks both expiries at now. An expired
// row is deleted.
func (s *Sessions) valid(ctx context.Context, q *db.Queries, token string, now time.Time) (db.Session, User, error) {
	id, ok := tokenID(token)
	if !ok {
		return db.Session{}, User{}, ErrNoSession
	}
	joined, err := q.GetSessionWithUser(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.Session{}, User{}, ErrNoSession
	}
	if err != nil {
		return db.Session{}, User{}, fmt.Errorf("auth: get session and user: %w", err)
	}
	row := db.Session{ID: joined.ID, UserID: joined.UserID, CSRFToken: joined.CSRFToken,
		MFAPassed: joined.MFAPassed, IP: joined.IP, UserAgent: joined.UserAgent,
		CreatedAt: joined.CreatedAt, LastSeenAt: joined.LastSeenAt, ExpiresAt: joined.ExpiresAt, Persistent: joined.Persistent}
	if sessionExpired(row, now) {
		if _, err := q.DeleteSession(ctx, id); err != nil {
			return db.Session{}, User{}, fmt.Errorf("auth: delete expired session: %w", err)
		}
		return db.Session{}, User{}, ErrNoSession
	}
	user := User{ID: joined.UserID, Username: joined.Username, DisplayName: joined.DisplayName, Email: joined.Email,
		Role: joined.Role, TOTPEnrolled: joined.TotpEnrolled, TOTPRequired: joined.TOTPRequired, Status: joined.Status,
		SSO: joined.Sso, AvatarUpdatedAt: joined.AvatarUpdatedAt}
	return row, user, nil
}

func sessionExpired(row db.Session, now time.Time) bool {
	return (!row.Persistent && now.Sub(row.LastSeenAt) >= SessionIdleTimeout) || !now.Before(row.ExpiresAt)
}

// newToken returns a random token in unpadded base64url and the SHA-256 of
// its raw bytes.
func newToken() (string, []byte, error) {
	var raw [tokenLen]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", nil, fmt.Errorf("auth: read random token: %w", err)
	}
	sum := sha256.Sum256(raw[:])
	return tokenEncoding.EncodeToString(raw[:]), sum[:], nil
}

// tokenID returns the session ID for token, or false when token is not the
// canonical encoding of tokenLen bytes.
func tokenID(token string) ([]byte, bool) {
	if tokenEncoding.EncodedLen(tokenLen) != len(token) {
		return nil, false
	}
	raw, err := tokenEncoding.DecodeString(token)
	if err != nil || len(raw) != tokenLen {
		return nil, false
	}
	sum := sha256.Sum256(raw)
	return sum[:], true
}

// sanitiseUserAgent makes ua storable as Postgres text, which rejects NUL and
// invalid UTF-8, and bounds it to maxUserAgentLen bytes without splitting a
// character.
func sanitiseUserAgent(ua string) string {
	ua = strings.ToValidUTF8(strings.ReplaceAll(ua, "\x00", ""), "")
	if len(ua) <= maxUserAgentLen {
		return ua
	}
	return strings.ToValidUTF8(ua[:maxUserAgentLen], "")
}

func sessionFromRow(r db.Session) Session {
	return Session{
		ID:         r.ID,
		UserID:     r.UserID,
		CSRFToken:  r.CSRFToken,
		MFAPassed:  r.MFAPassed,
		CreatedAt:  r.CreatedAt,
		LastSeenAt: r.LastSeenAt,
		ExpiresAt:  r.ExpiresAt,
		Persistent: r.Persistent,
	}
}
