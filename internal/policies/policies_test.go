package policies

import (
	"reflect"
	"testing"
	"time"
)

func TestValidate(t *testing.T) {
	tests := []struct {
		name     string
		settings Settings
		field    string
		msg      string
	}{
		{name: "unknown key", settings: Settings{"custom-rendezvous-server": "host", "approve-mode": "password-click", "verification-method": "use-both-passwords"}, field: "custom-rendezvous-server", msg: "not a catalog setting"},
		{name: "bad enum", settings: Settings{"approve-mode": "both", "verification-method": "use-both-passwords"}, field: "approve-mode", msg: "not an allowed value"},
		{name: "bad bool", settings: Settings{"approve-mode": "password-click", "verification-method": "use-both-passwords", "direct-server": "yes"}, field: "direct-server", msg: "not an allowed value"},
		{name: "empty bool", settings: Settings{"approve-mode": "password-click", "verification-method": "use-both-passwords", "direct-server": ""}, field: "direct-server", msg: "not an allowed value"},
		{name: "missing approve mode", settings: Settings{"verification-method": "use-both-passwords"}, field: "approve-mode", msg: "required"},
		{name: "missing verification method", settings: Settings{"approve-mode": "password-click"}, field: "verification-method", msg: "required"},
		{name: "valid full", settings: Settings{"approve-mode": "password-click", "verification-method": "use-both-passwords", "enable-file-transfer": "N"}},
		{name: "full overrides permission", settings: Settings{"approve-mode": "password-click", "verification-method": "use-both-passwords", "enable-file-transfer": "N", "access-mode": "full"}, field: "access-mode", msg: "must be custom when individual permissions are managed"},
		{name: "view overrides permission", settings: Settings{"approve-mode": "password-click", "verification-method": "use-both-passwords", "enable-camera": "N", "access-mode": "view"}, field: "access-mode", msg: "must be custom when individual permissions are managed"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := Validate(tt.settings)
			if tt.msg == "" {
				if err != nil {
					t.Fatalf("Validate() error = %v", err)
				}
				return
			}
			got, ok := err.(*ValidationError)
			if !ok || got.Field != tt.field || got.Msg != tt.msg {
				t.Fatalf("Validate() error = %#v, want {%q, %q}", err, tt.field, tt.msg)
			}
		})
	}
}

func TestEffectivePermissionPreset(t *testing.T) {
	base := DefaultSettings()
	base["enable-file-transfer"] = "N"
	got := Effective(base, nil, time.Now())
	if got["access-mode"] != "custom" || Version(got) == Version(base) {
		t.Fatalf("permission effective settings = %#v; version unchanged = %v", got, Version(got) == Version(base))
	}
	delete(base, "enable-file-transfer")
	if _, ok := Effective(base, nil, time.Now())["access-mode"]; ok {
		t.Fatal("access mode added without managed permissions")
	}
}

func TestValidateAdditionalCatalogValues(t *testing.T) {
	for _, tc := range []struct {
		key    string
		values []string
		bad    string
	}{
		{"access-mode", []string{"custom", "full", "view"}, "automatic"},
		{"enable-remote-printer", []string{"Y", "N"}, "yes"},
		{"enable-camera", []string{"Y", "N"}, "yes"},
		{"enable-terminal", []string{"Y", "N"}, "yes"},
		{"enable-block-input", []string{"Y", "N"}, "yes"},
		{"enable-privacy-mode", []string{"Y", "N"}, "yes"},
		{"allow-remote-config-modification", []string{"Y", "N"}, "yes"},
		{"keep-awake-during-incoming-sessions", []string{"Y", "N"}, "yes"},
		{"allow-only-conn-window-open", []string{"Y", "N"}, "yes"},
		{"allow-auto-disconnect", []string{"Y", "N"}, "yes"},
		{"auto-disconnect-timeout", []string{"10", "30", "60", "120"}, "15"},
	} {
		t.Run(tc.key, func(t *testing.T) {
			for _, value := range tc.values {
				s := DefaultSettings()
				s[tc.key] = value
				if err := Validate(s); err != nil {
					t.Errorf("%s=%s: %v", tc.key, value, err)
				}
			}
			s := DefaultSettings()
			s[tc.key] = tc.bad
			if err := Validate(s); err == nil {
				t.Errorf("accepted %s=%s", tc.key, tc.bad)
			}
		})
	}
}

