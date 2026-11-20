package deploy

import (
	"bytes"
	_ "embed"
	"fmt"
	"regexp"
	"strings"
	"text/template"
	"unicode"
	"unicode/utf8"

	"github.com/dottio123/ferricade/internal/connect"
)

//go:embed templates/windows.ps1.tmpl
var windowsTemplate string

//go:embed templates/linux.sh.tmpl
var linuxTemplate string

var (
	parsedLinuxTemplate   = template.Must(template.New("linux").Funcs(template.FuncMap{"q": QuoteSH}).Parse(linuxTemplate))
	parsedWindowsTemplate = template.Must(template.New("windows").Funcs(template.FuncMap{"q": QuotePS}).Parse(windowsTemplate))
)

func withUTF8BOM(b []byte) []byte { return append([]byte{0xef, 0xbb, 0xbf}, b...) }

type SettingValue struct {
	Include bool   `json:"include"`
	Value   string `json:"value"`
}

type Profile struct {
	InstallerSource                                                       string
	ClientVersion                                                         string
	URLWindows, URLDeb, URLRPM                                            string
	SHA256Windows, SHA256Deb, SHA256RPM                                   string
	AllowDowngrade                                                        bool
	Settings                                                              map[string]SettingValue
	IncludeInstall, IncludePassword, IncludeUnlockPIN, IncludeIDAllowList bool
	IDAllowList                                                           []string
}

type Secrets struct {
	Password, UnlockPIN               *string
	PasswordUnreadable, PINUnreadable bool
}

// Clears reports which device secrets a successful render will remove.
func (s Secrets) Clears(p Profile) (password, pin bool) {
	return p.IncludePassword && s.Password == nil && !s.PasswordUnreadable,
		p.IncludeUnlockPIN && s.UnlockPIN == nil && !s.PINUnreadable
}

// ValidationError identifies an invalid deployment API field.
type ValidationError struct {
	Field string
	Msg   string
}

func (e *ValidationError) Error() string { return e.Field + ": " + e.Msg }

func forbiddenSecretRune(s string) bool {
	for _, r := range s {
		if r == '"' || r == '\\' || r <= 0x1f || r == 0x7f {
			return true
		}
	}
	return false
}

func ValidatePassword(s string) error {
	length := utf8.RuneCountInString(s)
	if length < 8 || length > 128 {
		return &ValidationError{"fleet_password", "length must be 8-128 characters"}
	}
	if forbiddenSecretRune(s) {
		return &ValidationError{"fleet_password", "forbidden quote, backslash or control character"}
	}
	upper, lower, digit := false, false, false
	for _, r := range s {
		upper = upper || unicode.IsUpper(r)
		lower = lower || unicode.IsLower(r)
		digit = digit || unicode.IsDigit(r)
	}
	if !upper {
		return &ValidationError{"fleet_password", "uppercase letter required"}
	}
	if !lower {
		return &ValidationError{"fleet_password", "lowercase letter required"}
	}
	if !digit {
		return &ValidationError{"fleet_password", "digit required"}
	}
	return nil
}

func ValidateUnlockPIN(s string) error {
	length := utf8.RuneCountInString(s)
	if length < 4 || length > 128 {
		return &ValidationError{"unlock_pin", "length must be 4-128 characters"}
	}
	if forbiddenSecretRune(s) {
		return &ValidationError{"unlock_pin", "forbidden quote, backslash or control character"}
	}
	return nil
}

var versionPattern = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
var shaPattern = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

