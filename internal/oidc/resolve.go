package oidc

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/dottio123/ferricade/internal/store/db"
)

type Claims struct {
	Subject, Email, Name, PreferredUsername, Picture string
	EmailVerified                                    bool
	Groups                                           []string
	GroupsClaimPresent                               bool
	AccessToken                                      string `json:"-"`
}

type Outcome struct {
	UserID           uuid.UUID
	Created, Linked  bool
	MatchedByOIDC    bool
	RoleFrom, RoleTo string
	Refusal, Reason  string
}

func mappedRole(groups, owners, admins, users []string) string {
	for _, g := range groups {
		for _, allowed := range owners {
			if g == allowed {
				return "owner"
			}
		}
	}
	for _, g := range groups {
		for _, allowed := range admins {
			if g == allowed {
				return "admin"
			}
		}
	}
	for _, g := range groups {
		for _, allowed := range users {
			if g == allowed {
				return "user"
			}
		}
	}
	return ""
}

// Resolve uses the caller's transactional Queries. The caller records audit
// rows and revokes sessions in the same transaction, using the returned facts.
func Resolve(ctx context.Context, q *db.Queries, s Settings, issuer string, c Claims, now time.Time) (Outcome, error) {
	_ = now
	out := Outcome{RoleTo: mappedRole(c.Groups, s.OwnerGroups, s.AdminGroups, s.UserGroups)}
	if c.Subject == "" {
		return out, fmt.Errorf("oidc subject is empty")
	}
	var user db.User
	var found bool
	var err error
	user, err = q.GetUserByOIDC(ctx, db.GetUserByOIDCParams{OidcIssuer: &issuer, OidcSubject: &c.Subject})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return out, fmt.Errorf("look up oidc identity: %w", err)
	}
	found = err == nil
	out.MatchedByOIDC = found
	if !found && c.EmailVerified && c.Email != "" {
		matches, err := q.GetUsersByEmail(ctx, c.Email)
		if err != nil {
			return out, fmt.Errorf("look up verified email: %w", err)
		}
		if len(matches) == 1 {
			user = matches[0]
			out.UserID, out.RoleFrom = user.ID, user.Role
			if user.OidcIssuer == nil && user.OidcSubject == nil {
				found = true
			} else {
				out.Refusal, out.Reason = "account_conflict", "linked_elsewhere"
				return out, nil
			}
		} else if len(matches) > 1 {
			out.Refusal, out.Reason = "account_conflict", "ambiguous_email"
			return out, nil
		}
	}
	if out.RoleTo == "" {
		out.Refusal = "not_allowed"
		if !c.GroupsClaimPresent {
			out.Reason = "no_groups_claim"
		} else {
			out.Reason = "no_mapped_group"
		}
		if found {
			out.UserID = user.ID
			out.RoleFrom = user.Role
		}
		return out, nil
	}
	if found && user.Status != "active" {
		out.UserID, out.RoleFrom, out.Refusal, out.Reason = user.ID, user.Role, "disabled", "disabled"
		return out, nil
	}
	if !found {
		if !s.JITEnabled {
			out.Refusal = "no_account"
			if out.Reason == "" {
				out.Reason = "no_account"
			}
			return out, nil
		}
		base := c.PreferredUsername
		if base == "" {
			base, _, _ = strings.Cut(c.Email, "@")
		}
		base = cleanUsername(base)
		if base == "" {
			hash := sha256.Sum256([]byte(c.Subject))
			base = fmt.Sprintf("user-%x", hash[:4])
		}
		for n := 1; ; n++ {
			name := base[:min(len(base), 64)]
			if n > 1 {
				suffix := "-" + strconv.Itoa(n)
				name = base[:min(len(base), 64-len(suffix))] + suffix
			}
			user, err = q.CreateOIDCUser(ctx, db.CreateOIDCUserParams{
				Username: name, DisplayName: c.Name, Email: c.Email, EmailUnverified: !c.EmailVerified, Role: out.RoleTo,
				Issuer: &issuer, Subject: &c.Subject,
			})
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			if err != nil {
				return out, fmt.Errorf("create oidc user: %w", err)
			}
			break
		}
		out.Created = true
	}
	out.UserID = user.ID
	out.RoleFrom = user.Role
	if user.Role != out.RoleTo {
		if user.Role == "owner" && user.Status == "active" {
			count, err := q.CountActiveOwners(ctx)
			if err != nil {
				return out, fmt.Errorf("count owners: %w", err)
			}
			if count <= 1 {
				out.Refusal, out.Reason = "not_allowed", "last_owner"
				return out, nil
			}
		}
	}
	if found && user.OidcIssuer == nil {
		user, err = q.LinkUserOIDC(ctx, db.LinkUserOIDCParams{ID: user.ID, Issuer: &issuer, Subject: &c.Subject})
		if err != nil {
			return out, fmt.Errorf("link oidc user: %w", err)
		}
		out.Linked = true
	}
	if user.Role != out.RoleTo {
		if _, err := q.SetOIDCRole(ctx, db.SetOIDCRoleParams{ID: user.ID, Role: out.RoleTo}); err != nil {
			return out, fmt.Errorf("set oidc role: %w", err)
		}
	}
	return out, nil
}

func cleanUsername(raw string) string {
	var b strings.Builder
	for _, c := range raw {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' ||
			c == '.' || c == '_' || c == '@' || c == '-' {
			b.WriteRune(c)
		}
	}
	return b.String()
}