func TestDefaultSettingsValidAndReachable(t *testing.T) {
	s := DefaultSettings()
	if err := Validate(s); err != nil {
		t.Fatalf("DefaultSettings invalid: %v", err)
	}
	if !AlwaysReachable(s) {
		t.Fatal("DefaultSettings should be always reachable")
	}
}

func TestAlwaysReachable(t *testing.T) {
	for _, tt := range []struct {
		name                  string
		approve, verification string
		want                  bool
	}{
		{"click", "click", "use-both-passwords", false},
		{"temporary password", "password", "use-temporary-password", false},
		{"permanent password", "password", "use-permanent-password", true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := AlwaysReachable(Settings{"approve-mode": tt.approve, "verification-method": tt.verification}); got != tt.want {
				t.Fatalf("AlwaysReachable() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestWindowOpenBoundary(t *testing.T) {
	end := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	closed := end.Add(-time.Minute)
	for _, tt := range []struct {
		name string
		w    *Window
		now  time.Time
		want bool
	}{
		{"before end", &Window{EndsAt: &end}, end.Add(-time.Nanosecond), true},
		{"at end", &Window{EndsAt: &end}, end, false},
		{"after end", &Window{EndsAt: &end}, end.Add(time.Second), false},
		{"no end", &Window{}, end, true},
		{"closed", &Window{EndsAt: &end, ClosedAt: &closed}, end.Add(-time.Hour), false},
		{"nil window", nil, end, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.w.OpenAt(tt.now); got != tt.want {
				t.Fatalf("OpenAt() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestEffectiveOverlay(t *testing.T) {
	policy := Settings{"approve-mode": "click", "verification-method": "use-temporary-password", "enable-audio": "N"}
	before := cloneSettings(policy)
	now := time.Now()
	window := &Window{EndsAt: ptrTime(now.Add(time.Hour))}
	got := Effective(policy, window, now)
	if got["approve-mode"] != "password-click" || got["verification-method"] != "use-both-passwords" || got["enable-audio"] != "N" {
		t.Fatalf("open effective settings = %#v", got)
	}
	expired := Effective(policy, &Window{EndsAt: ptrTime(now)}, now)
	if expired["access-mode"] != "custom" || expired["enable-audio"] != "N" || expired["approve-mode"] != "click" {
		t.Fatalf("expired effective = %#v", expired)
	}
	if !reflect.DeepEqual(policy, before) {
		t.Fatalf("Effective mutated input: %#v, want %#v", policy, before)
	}
}

func TestEffectiveFiltersUnknownKeys(t *testing.T) {
	policy := Settings{"approve-mode": "password-click", "verification-method": "use-both-passwords", "custom-rendezvous-server": "host", "api-server": "host", "key": "secret", "stop-service": "Y"}
	for _, window := range []*Window{nil, {EndsAt: ptrTime(time.Now().Add(time.Hour))}} {
		got := Effective(policy, window, time.Now())
		for _, key := range []string{"custom-rendezvous-server", "api-server", "key", "stop-service"} {
			if _, ok := got[key]; ok {
				t.Errorf("Effective retained %q", key)
			}
		}
	}
}

func TestVersion(t *testing.T) {
	a := Settings{"approve-mode": "password-click", "verification-method": "use-both-passwords"}
	b := Settings{}
	b["verification-method"] = "use-both-passwords"
	b["approve-mode"] = "password-click"
	if Version(a) != Version(b) {
		t.Fatal("Version depends on map insertion order")
	}
	b["approve-mode"] = "password"
	if Version(a) == Version(b) {
		t.Fatal("Version did not change when a value changed")
	}
	if Version(Settings{}) <= 0 || Version(DefaultSettings()) <= 0 {
		t.Fatal("Version must be positive")
	}
}

func cloneSettings(s Settings) Settings {
	result := Settings{}
	for k, v := range s {
		result[k] = v
	}
	return result
}
func ptrTime(t time.Time) *time.Time { return &t }
