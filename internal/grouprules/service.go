package grouprules

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

const (
	ActionRuleAdded   = "group.rule_added"
	ActionRuleRemoved = "group.rule_removed"
)

var ErrPatternTaken = errors.New("grouprules: pattern already exists")

type Service struct{ Pool *pgxpool.Pool }
type UserRef struct {
	ID          uuid.UUID `json:"id"`
	DisplayName string    `json:"display_name"`
}
type RuleView struct {
	Rule
	CreatedAt time.Time `json:"created_at"`
	CreatedBy *UserRef  `json:"created_by"`
}
type RuleDeviceRef struct {
	ID         uuid.UUID  `json:"id"`
	RustdeskID string     `json:"rustdesk_id"`
	Hostname   string     `json:"hostname"`
	Alias      string     `json:"alias"`
	State      string     `json:"state"`
	GroupID    *uuid.UUID `json:"group_id"`
}
type Conflict struct {
	Device RuleDeviceRef      `json:"device"`
	Groups []devices.GroupRef `json:"groups"`
}
type RulePreview struct {
	MatchCount    int             `json:"match_count"`
	ConflictCount int             `json:"conflict_count"`
	Matches       []RuleDeviceRef `json:"matches"`
	Conflicts     []Conflict      `json:"conflicts"`
}

func (s *Service) List(ctx context.Context) ([]RuleView, error) {
	rows, err := db.New(s.Pool).ListGroupRules(ctx)
	if err != nil {
		return nil, fmt.Errorf("grouprules: list: %w", err)
	}
	out := make([]RuleView, 0, len(rows))
	for _, r := range rows {
		v := RuleView{Rule: Rule{ID: r.ID, GroupID: r.GroupID, Pattern: r.Pattern}, CreatedAt: r.CreatedAt.UTC()}
		if r.CreatedBy != nil && r.CreatorName != nil {
			v.CreatedBy = &UserRef{ID: *r.CreatedBy, DisplayName: *r.CreatorName}
		}
		out = append(out, v)
	}
	return out, nil
}

func lockRuleGroup(ctx context.Context, q *db.Queries, id uuid.UUID) error {
	_, err := q.GetGroupForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return devices.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("grouprules: lock group: %w", err)
	}
	return nil
}

func record(ctx context.Context, q *db.Queries, a devices.Actor, action string, groupID uuid.UUID, pattern string, conflicts ...devices.GroupConflictResult) error {
	details := map[string]any{"pattern": pattern}
	if len(conflicts) != 0 {
		if len(conflicts[0].Updated) != 0 {
			details["conflicts_updated"] = conflicts[0].Updated
		}
		if len(conflicts[0].Resolved) != 0 {
			details["conflicts_resolved"] = conflicts[0].Resolved
		}
	}
	return audit.Record(ctx, q, audit.Event{ActorUserID: &a.UserID, ActorIP: a.IP, Action: action, TargetType: "group", TargetID: groupID.String(), Details: details})
}

func (s *Service) Add(ctx context.Context, a devices.Actor, groupID uuid.UUID, pattern string) (RuleView, error) {
	if err := Valid(pattern); err != nil {
		return RuleView{}, devices.InputError(err.Error())
	}
	var out RuleView
	err := store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		if err := lockRuleGroup(ctx, q, groupID); err != nil {
			return err
		}
		// The row lock serializes the count and insertion for this group.
		rules, err := q.MatchGroupRules(ctx)
		if err != nil {
			return fmt.Errorf("grouprules: check duplicate: %w", err)
		}
		for _, r := range rules {
			if r.GroupID == groupID && equalPattern(r.Pattern, pattern) {
				return ErrPatternTaken
			}
		}
		n, err := q.CountGroupRules(ctx, groupID)
		if err != nil {
			return fmt.Errorf("grouprules: count: %w", err)
		}
		if n >= 20 {
			return devices.InputError("pattern: a group can have at most 20 patterns")
		}
		r, err := q.AddGroupRule(ctx, db.AddGroupRuleParams{GroupID: groupID, Pattern: pattern, CreatedBy: &a.UserID})
		if err != nil {
			var pg *pgconn.PgError
			if errors.As(err, &pg) && pg.Code == "23505" {
				return ErrPatternTaken
			}
			return fmt.Errorf("grouprules: add: %w", err)
		}
		u, err := q.GetUserByID(ctx, a.UserID)
		if err != nil {
			return fmt.Errorf("grouprules: creator: %w", err)
		}
		out = RuleView{Rule: Rule{ID: r.ID, GroupID: r.GroupID, Pattern: r.Pattern}, CreatedAt: r.CreatedAt.UTC(), CreatedBy: &UserRef{ID: u.ID, DisplayName: u.DisplayName}}
		return record(ctx, q, a, ActionRuleAdded, groupID, pattern)
	})
	return out, err
}

