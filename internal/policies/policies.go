package policies

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"math"
	"sort"
	"time"

	"github.com/dottio123/ferricade/internal/deploy"
)

type Settings map[string]string

var AccessKeys = []string{"approve-mode", "verification-method"}

type ValidationError struct {
	Field string
	Msg   string
}

func (e *ValidationError) Error() string { return e.Field + ": " + e.Msg }

func Validate(s Settings) error {
	catalog := catalogByKey()
	keys := make([]string, 0, len(s))
	for key := range s {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		setting, ok := catalog[key]
		if !ok {
			return &ValidationError{Field: key, Msg: "not a catalog setting"}
		}
		value := s[key]
		allowed := false
		if setting.Type == "bool" {
			allowed = value == "Y" || value == "N"
		} else {
			for _, candidate := range setting.Values {
				if value == candidate {
					allowed = true
					break
				}
			}
		}
		if !allowed {
			return &ValidationError{Field: key, Msg: "not an allowed value"}
		}
	}
	for _, key := range AccessKeys {
		if _, ok := s[key]; !ok {
			return &ValidationError{Field: key, Msg: "required"}
		}
	}
	if mode := s["access-mode"]; mode == "full" || mode == "view" {
		for key := range s {
			if deploy.IsPermission(key) {
				return &ValidationError{Field: "access-mode", Msg: "must be custom when individual permissions are managed"}
			}
		}
	}
	return nil
}

func DefaultSettings() Settings {
	return Settings{"approve-mode": "password-click", "verification-method": "use-both-passwords"}
}

func WindowOverride() Settings { return DefaultSettings() }

func AlwaysReachable(s Settings) bool {
	approve := s["approve-mode"] == "password" || s["approve-mode"] == "password-click"
	verification := s["verification-method"] == "use-permanent-password" || s["verification-method"] == "use-both-passwords"
	return approve && verification
}

type Window struct {
	EndsAt   *time.Time
	ClosedAt *time.Time
}

func (w *Window) OpenAt(now time.Time) bool {
	if w == nil || w.ClosedAt != nil {
		return false
	}
	return w.EndsAt == nil || now.Before(*w.EndsAt)
}

func Effective(policy Settings, w *Window, now time.Time) Settings {
	result := make(Settings, len(policy))
	for key, value := range policy {
		result[key] = value
	}
	if w.OpenAt(now) {
		for key, value := range WindowOverride() {
			result[key] = value
		}
	}
	catalog := catalogByKey()
	for key := range result {
		if _, ok := catalog[key]; !ok {
			delete(result, key)
		}
	}
	if _, managed := result["access-mode"]; !managed {
		for key := range result {
			if deploy.IsPermission(key) {
				result["access-mode"] = "custom"
				break
			}
		}
	}
	return result
}

func Version(s Settings) int64 {
	encoded, _ := json.Marshal(s)
	digest := sha256.Sum256(encoded)
	version := binary.BigEndian.Uint64(digest[:8]) & math.MaxInt64
	if version == 0 {
		return 1
	}
	return int64(version)
}

func catalogByKey() map[string]deploy.Setting {
	settings := deploy.Catalog()
	result := make(map[string]deploy.Setting, len(settings))
	for _, setting := range settings {
		result[setting.Key] = setting
	}
	return result
}
