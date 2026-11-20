package oidc

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

func TestMappedRoleUserGroups(t *testing.T) {
	owners, admins, users := []string{"owners"}, []string{"admins"}, []string{"viewers"}
	for _, tc := range []struct {
		groups []string
		want   string
	}{
		{[]string{"viewers"}, "user"},
		{[]string{"viewers", "admins"}, "admin"},
		{[]string{"viewers", "admins", "owners"}, "owner"},
		{[]string{"other"}, ""},
	} {
		require.Equal(t, tc.want, mappedRole(tc.groups, owners, admins, users))
	}
}

func TestResolveJITAndGroups(t *testing.T) {
	ctx := context.Background()
	pool := store.NewTestDB(t)
	now := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	s := Settings{OwnerGroups: []string{"/team/owners"}, AdminGroups: []string{"authors"}, JITEnabled: true}
	c := Claims{Subject: "sub-1", Name: "Kilgore Trout", Groups: []string{"/team/owners"}, GroupsClaimPresent: true}
	var out Outcome
	err := store.Tx(ctx, pool, func(q *db.Queries) error {
		var err error
		out, err = Resolve(ctx, q, s, "https://issuer.example", c, now)
		return err
	})
	require.NoError(t, err)
	require.True(t, out.Created)
	require.Equal(t, "owner", out.RoleTo)
	require.NotEmpty(t, out.UserID)
	u, err := db.New(pool).GetUserByID(ctx, out.UserID)
	require.NoError(t, err)
	require.Equal(t, "Kilgore Trout", u.DisplayName)
	require.Equal(t, "owner", u.Role)
	require.Nil(t, u.PasswordHash)
	require.Equal(t, "", u.Email)
	require.Equal(t, "https://issuer.example", *u.OidcIssuer)
	require.Equal(t, "sub-1", *u.OidcSubject)

	c.Groups = nil
	c.GroupsClaimPresent = false
	err = store.Tx(ctx, pool, func(q *db.Queries) error {
		var err error
		out, err = Resolve(ctx, q, s, "https://issuer.example", c, now)
		return err
	})
	require.NoError(t, err)
	require.Equal(t, "not_allowed", out.Refusal)
	require.Equal(t, "no_groups_claim", out.Reason)
}