func equalPattern(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range len(a) {
		if !equalASCII(rune(a[i]), rune(b[i])) {
			return false
		}
	}
	return true
}

func (s *Service) Remove(ctx context.Context, a devices.Actor, groupID, ruleID uuid.UUID) error {
	return store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		if err := lockRuleGroup(ctx, q, groupID); err != nil {
			return err
		}
		pattern, err := q.RemoveGroupRule(ctx, db.RemoveGroupRuleParams{GroupID: groupID, ID: ruleID})
		if errors.Is(err, pgx.ErrNoRows) {
			return devices.ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("grouprules: remove: %w", err)
		}
		rules, err := loadRules(ctx, q)
		if err != nil {
			return err
		}
		result, err := devices.ReevaluateGroupConflicts(ctx, q, groupID, &a.UserID, func(hostname string) bool {
			for _, rule := range rules {
				if rule.GroupID == groupID && Match(rule.Pattern, hostname) {
					return true
				}
			}
			return false
		})
		if err != nil {
			return err
		}
		return record(ctx, q, a, ActionRuleRemoved, groupID, pattern, result)
	})
}

func loadRules(ctx context.Context, q *db.Queries) ([]Rule, error) {
	rows, err := q.MatchGroupRules(ctx)
	if err != nil {
		return nil, fmt.Errorf("grouprules: matching rules: %w", err)
	}
	rules := make([]Rule, len(rows))
	for i, r := range rows {
		rules[i] = Rule{ID: r.ID, GroupID: r.GroupID, Pattern: r.Pattern}
	}
	return rules, nil
}

// Placement is called by devices inside its approval transaction. Keeping the
// callback at that boundary lets this service use devices.Actor without a cycle.
func (s *Service) Placement(ctx context.Context, q *db.Queries, hostname string) ([]uuid.UUID, string, error) {
	rules, err := loadRules(ctx, q)
	if err != nil {
		return nil, "", err
	}
	ids := Candidates(rules, hostname)
	if len(ids) == 1 {
		for _, r := range rules {
			if r.GroupID == ids[0] && Match(r.Pattern, hostname) {
				return ids, r.Pattern, nil
			}
		}
	}
	return ids, "", nil
}

func (s *Service) Preview(ctx context.Context, groupID uuid.UUID, pattern string) (RulePreview, error) {
	out := RulePreview{Matches: []RuleDeviceRef{}, Conflicts: []Conflict{}}
	if err := Valid(pattern); err != nil {
		return out, devices.InputError(err.Error())
	}
	err := store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		g, err := q.RulePreviewGroup(ctx, groupID)
		if errors.Is(err, pgx.ErrNoRows) {
			return devices.ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("grouprules: preview group: %w", err)
		}
		rules, err := loadRules(ctx, q)
		if err != nil {
			return err
		}
		groups, err := q.AlertGroupRefs(ctx, ruleGroupIDs(rules, groupID))
		if err != nil {
			return fmt.Errorf("grouprules: preview groups: %w", err)
		}
		// Include the proposed group even before it has its first saved rule.
		byID := map[uuid.UUID]devices.GroupRef{g.ID: {ID: g.ID, Name: g.Name}}
		for _, r := range groups {
			byID[r.ID] = devices.GroupRef{ID: r.ID, Name: r.Name}
		}
		rows, err := q.RulePreviewDevices(ctx)
		if err != nil {
			return fmt.Errorf("grouprules: preview devices: %w", err)
		}
		for _, r := range rows {
			if !Match(pattern, r.Hostname) {
				continue
			}
			d := RuleDeviceRef{ID: r.ID, RustdeskID: r.RustdeskID, Hostname: r.Hostname, Alias: r.Alias, State: r.State, GroupID: r.GroupID}
			out.MatchCount++
			if len(out.Matches) < 200 {
				out.Matches = append(out.Matches, d)
			}
			ids := Candidates(append(rules, Rule{GroupID: groupID, Pattern: pattern}), r.Hostname)
			if len(ids) > 1 {
				out.ConflictCount++
				if len(out.Conflicts) >= 200 {
					continue
				}
				refs := make([]devices.GroupRef, 0, len(ids))
				for _, id := range ids {
					if ref, ok := byID[id]; ok {
						refs = append(refs, ref)
					}
				}
				out.Conflicts = append(out.Conflicts, Conflict{Device: d, Groups: refs})
			}
		}
		return nil
	})
	return out, err
}

func ruleGroupIDs(rules []Rule, id uuid.UUID) []uuid.UUID {
	ids := []uuid.UUID{id}
	for _, r := range rules {
		ids = append(ids, r.GroupID)
	}
	return ids
}