func Validate(p Profile) error {
	if p.InstallerSource != "github" && p.InstallerSource != "url" {
		return &ValidationError{"installer_source", "must be github or url"}
	}
	if !versionPattern.MatchString(p.ClientVersion) {
		if p.ClientVersion == "latest" {
			if p.InstallerSource != "github" {
				return &ValidationError{"client_version", "latest needs the GitHub installer source"}
			}
		} else {
			return &ValidationError{"client_version", "must be major.minor.patch"}
		}
	}
	if p.ClientVersion == "latest" {
		for _, field := range []struct{ name, value string }{{"sha256_windows", p.SHA256Windows}, {"sha256_deb", p.SHA256Deb}, {"sha256_rpm", p.SHA256RPM}} {
			if field.value != "" {
				return &ValidationError{field.name, "not allowed with the latest release"}
			}
		}
	}
	for _, field := range []struct{ name, value string }{{"sha256_windows", p.SHA256Windows}, {"sha256_deb", p.SHA256Deb}, {"sha256_rpm", p.SHA256RPM}} {
		if field.value != "" && !shaPattern.MatchString(field.value) {
			return &ValidationError{field.name, "must be 64 hex characters"}
		}
	}
	for _, field := range []struct {
		name, value, checksum string
		unc                   bool
	}{{"url_windows", p.URLWindows, p.SHA256Windows, true}, {"url_deb", p.URLDeb, p.SHA256Deb, false}, {"url_rpm", p.URLRPM, p.SHA256RPM, false}} {
		if field.value == "" {
			continue
		}
		if strings.IndexFunc(field.value, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 {
			return &ValidationError{field.name, "must not contain whitespace or control characters"}
		}
		if !strings.HasPrefix(field.value, "https://") && !strings.HasPrefix(field.value, "http://") && !(field.unc && strings.HasPrefix(field.value, "\\")) {
			if field.unc {
				return &ValidationError{field.name, "must start with https://, http:// or \\"}
			}
			return &ValidationError{field.name, "must start with https:// or http://"}
		}
		if p.ClientVersion == "latest" && !strings.HasPrefix(field.value, "https://") {
			return &ValidationError{field.name, "must be https:// with the latest release"}
		}
		if !strings.HasPrefix(field.value, "https://") && field.checksum == "" {
			shaField := strings.Replace(field.name, "url_", "sha256_", 1)
			return &ValidationError{field.name, "needs " + shaField + " unless the URL is https://"}
		}
	}
	for key, value := range p.Settings {
		setting, ok := Lookup(key)
		if !ok {
			return &ValidationError{"settings." + key, "unknown setting"}
		}
		if !value.Include {
			continue
		}
		if value.Value == "" {
			return &ValidationError{"settings." + key, "value must not be empty"}
		}
		switch setting.Type {
		case "bool":
			if value.Value != "Y" && value.Value != "N" {
				return &ValidationError{"settings." + key, "expected Y or N"}
			}
		case "enum":
			found := false
			for _, allowed := range setting.Values {
				if value.Value == allowed {
					found = true
					break
				}
			}
			if !found {
				return &ValidationError{"settings." + key, "invalid value"}
			}
		default:
			return &ValidationError{"settings." + key, "unsupported type"}
		}
	}
	mode := p.Settings["access-mode"]
	if mode.Include && (mode.Value == "full" || mode.Value == "view") {
		for key, value := range p.Settings {
			if value.Include && IsPermission(key) {
				return &ValidationError{"access-mode", "must be custom when individual permissions are managed"}
			}
		}
	}
	return nil
}

type renderSetting struct{ Key, Value string }
type renderData struct {
	Version, URLWindows, URLDeb, URLRPM string
	SHAWindows, SHADeb, SHARPM          string
	AllowDowngrade, Install, Latest     bool
	ServerConfig                        string
	ServerHost                          string
	Key, Relay                          string
	Password, PIN                       *string
	ClearPassword, ClearPIN             bool
	Settings                            []renderSetting
}

func Render(osName string, p Profile, s Secrets, serverConfig string) ([]byte, error) {
	if osName != "windows" && osName != "linux" {
		return nil, fmt.Errorf("os: unsupported %q", osName)
	}
	// Older stored profiles may contain keys removed from the catalog. Render only known keys.
	clean := p
	clean.Settings = make(map[string]SettingValue, len(p.Settings))
	for key, value := range p.Settings {
		if _, ok := Lookup(key); ok {
			clean.Settings[key] = value
		}
	}
	if err := Validate(clean); err != nil {
		return nil, err
	}
	if p.IncludePassword && s.PasswordUnreadable {
		return nil, &ValidationError{"fleet_password", "the stored value cannot be decrypted (was SECRET_KEY changed?); set it again"}
	}
	if p.IncludeUnlockPIN && s.PINUnreadable {
		return nil, &ValidationError{"unlock_pin", "the stored value cannot be decrypted (was SECRET_KEY changed?); set it again"}
	}
	if serverConfig == "" {
		return nil, fmt.Errorf("serverConfig: empty")
	}
	var config connect.ClientConfig
	if strings.HasPrefix(serverConfig, "host=") {
		for _, part := range strings.Split(serverConfig, ",") {
			name, value, _ := strings.Cut(part, "=")
			switch name {
			case "host":
				config.Host = value
			case "key":
				config.Key = value
			case "relay":
				config.Relay = value
			}
		}
	} else if decoded, err := connect.DecodeConfigString(serverConfig); err == nil {
		config = decoded
	}
	if config.Host == "" {
		return nil, fmt.Errorf("serverConfig: missing host")
	}
	if config.Key == "" {
		return nil, &ValidationError{Field: "public_key", Msg: "server public key is required for deployment scripts"}
	}
	data := renderData{Version: p.ClientVersion, AllowDowngrade: p.AllowDowngrade, Install: p.IncludeInstall, Latest: p.ClientVersion == "latest", ServerConfig: serverConfig, ServerHost: config.Host, Key: config.Key, Relay: config.Relay}
	base := "https://github.com/rustdesk/rustdesk/releases/download/" + p.ClientVersion + "/rustdesk-" + p.ClientVersion
	if p.InstallerSource == "github" {
		data.URLWindows = base + "-x86_64.msi"
		data.URLDeb = base + "-x86_64.deb"
		data.URLRPM = base + "-0.x86_64.rpm"
	} else {
		data.URLWindows = p.URLWindows
		data.URLDeb = p.URLDeb
		data.URLRPM = p.URLRPM
	}
	data.SHAWindows = p.SHA256Windows
	data.SHADeb = p.SHA256Deb
	data.SHARPM = p.SHA256RPM
	data.ClearPassword, data.ClearPIN = s.Clears(p)
	if p.IncludeInstall && p.InstallerSource == "url" {
		if osName == "windows" && data.URLWindows == "" {
			return nil, &ValidationError{"url_windows", "required for windows"}
		}
		if osName == "linux" && data.URLDeb == "" && data.URLRPM == "" {
			return nil, &ValidationError{"url_deb or url_rpm", "required for linux"}
		}
	}
	if p.IncludePassword && s.Password != nil {
		if err := ValidatePassword(*s.Password); err != nil {
			return nil, err
		}
		data.Password = s.Password
	}
	if p.IncludeUnlockPIN && s.UnlockPIN != nil {
		if err := ValidateUnlockPIN(*s.UnlockPIN); err != nil {
			return nil, err
		}
		data.PIN = s.UnlockPIN
	}
	for _, setting := range settingsCatalog {
		value, ok := p.Settings[setting.Key]
		if !ok || !value.Include {
			continue
		}
		applies := false
		for _, target := range setting.OS {
			if target == osName {
				applies = true
				break
			}
		}
		if applies {
			data.Settings = append(data.Settings, renderSetting{setting.Key, value.Value})
		}
	}
	if mode, ok := p.Settings["access-mode"]; !ok || !mode.Include {
		for key, value := range p.Settings {
			if value.Include && IsPermission(key) {
				data.Settings = append(data.Settings, renderSetting{"access-mode", "custom"})
				break
			}
		}
	}
	if p.IncludeIDAllowList && len(p.IDAllowList) > 0 {
		data.Settings = append(data.Settings, renderSetting{"id-whitelist", strings.Join(p.IDAllowList, ",")})
	}
	tmpl := parsedLinuxTemplate
	if osName == "windows" {
		tmpl = parsedWindowsTemplate
	}
	var out bytes.Buffer
	if err := tmpl.Execute(&out, data); err != nil {
		return nil, fmt.Errorf("render %s: %w", osName, err)
	}
	// Embedded templates can be checked out with CRLF on Windows.
	contentBytes := bytes.ReplaceAll(out.Bytes(), []byte("\r\n"), []byte("\n"))
	if osName == "windows" {
		return withUTF8BOM(contentBytes), nil
	}
	return contentBytes, nil
}