func TestResolveLinkingRolesAndUsername(t *testing.T) {
	ctx := context.Background()
	pool := store.NewTestDB(t)
	q := db.New(pool)
	now := time.Now()
	issuer := "https://issuer.example"
	s := Settings{OwnerGroups: []string{"owners"}, AdminGroups: []string{"admins"}, JITEnabled: true}
	resolve := func(c Claims, settings Settings) Outcome {
		t.Helper()
		var out Outcome
		err := store.Tx(ctx, pool, func(q *db.Queries) error {
			var err error
			out, err = Resolve(ctx, q, settings, issuer, c, now)
			return err
		})
		require.NoError(t, err)
		return out
	}
	pass := "password hash"
	local, err := q.CreateUser(ctx, db.CreateUserParams{Username: "local", Email: "Alice@Example.com", Role: "admin", PasswordHash: &pass})
	require.NoError(t, err)
	linked := resolve(Claims{Subject: "one", Email: "alice@example.com", EmailVerified: true, Groups: []string{"owners"}, GroupsClaimPresent: true}, s)
	require.Equal(t, local.ID, linked.UserID)
	require.True(t, linked.Linked)
	require.Equal(t, "admin", linked.RoleFrom)
	require.Equal(t, "owner", linked.RoleTo)
	row, err := q.GetUserByID(ctx, local.ID)
	require.NoError(t, err)
	require.Equal(t, "owner", row.Role)
	require.Equal(t, "one", *row.OidcSubject)
	conflict := resolve(Claims{Subject: "changed-sub", Email: "alice@example.com", EmailVerified: true,
		Groups: []string{"admins"}, GroupsClaimPresent: true}, s)
	require.Equal(t, "account_conflict", conflict.Refusal)
	require.Equal(t, "linked_elsewhere", conflict.Reason)
	require.Equal(t, local.ID, conflict.UserID)
	require.False(t, conflict.Created)

	refused := resolve(Claims{Subject: "one", Groups: []string{"admins"}, GroupsClaimPresent: true}, s)
	require.Equal(t, "not_allowed", refused.Refusal)
	require.Equal(t, "last_owner", refused.Reason)
	row, err = q.GetUserByID(ctx, local.ID)
	require.NoError(t, err)
	require.Equal(t, "owner", row.Role)

	_, err = q.CreateUser(ctx, db.CreateUserParams{Username: "taken", Role: "admin", PasswordHash: &pass})
	require.NoError(t, err)
	created := resolve(Claims{Subject: "two", PreferredUsername: "taken", Groups: []string{"admins"}, GroupsClaimPresent: true}, s)
	require.True(t, created.Created)
	row, err = q.GetUserByID(ctx, created.UserID)
	require.NoError(t, err)
	require.Equal(t, "taken-2", row.Username)
	secondOwner := resolve(Claims{Subject: "three", Groups: []string{"owners"}, GroupsClaimPresent: true}, s)
	require.True(t, secondOwner.Created)
	require.Contains(t, func() string { u, _ := q.GetUserByID(ctx, secondOwner.UserID); return u.Username }(), "user-")
	demoted := resolve(Claims{Subject: "one", Groups: []string{"admins"}, GroupsClaimPresent: true}, s)
	require.Empty(t, demoted.Refusal)
	row, err = q.GetUserByID(ctx, local.ID)
	require.NoError(t, err)
	require.Equal(t, "admin", row.Role)

	noJIT := s
	noJIT.JITEnabled = false
	require.Equal(t, "no_account", resolve(Claims{Subject: "no-account", Groups: []string{"admins"}, GroupsClaimPresent: true}, noJIT).Refusal)
	unverified := resolve(Claims{Subject: "four", Email: "unverified@example.com", Groups: []string{"admins"}, GroupsClaimPresent: true}, s)
	require.True(t, unverified.Created)
	require.NotEqual(t, local.ID, unverified.UserID)
	unverifiedRow, err := q.GetUserByID(ctx, unverified.UserID)
	require.NoError(t, err)
	require.Equal(t, "unverified@example.com", unverifiedRow.Email)
	require.True(t, unverifiedRow.EmailUnverified)
	noJIT.JITEnabled = false
	unlinkable := resolve(Claims{Subject: "unverified-link", Email: "unverified@example.com", EmailVerified: true,
		Groups: []string{"admins"}, GroupsClaimPresent: true}, noJIT)
	require.Equal(t, "no_account", unlinkable.Refusal)
	_, err = q.UpdateUserProfile(ctx, db.UpdateUserProfileParams{ID: unverifiedRow.ID,
		DisplayName: unverifiedRow.DisplayName, Email: unverifiedRow.Email, Role: unverifiedRow.Role,
		Status: unverifiedRow.Status, TOTPRequired: unverifiedRow.TOTPRequired, EmailEdited: true})
	require.NoError(t, err)
	verifiedRow, err := q.GetUserByID(ctx, unverifiedRow.ID)
	require.NoError(t, err)
	require.False(t, verifiedRow.EmailUnverified)
	matches, err := q.GetUsersByEmail(ctx, "unverified@example.com")
	require.NoError(t, err)
	require.Len(t, matches, 1)
	require.Equal(t, unverifiedRow.ID, matches[0].ID)
	_, err = q.CreateUser(ctx, db.CreateUserParams{Username: "duplicate", Email: "Alice@Example.com", Role: "admin", PasswordHash: &pass})
	require.NoError(t, err)
	ambiguous := resolve(Claims{Subject: "five", Email: "Alice@Example.com", EmailVerified: true, Groups: []string{"admins"}, GroupsClaimPresent: true}, s)
	require.Equal(t, "account_conflict", ambiguous.Refusal)
	require.Equal(t, "ambiguous_email", ambiguous.Reason)
	_, err = pool.Exec(ctx, "UPDATE users SET status='disabled' WHERE id=$1", created.UserID)
	require.NoError(t, err)
	disabled := resolve(Claims{Subject: "two", Groups: []string{"admins"}, GroupsClaimPresent: true}, s)
	require.Equal(t, "disabled", disabled.Refusal)
	require.Equal(t, created.UserID, disabled.UserID)
}

func TestOIDCUsernameNormalization(t *testing.T) {
	for raw, want := range map[string]string{
		"a b": "ab", "aéb": "ab", "a\u202eb": "ab", "": "", "!☃": "",
	} {
		require.Equal(t, want, cleanUsername(raw))
	}
	require.Len(t, cleanUsername(strings.Repeat("a", 100))[:64], 64)
}

func TestResolveJITUsernameBounds(t *testing.T) {
	ctx := context.Background()
	pool := store.NewTestDB(t)
	s := Settings{AdminGroups: []string{"admins"}, JITEnabled: true}
	for _, raw := range []string{"a b", "aéb", "a\u202eb", strings.Repeat("x", 100), ""} {
		out, err := Resolve(ctx, db.New(pool), s, "https://issuer.example", Claims{
			Subject: "sub-" + raw, PreferredUsername: raw, Groups: []string{"admins"}, GroupsClaimPresent: true,
		}, time.Now())
		require.NoError(t, err)
		require.True(t, out.Created)
		u, err := db.New(pool).GetUserByID(ctx, out.UserID)
		require.NoError(t, err)
		require.NoError(t, auth.ValidateUsername(u.Username))
		if raw == "" {
			require.Regexp(t, `^user-[0-9a-f]{8}$`, u.Username)
		}
	}
}
