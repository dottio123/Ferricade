package deploy

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestCatalogMatchesTestdata(t *testing.T) {
	var research []Setting
	want, err := os.ReadFile("../../testdata/client-deploy-1.5.0/client-settings-catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want, &research); err != nil {
		t.Fatal(err)
	}
	got := Catalog()
	if len(got) < len(research) {
		t.Fatalf("got %d settings; want at least %d", len(got), len(research))
	}
	for i, setting := range got[:len(research)] {
		wantSetting := research[i]
		if setting.Key != wantSetting.Key {
			t.Errorf("setting %d key = %q; want %q", i, setting.Key, wantSetting.Key)
		}
		if setting.Type != wantSetting.Type || !reflect.DeepEqual(setting.OS, wantSetting.OS) {
			t.Errorf("%s type/os = %q/%v; want %q/%v", setting.Key, setting.Type, setting.OS, wantSetting.Type, wantSetting.OS)
		}
		wantValues := wantSetting.Values
		if setting.Key == "approve-mode" {
			wantValues = []string{"password", "click", "password-click"}
		}
		if !reflect.DeepEqual(setting.Values, wantValues) {
			t.Errorf("%s values = %q; want %q", setting.Key, setting.Values, wantValues)
		}
		for _, value := range setting.Values {
			if strings.TrimSpace(setting.ValueLabels[value]) == "" {
				t.Errorf("%s value %q has no value label", setting.Key, value)
			}
		}
		for _, forbidden := range []string{"Y enables", "unset", "use-temporary-password", "use-permanent-password", "use-both-passwords"} {
			if strings.Contains(setting.Help, forbidden) {
				t.Errorf("%s help contains %q", setting.Key, forbidden)
			}
		}
	}
	if setting, ok := Lookup("approve-mode"); !ok || setting.Source == "" {
		t.Fatal("missing source")
	}
}

func TestAdditionalCatalogSettings(t *testing.T) {
	for _, tc := range []struct {
		key, typ, def, os string
		values            []string
	}{
		{"access-mode", "enum", "custom", "windows,linux,macos", []string{"custom", "full", "view"}},
		{"enable-remote-printer", "bool", "Y", "windows", nil},
		{"enable-camera", "bool", "Y", "windows,linux,macos", nil},
		{"enable-terminal", "bool", "Y", "windows,linux,macos", nil},
		{"enable-block-input", "bool", "Y", "windows", nil},
		{"enable-privacy-mode", "bool", "Y", "windows,macos", nil},
		{"allow-remote-config-modification", "bool", "N", "windows,linux,macos", nil},
		{"keep-awake-during-incoming-sessions", "bool", "Y", "windows,linux,macos", nil},
		{"allow-only-conn-window-open", "bool", "N", "windows,linux,macos", nil},
		{"allow-auto-disconnect", "bool", "N", "windows,linux,macos", nil},
		{"auto-disconnect-timeout", "enum", "10", "windows,linux,macos", []string{"10", "30", "60", "120"}},
	} {
		setting, ok := Lookup(tc.key)
		if !ok || setting.Type != tc.typ || setting.Default != tc.def || strings.Join(setting.OS, ",") != tc.os || !reflect.DeepEqual(setting.Values, tc.values) {
			t.Errorf("%s = %#v, present %v", tc.key, setting, ok)
		}
	}
}
