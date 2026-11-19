package stats

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/dottio123/ferricade/internal/store/db"
)

// KeyDashboardThresholds is the settings key of the owner's thresholds.
const KeyDashboardThresholds = "dashboard_thresholds"

// Thresholds are the owner's limits for what the dashboard calls attention.
type Thresholds struct {
	OfflineDays      int    `json:"offline_days"`       // 1-365
	PendingHours     int    `json:"pending_hours"`      // 1-720
	MinClientVersion string `json:"min_client_version"` // "" (off) or 1 to 4 numeric parts
}

// DefaultThresholds apply until the owner saves others.
var DefaultThresholds = Thresholds{OfflineDays: 7, PendingHours: 24}

// ValidationError names the field whose value is not allowed.
type ValidationError struct {
	Field string
	Msg   string
}

func (e *ValidationError) Error() string { return e.Field + " " + e.Msg }

var versionRE = regexp.MustCompile(`^\d+(\.\d+){0,3}$`)

// Validate returns a *ValidationError for the first bad field.
func (t Thresholds) Validate() error {
	switch {
	case t.OfflineDays < 1 || t.OfflineDays > 365:
		return &ValidationError{"offline_days", "must be between 1 and 365"}
	case t.PendingHours < 1 || t.PendingHours > 720:
		return &ValidationError{"pending_hours", "must be between 1 and 720"}
	case t.MinClientVersion != "" && !versionRE.MatchString(t.MinClientVersion):
		return &ValidationError{"min_client_version", "must be empty or up to four dot-separated numbers, like 1.5.0"}
	}
	return nil
}

// LoadThresholds reads the saved thresholds; absent ones (or an absent
// setting) are the defaults.
func LoadThresholds(ctx context.Context, q *db.Queries) (Thresholds, error) {
	raw, err := q.GetSetting(ctx, KeyDashboardThresholds)
	if errors.Is(err, pgx.ErrNoRows) {
		return DefaultThresholds, nil
	}
	if err != nil {
		return Thresholds{}, fmt.Errorf("stats: get thresholds: %w", err)
	}
	t := DefaultThresholds
	if err := json.Unmarshal(raw, &t); err != nil {
		return Thresholds{}, fmt.Errorf("stats: decode thresholds: %w", err)
	}
	return t, nil
}

// SaveThresholds validates t (surrounding spaces of the version are dropped)
// and stores it.
func SaveThresholds(ctx context.Context, q *db.Queries, t Thresholds) error {
	t.MinClientVersion = strings.TrimSpace(t.MinClientVersion)
	if err := t.Validate(); err != nil {
		return err
	}
	raw, err := json.Marshal(t)
	if err != nil {
		return fmt.Errorf("stats: encode thresholds: %w", err)
	}
	if err := q.PutSetting(ctx, db.PutSettingParams{Key: KeyDashboardThresholds, Value: raw}); err != nil {
		return fmt.Errorf("stats: put thresholds: %w", err)
	}
	return nil
}
