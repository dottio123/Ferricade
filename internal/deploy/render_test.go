package deploy

import (
	"bytes"
	"errors"
	"flag"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/dottio123/ferricade/internal/connect"
)

var updateGolden = flag.Bool("update", false, "update deployment script golden files")

func TestRenderServerVerification(t *testing.T) {
	for _, target := range []string{"windows", "linux"} {
		for _, relay := range []string{"", "relay.example:21117"} {
			for _, key := range []string{"", "abc='quoted"} {
				config := connect.ClientConfig{Host: "rd.example", Key: key, Relay: relay}
				for _, serverConfig := range []string{connect.ConfigString(config), "host=" + config.Host + ",key=" + key + ",relay=" + relay} {
					p, s := fixture()
					out, err := Render(target, p, s, serverConfig)
					if key == "" {
						var ve *ValidationError
						if !errors.As(err, &ve) || ve.Field != "public_key" || ve.Msg != "server public key is required for deployment scripts" || len(out) != 0 {
							t.Errorf("%s empty key: output length %d, error %v", target, len(out), err)
						}
						continue
					}
					if err != nil {
						t.Fatal(err)
					}
					quote, read, set := QuoteSH, `--option 'key'`, `--option 'key' `
					if target == "windows" {
						quote, read, set = QuotePS, `Run-Client @('--option', 'key')`, `Run-Client @('--option', 'key', `
					}
					script := string(out)
					if strings.Count(script, read) != map[string]int{"linux": 3, "windows": 2}[target] || !strings.Contains(script, set+quote(key)) || !strings.Contains(script, "Server key verification failed") {
						t.Errorf("%s missing key readback, repair or failure check", target)
					}
					if strings.Contains(script, "Relay verification failed") != (relay != "") || (relay != "" && !strings.Contains(script, quote(relay))) {
						t.Errorf("%s relay verification does not match config", target)
					}
				}
			}
		}
	}
}

func TestRenderServerVerificationExecution(t *testing.T) {
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("sh unavailable")
	}
	for _, tc := range []struct {
		name, key, relay, stuck, configRelay, message string
		keyReads, relayReads                          int
	}{
		{"already configured", "abc", "relay.example", "", "relay.example", "", 1, 1},
		{"missing key", "", "relay.example", "", "relay.example", "", 2, 1},
		{"wrong key case", "ABC", "relay.example", "", "relay.example", "", 2, 1},
		{"wrong relay", "abc", "wrong.example", "", "relay.example", "", 1, 2},
		{"key repair fails", "", "relay.example", "key", "relay.example", "Server key verification failed", 2, 0},
		{"relay repair fails", "abc", "", "relay-server", "relay.example", "Relay verification failed", 1, 2},
		{"relay omitted", "abc", "wrong.example", "", "", "", 1, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, s := fixture()
			out, err := Render("linux", p, s, connect.ConfigString(connect.ClientConfig{Host: "rd.example", Key: "abc", Relay: tc.configRelay}))
			if err != nil {
				t.Fatal(err)
			}
			start := bytes.Index(out, []byte(`"$exe" --config`))
			end := bytes.Index(out, []byte("log_step 'Server configuration completed'"))
			if start < 0 || end <= start {
				t.Fatal("missing server configuration step")
			}
			dir := t.TempDir()
			exe := filepath.Join(dir, "client")
			fake := `#!/bin/sh
[ "$1" = --config ] && exit 0
printf '%s %s\n' "$#" "$2" >> "$STATE/calls"
case "$2" in
  custom-rendezvous-server) printf rd.example; exit 0 ;;
  key|relay-server)
    if [ "$#" -eq 3 ]; then
      [ "$STUCK" = "$2" ] || printf %s "$3" > "$STATE/$2"
    else
      cat "$STATE/$2"
    fi ;;
esac
exit 0
`
			for name, content := range map[string]string{exe: fake, filepath.Join(dir, "key"): tc.key, filepath.Join(dir, "relay-server"): tc.relay} {
				if err := os.WriteFile(name, []byte(content), 0700); err != nil {
					t.Fatal(err)
				}
			}
			cmd := exec.Command(shell)
			cmd.Env = append(os.Environ(), "STATE="+dir, "STUCK="+tc.stuck)
			cmd.Stdin = strings.NewReader("exe=" + QuoteSH(exe) + "\nfail() { echo \"$2\"; exit \"$1\"; }\n" + string(out[start:end]))
			result, err := cmd.CombinedOutput()
			if tc.message == "" && err != nil {
				t.Fatalf("configuration failed: %v: %s", err, result)
			}
			if tc.message != "" {
				var exit *exec.ExitError
				if !errors.As(err, &exit) || exit.ExitCode() != 40 || strings.TrimSpace(string(result)) != tc.message {
					t.Fatalf("expected exit 40 and %q, got %v: %s", tc.message, err, result)
				}
			}
			calls, err := os.ReadFile(filepath.Join(dir, "calls"))
			if err != nil {
				t.Fatal(err)
			}
			if strings.Count(string(calls), "2 key\n") != tc.keyReads || strings.Count(string(calls), "2 relay-server\n") != tc.relayReads {
				t.Fatalf("unexpected readback attempts: %s", calls)
			}
		})
	}
}

func fixture() (Profile, Secrets) {
	p := Profile{InstallerSource: "github", ClientVersion: "1.5.0", IncludeInstall: true, IncludePassword: true, IncludeUnlockPIN: true, Settings: map[string]SettingValue{}}
	// Keep the original pinned-settings golden independent of later catalog additions.
	for _, setting := range Catalog()[:11] {
		value := "N"
		if setting.Type == "enum" {
			value = setting.Values[0]
		}
		p.Settings[setting.Key] = SettingValue{Include: true, Value: value}
	}
	pw, pin := "P@ss'w$rd1", "12'34"
	return p, Secrets{Password: &pw, UnlockPIN: &pin}
}

func TestRenderGolden(t *testing.T) {
	p, s := fixture()
	for _, target := range []string{"windows", "linux"} {
		t.Run(target, func(t *testing.T) {
			got, err := Render(target, p, s, "host=rd.example,key=abc,relay=relay.example")
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join("testdata", "golden", map[string]string{"windows": "windows.ps1", "linux": "linux.sh"}[target])
			want, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			// The original fixture manages permissions; the new preset is the sole
			// expected addition to its otherwise unchanged script.
			if target == "linux" {
				got = regexp.MustCompile(`(?m)^"\$exe" --option 'access-mode' 'custom'.*\nreadback=.*\n\[ "\$readback".*\nlog_step 'Option configuration completed'\n\n`).ReplaceAll(got, nil)
			} else {
				got = regexp.MustCompile(`(?m)^try \{\n    \$null = Run-Client @\('--option', 'access-mode', 'custom'\)\n    if .*\n\} catch .*\nLog-Step 'Option configuration completed'\n\n`).ReplaceAll(got, nil)
			}
			if *updateGolden {
				if err := os.WriteFile(path, got, 0644); err != nil {
					t.Fatal(err)
				}
				want = got
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("golden mismatch for %s", target)
			}
		})
	}
}

func TestPermissionPresetValidationAndRender(t *testing.T) {
	p := Profile{InstallerSource: "github", ClientVersion: "1.5.0", Settings: map[string]SettingValue{
		"enable-file-transfer": {Include: true, Value: "N"},
		"access-mode":          {Include: true, Value: "full"},
	}}
	if err := Validate(p); err == nil || err.Error() != "access-mode: must be custom when individual permissions are managed" {
		t.Fatalf("Validate contradiction = %v", err)
	}
	delete(p.Settings, "access-mode")
	for _, target := range []string{"windows", "linux"} {
		out, err := Render(target, p, Secrets{}, "host=rd.example,key=abc")
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(out), "'access-mode'") || !strings.Contains(string(out), "'custom'") {
			t.Fatalf("%s missing custom access mode", target)
		}
	}
}

func TestLatestReleaseProfile(t *testing.T) {
	p := defaultProfile()
	if p.ClientVersion != "latest" {
		t.Fatalf("default client version = %q, want latest", p.ClientVersion)
	}
	if err := Validate(p); err != nil {
		t.Fatalf("latest GitHub profile: %v", err)
	}
	p.InstallerSource = "url"
	if err := Validate(p); err == nil || err.Error() != "client_version: latest needs the GitHub installer source" {
		t.Fatalf("latest URL profile: %v", err)
	}
	p.ClientVersion = "bad"
	if err := Validate(p); err == nil || err.Error() != "client_version: must be major.minor.patch" {
		t.Fatalf("invalid version: %v", err)
	}
	p = defaultProfile()
	for _, tc := range []struct {
		field string
		set   func(*Profile)
	}{
		{"sha256_windows", func(p *Profile) { p.SHA256Windows = strings.Repeat("a", 64) }},
		{"sha256_deb", func(p *Profile) { p.SHA256Deb = strings.Repeat("a", 64) }},
		{"sha256_rpm", func(p *Profile) { p.SHA256RPM = strings.Repeat("a", 64) }},
	} {
		t.Run(tc.field, func(t *testing.T) {
			q := p
			tc.set(&q)
			if err := Validate(q); err == nil || err.Error() != tc.field+": not allowed with the latest release" {
				t.Fatalf("latest checksum: %v", err)
			}
		})
	}
}

func TestRenderLatestLookupSafety(t *testing.T) {
	p, s := fixture()
	p.ClientVersion = "latest"
	for _, tc := range []struct {
		name string
		want []string
		bad  []string
	}{
		{"linux", []string{
			"curl -fsS -o /dev/null -w '%{redirect_url}' 'https://github.com/rustdesk/rustdesk/releases/latest'",
			"https://github.com/rustdesk/rustdesk/releases/tag/*",
			"target_version=${redirect##*/}", "tr -d '\\015'",
			"wget -qO- 'https://api.github.com/repos/rustdesk/rustdesk/releases/latest'",
			"Latest release lookup failed; keeping the installed version",
			"if [ -x \"$exe\" ]; then", "if [ \"$latest_lookup_ok\" -eq 1 ]; then",
		}, []string{"curl -fsSL 'https://api.github.com/repos/rustdesk/rustdesk/releases/latest'"}},
		{"windows", []string{
			"[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12",
			"[Net.HttpWebRequest]::Create('https://github.com/rustdesk/rustdesk/releases/latest')",
			"$request.AllowAutoRedirect = $false", "$request.Method = 'HEAD'", "$request.UserAgent = 'ferricade'",
			"$response.Headers['Location']", "$response.Close()",
			"StartsWith('https://github.com/rustdesk/rustdesk/releases/tag/', [StringComparison]::Ordinal)",
			`\A[0-9]+\.[0-9]+\.[0-9]+\z`,
			"Latest release lookup failed; keeping the installed version",
			"if (Test-Path -LiteralPath $exe)", "if ($latestLookupOk) {",
		}, []string{"Invoke-RestMethod -Uri 'https://api.github.com/repos/rustdesk/rustdesk/releases/latest'"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			script, err := Render(tc.name, p, s, "host=rd.example,key=abc")
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range tc.want {
				if !bytes.Contains(script, []byte(want)) {
					t.Errorf("missing %q", want)
				}
			}
			for _, bad := range tc.bad {
				if bytes.Contains(script, []byte(bad)) {
					t.Errorf("unexpected %q", bad)
				}
			}
			fallback := bytes.Index(script, []byte("Latest release lookup failed; keeping the installed version"))
			config := bytes.Index(script, []byte("--config"))
			if fallback < 0 || config <= fallback {
				t.Error("configuration must remain after lookup fallback")
			}
			if tc.name == "linux" {
				if !bytes.Contains(script, []byte("elif [ -x \"$exe\" ]; then\n  log_step 'Latest release lookup failed; keeping the installed version'\nelse\n  fail 21 'Could not determine the latest RustDesk release'\nfi\nif [ \"$latest_lookup_ok\" -eq 1 ]; then")) {
					t.Error("lookup failure must exit only without an installed client and skip installation otherwise")
				}
			} else {
				if !bytes.Contains(script, []byte("if (Test-Path -LiteralPath $exe) { Log-Step 'Latest release lookup failed; keeping the installed version' }\n    else { Fail 21 'Could not determine the latest RustDesk release' }")) {
					t.Error("lookup failure must exit only without an installed client")
				}
				if bytes.Index(script, []byte("[Net.SecurityProtocolType]::Tls12")) > bytes.Index(script, []byte("[Net.HttpWebRequest]::Create")) {
					t.Error("TLS 1.2 must be enabled before lookup")
				}
			}
		})
	}
	p.ClientVersion = "1.5.0"
	win, err := Render("windows", p, s, "host=rd.example,key=abc")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(win, []byte("[Net.SecurityProtocolType]::Tls12")) || bytes.Contains(win, []byte(`\A[0-9]+\.[0-9]+\.[0-9]+\z`)) {
		t.Error("pinned install must enable TLS 1.2 without latest-release logic")
	}
}

func TestRenderInstallerTemporaryFiles(t *testing.T) {
	p, s := fixture()
	linux, err := Render("linux", p, s, "host=rd.example,key=abc")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"tmpdir=$(mktemp -d /tmp/ferricade-rustdesk.XXXXXX)",
		"chmod 0755 \"$tmpdir\"",
		"file=\"$tmpdir/pkg.$suffix\"",
		"chmod 0644 \"$file\"",
		"trap 'rm -rf \"$tmpdir\"' 0 HUP INT TERM",
	} {
		if !bytes.Contains(linux, []byte(want)) {
			t.Errorf("linux installer missing %q", want)
		}
	}
}

func TestRenderLatestRelease(t *testing.T) {
	p, s := fixture()
	p.ClientVersion = "latest"
	for _, target := range []string{"windows", "linux"} {
		t.Run(target, func(t *testing.T) {
			script, err := Render(target, p, s, "host=rd.example,key=abc")
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range []string{"Could not determine the latest RustDesk release", "Latest RustDesk release:", "21", "rustdesk-"} {
				if !bytes.Contains(script, []byte(want)) {
					t.Errorf("missing %q", want)
				}
			}
			if bytes.Contains(script, []byte("/download/latest/")) {
				t.Error("unchecked latest in download URL")
			}
			if target == "windows" {
				if !bytes.Contains(script, []byte(`\A[0-9]+\.[0-9]+\.[0-9]+\z`)) {
					t.Error("missing tag validation")
				}
				if path, err := exec.LookPath("powershell.exe"); err == nil {
					file := filepath.Join(t.TempDir(), "latest.ps1")
					if err := os.WriteFile(file, script, 0600); err != nil {
						t.Fatal(err)
					}
					cmd := exec.Command(path, "-NoProfile", "-Command", `$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($env:DEPLOY_PARSE_FILE),[ref]$tokens,[ref]$errors) | Out-Null; if ($errors.Count) { $errors | Out-String; exit 1 }`)
					cmd.Env = append(os.Environ(), "DEPLOY_PARSE_FILE="+file)
					if out, err := cmd.CombinedOutput(); err != nil {
						t.Errorf("PowerShell parse: %s: %v", out, err)
					}
				}
			} else {
				if !bytes.Contains(script, []byte("^[0-9]+\\.[0-9]+\\.[0-9]+$")) {
					t.Error("missing tag validation")
				}
				for _, shell := range []string{"sh", "bash"} {
					path, err := exec.LookPath(shell)
					if err != nil {
						t.Logf("%s unavailable", shell)
						continue
					}
					cmd := exec.Command(path, "-n")
					cmd.Stdin = bytes.NewReader(script)
					if out, err := cmd.CombinedOutput(); err != nil {
						t.Errorf("%s -n: %s: %v", shell, out, err)
					}
				}
			}
		})
	}
	p.IncludeInstall = false
	for _, target := range []string{"windows", "linux"} {
		script, err := Render(target, p, s, "host=rd.example,key=abc")
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(script, []byte("https://api.github.com/repos/rustdesk/rustdesk/releases/latest")) {
			t.Errorf("%s: lookup with installation disabled", target)
		}
	}
}

func TestRenderOutputHasNoCR(t *testing.T) {
	p, secrets := fixture()
	for _, target := range []string{"windows", "linux"} {
		t.Run(target, func(t *testing.T) {
			got, err := Render(target, p, secrets, "host=rd.example,key=abc")
			if err != nil {
				t.Fatal(err)
			}
			if bytes.ContainsRune(got, '\r') {
				t.Fatal("rendered script contains CR")
			}
		})
	}
}

func TestRenderRestartsServiceAfterInstall(t *testing.T) {
	p, secrets := fixture()
	for _, tc := range []struct {
		name  string
		steps []string
	}{
		{"linux", []string{"if [ \"$need_install\" -eq 1 ]; then", "systemctl daemon-reload", "systemctl enable rustdesk", "systemctl restart rustdesk", "for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15", "sleep 1", "systemctl is-active --quiet rustdesk", "\"$exe\" --version", "Installed version is", "RustDesk service restarted", "Install check completed", "\"$exe\" --config"}},
		{"windows", []string{"if ($needInstall) {", "Restart-Service -Name RustDesk -Force", "Start-Service -Name RustDesk", "$attempt -lt 15", "Start-Sleep -Seconds 1", "Get-Service -Name RustDesk", "--version", "Installed version is", "RustDesk service restarted", "Install check completed", "Run-Client @('--config'"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Render(tc.name, p, secrets, "host=rd.example,key=abc")
			if err != nil {
				t.Fatal(err)
			}
			output := string(got)
			position := -1
			for _, step := range tc.steps {
				next := strings.Index(output[position+1:], step)
				if next < 0 {
					t.Fatalf("%q missing or out of order after position %d", step, position)
				}
				position += next + 1
			}
		})
	}
}

func TestRenderNoRestartWithoutInstall(t *testing.T) {
	p, secrets := fixture()
	p.IncludeInstall = false
	for _, target := range []string{"linux", "windows"} {
		t.Run(target, func(t *testing.T) {
			got, err := Render(target, p, secrets, "host=rd.example,key=abc")
			if err != nil {
				t.Fatal(err)
			}
			for _, forbidden := range []string{"systemctl restart rustdesk", "Restart-Service -Name RustDesk", "Start-Service -Name RustDesk", "RustDesk service restarted"} {
				if strings.Contains(string(got), forbidden) {
					t.Fatalf("%q rendered without install", forbidden)
				}
			}
		})
	}
}

func TestWindowsVersionReadsUseRunClient(t *testing.T) {
	p, secrets := fixture()
	got, err := Render("windows", p, secrets, "host=rd.example,key=abc")
	if err != nil {
		t.Fatal(err)
	}
	script := string(got)
	if strings.Contains(script, "& $exe --version") {
		t.Fatal("version read bypasses Run-Client")
	}
	function := strings.Index(script, "function Run-Client(")
	firstRead := strings.Index(script, "Run-Client @('--version')")
	if function < 0 || firstRead < 0 || function >= firstRead {
		t.Fatal("Run-Client must be defined before the first version read")
	}
	if strings.Count(script, "Run-Client @('--version')") != 2 {
		t.Fatal("both version reads must use Run-Client")
	}
	if !strings.Contains(script, "try { $currentVersion = Run-Client @('--version') }") ||
		!strings.Contains(script, "catch { $currentVersion = [string]::Empty; Log-Step 'Installed version unreadable' }") {
		t.Fatal("initial version read must catch failures and log an unreadable version")
	}
}

func TestRenderParses(t *testing.T) {
	p, s := fixture()
	win, err := Render("windows", p, s, "host=rd.example,key=abc")
	if err != nil {
		t.Fatal(err)
	}
	t.Run("powershell.exe", func(t *testing.T) {
		path, err := exec.LookPath("powershell.exe")
		if err != nil {
			t.Skip("powershell.exe unavailable")
		}
		file := filepath.Join(t.TempDir(), "deploy.ps1")
		if err := os.WriteFile(file, win, 0600); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(path, "-NoProfile", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($env:DEPLOY_PARSE_FILE),[ref]$tokens,[ref]$errors) | Out-Null; if ($errors.Count) { $errors | Out-String; exit 1 }`)
		cmd.Env = append(os.Environ(), "DEPLOY_PARSE_FILE="+file)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("PowerShell parse: %s: %v", out, err)
		}
	})
	lin, err := Render("linux", p, s, "host=rd.example,key=abc")
	if err != nil {
		t.Fatal(err)
	}
	for _, shell := range []string{"sh", "bash"} {
		t.Run(shell, func(t *testing.T) {
			path, err := exec.LookPath(shell)
			if err != nil && shell == "sh" {
				path, err = exec.LookPath(`C:\Program Files\Git\bin\sh.exe`)
			}
			if err != nil {
				t.Skipf("%s unavailable", shell)
			}
			cmd := exec.Command(path, "-n")
			cmd.Stdin = bytes.NewReader(lin)
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("%s parse: %s: %v", shell, out, err)
			}
		})
	}
}

func TestRenderOmitsSecrets(t *testing.T) {
	p, _ := fixture()
	p.IncludePassword = false
	p.IncludeUnlockPIN = false
	for _, target := range []string{"windows", "linux"} {
		got, err := Render(target, p, Secrets{}, "host=rd.example,key=abc")
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(got, []byte("--password")) || bytes.Contains(got, []byte("--set-unlock-pin")) {
			t.Fatalf("%s contains secret step", target)
		}
	}
}

func TestRenderUnreadableSecrets(t *testing.T) {
	for _, target := range []string{"linux", "windows"} {
		t.Run(target, func(t *testing.T) {
			p, _ := fixture()
			for _, tc := range []struct {
				name, field string
				secrets     Secrets
			}{
				{"password", "fleet_password", Secrets{PasswordUnreadable: true}},
				{"pin", "unlock_pin", Secrets{PINUnreadable: true}},
			} {
				t.Run(tc.name, func(t *testing.T) {
					got, err := Render(target, p, tc.secrets, "host=rd.example,key=abc")
					var invalid *ValidationError
					if !errors.As(err, &invalid) || invalid.Field != tc.field || !strings.Contains(invalid.Msg, "cannot be decrypted") {
						t.Fatalf("expected %s decryption error, got %v", tc.field, err)
					}
					if got != nil {
						t.Fatal("script returned for unreadable secret")
					}
				})
			}
			p.IncludePassword, p.IncludeUnlockPIN = false, false
			got, err := Render(target, p, Secrets{PasswordUnreadable: true, PINUnreadable: true}, "host=rd.example,key=abc")
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(got, []byte("--password")) || bytes.Contains(got, []byte("--set-unlock-pin")) {
				t.Fatal("include-off script contains a secret command")
			}
		})
	}
}

func TestRenderSecretSetAndClearSteps(t *testing.T) {
	for _, target := range []string{"linux", "windows"} {
		t.Run(target, func(t *testing.T) {
			p, secrets := fixture()
			secrets.Password = nil
			secrets.UnlockPIN = nil
			clear, err := Render(target, p, secrets, "host=rd.example,key=abc")
			if err != nil {
				t.Fatal(err)
			}
			clearScript := string(clear)
			clearCommands := []string{`"$exe" --password ''`, `"$exe" --set-unlock-pin ''`}
			setCommands := []string{`"$exe" --password 'P@ss`, `"$exe" --set-unlock-pin '12'`}
			if target == "windows" {
				clearCommands = []string{`Run-ClientRaw '--password ""'`, `Run-ClientRaw '--set-unlock-pin ""'`}
				setCommands = []string{`Run-Client @('--password',`, `Run-Client @('--set-unlock-pin',`}
			}
			for _, want := range []string{clearCommands[0], clearCommands[1], "Password removal failed", "Password removal completed", "Unlock PIN removal failed", "Unlock PIN removal completed"} {
				if !strings.Contains(clearScript, want) {
					t.Errorf("clear script missing %q", want)
				}
			}
			for _, forbidden := range setCommands {
				if strings.Contains(clearScript, forbidden) {
					t.Errorf("clear script contains set command %q", forbidden)
				}
			}

			p.IncludePassword = false
			p.IncludeUnlockPIN = false
			off, err := Render(target, p, secrets, "host=rd.example,key=abc")
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(off), "--password") || strings.Contains(string(off), "--set-unlock-pin") {
				t.Fatal("include-off script contains a password or PIN command")
			}

			p, secrets = fixture()
			set, err := Render(target, p, secrets, "host=rd.example,key=abc")
			if err != nil {
				t.Fatal(err)
			}
			setScript := string(set)
			for _, want := range setCommands {
				if !strings.Contains(setScript, want) {
					t.Errorf("set script missing command %q", want)
				}
			}
			for _, forbidden := range clearCommands {
				if strings.Contains(setScript, forbidden) {
					t.Errorf("set script contains clear command %q", forbidden)
				}
			}
			if target == "linux" {
				for _, want := range []string{"case $out in *'Done!'*", "Password configuration failed", "Unlock PIN configuration failed"} {
					if !strings.Contains(setScript, want) {
						t.Errorf("set script missing success check %q", want)
					}
				}
			} else {
				for _, want := range []string{"-like '*Done!*'", "Password configuration failed", "Unlock PIN configuration failed"} {
					if !strings.Contains(setScript, want) {
						t.Errorf("set script missing success check %q", want)
					}
				}
			}
			if strings.Contains(setScript, "Password removal") || strings.Contains(setScript, "Unlock PIN removal") {
				t.Fatal("set script contains removal step")
			}
		})
	}
}

func TestWindowsRunClientRawPreservesEmptyArgument(t *testing.T) {
	p, s := fixture()
	rendered, err := Render("windows", p, s, "host=rd.example,key=abc")
	if err != nil {
		t.Fatal(err)
	}
	script := string(rendered)
	start := strings.Index(script, "function Run-ClientRaw(")
	if start < 0 {
		t.Fatal("Run-ClientRaw function missing")
	}
	end := strings.Index(script[start:], "\n}\n")
	if end < 0 {
		t.Fatal("Run-ClientRaw function end missing")
	}
	function := script[start : start+end+3]
	tmp := t.TempDir()
	clientSource := filepath.Join(tmp, "stub.go")
	clientBinary := filepath.Join(tmp, "stub.exe")
	source := "package main\nimport (\"fmt\"; \"os\")\nfunc main() { for _, arg := range os.Args[1:] { fmt.Printf(\"[%s]\", arg) }; fmt.Println(); fmt.Println(\"Done!\") }\n"
	if err := os.WriteFile(clientSource, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	build := exec.Command("go", "build", "-o", clientBinary, clientSource)
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build stub client: %s: %v", out, err)
	}
	for _, shell := range []string{"powershell.exe", "pwsh"} {
		t.Run(shell, func(t *testing.T) {
			path, err := exec.LookPath(shell)
			if err != nil {
				t.Skipf("%s unavailable", shell)
			}
			code := "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; $exe=" + QuotePS(clientBinary) + "; " + function + "\n"
			for _, test := range []struct{ args, want string }{
				{"'--password \"\"'", "[--password][]"},
				{"'--set-unlock-pin \"\"'", "[--set-unlock-pin][]"},
			} {
				command := code + "$out = Run-ClientRaw " + test.args + "; Write-Output $out"
				out, err := exec.Command(path, "-NoProfile", "-Command", command).CombinedOutput()
				if err != nil {
					t.Fatalf("Run-ClientRaw %s: %s: %v", test.args, out, err)
				}
				if got, want := strings.TrimSpace(string(out)), test.want+"`nDone!"; got != strings.ReplaceAll(want, "`n", "\n") {
					t.Errorf("Run-ClientRaw output = %q, want %q", got, strings.ReplaceAll(want, "`n", "\n"))
				}
			}
		})
	}
}

func TestRenderNeverLogsSecrets(t *testing.T) {
	p, s := fixture()
	for _, target := range []string{"windows", "linux"} {
		got, err := Render(target, p, s, "host=rd.example,key=abc")
		if err != nil {
			t.Fatal(err)
		}
		quote := QuoteSH
		if target == "windows" {
			quote = QuotePS
		}
		for _, line := range strings.Split(string(got), "\n") {
			if strings.Contains(line, quote(*s.Password)) || strings.Contains(line, quote(*s.UnlockPIN)) {
				if !strings.Contains(line, "--password") && !strings.Contains(line, "--set-unlock-pin") {
					t.Errorf("%s leaked secret in %q", target, line)
				}
			}
		}
	}
}

func TestRenderSkipsUnknownAndOtherOS(t *testing.T) {
	p, _ := fixture()
	p.Settings["unknown-setting"] = SettingValue{Include: true, Value: "oops"}
	settingsCatalog = append(settingsCatalog, Setting{Key: "windows-only", Type: "bool", OS: []string{"windows"}})
	defer func() { settingsCatalog = settingsCatalog[:len(settingsCatalog)-1] }()
	p.Settings["windows-only"] = SettingValue{Include: true, Value: "Y"}
	for _, target := range []string{"windows", "linux"} {
		got, err := Render(target, p, Secrets{}, "host=rd.example,key=abc")
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(got, []byte("unknown-setting")) {
			t.Fatal("unknown key rendered")
		}
		if target == "linux" && bytes.Contains(got, []byte("windows-only")) {
			t.Fatal("other-OS setting rendered")
		}
		if target == "windows" && !bytes.Contains(got, []byte("windows-only")) {
			t.Fatal("same-OS setting omitted")
		}
	}
	if _, err := Render("macos", p, Secrets{}, "host=x"); err == nil {
		t.Fatal("unknown OS accepted")
	}
}

func TestRenderNoEmptyArgs(t *testing.T) {
	p, s := fixture()
	for _, target := range []string{"windows", "linux"} {
		got, err := Render(target, p, s, "host=rd.example,key=abc")
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(got, []byte(" ''")) {
			t.Fatalf("%s has empty argument", target)
		}
	}
}

func TestValidate(t *testing.T) {
	p, _ := fixture()
	cases := []struct {
		field  string
		change func(*Profile)
	}{{"settings.bad", func(p *Profile) { p.Settings["bad"] = SettingValue{Include: true, Value: "Y"} }}, {"settings.approve-mode", func(p *Profile) { p.Settings["approve-mode"] = SettingValue{Include: true, Value: "bad"} }}, {"settings.enable-audio", func(p *Profile) { p.Settings["enable-audio"] = SettingValue{Include: true, Value: "bad"} }}, {"settings.enable-audio", func(p *Profile) { p.Settings["enable-audio"] = SettingValue{Include: true, Value: ""} }}, {"installer_source", func(p *Profile) { p.InstallerSource = "bad" }}, {"client_version", func(p *Profile) { p.ClientVersion = "1.5" }}, {"sha256_deb", func(p *Profile) { p.SHA256Deb = "bad" }}}
	for _, tc := range cases {
		t.Run(tc.field, func(t *testing.T) {
			q := p
			q.Settings = map[string]SettingValue{}
			for k, v := range p.Settings {
				q.Settings[k] = v
			}
			tc.change(&q)
			var ve *ValidationError
			requireErr := Validate(q)
			if !errors.As(requireErr, &ve) || ve.Field != tc.field {
				t.Fatalf("got %v; want validation field %s", requireErr, tc.field)
			}
		})
	}
	if err := Validate(p); err != nil {
		t.Fatal(err)
	}
}

func TestValidateApproveModePasswordOrClick(t *testing.T) {
	p, _ := fixture()
	p.Settings["approve-mode"] = SettingValue{Include: true, Value: "password-click"}
	if err := Validate(p); err != nil {
		t.Fatalf("Validate rejected password-click: %v", err)
	}
}

func TestValidateInstallerURLs(t *testing.T) {
	for _, tc := range []struct {
		name, field, windows, deb, rpm, sha string
		valid                               bool
	}{
		{"empty", "", "", "", "", "", true},
		{"windows https", "", "https://example.test/client.msi", "", "", "", true},
		{"windows http missing checksum", "url_windows", "http://example.test/client.msi", "", "", "", false},
		{"windows http checksum", "", "http://example.test/client.msi", "", "", strings.Repeat("a", 64), true},
		{"windows UNC missing checksum", "url_windows", `\\server\share\client.msi`, "", "", "", false},
		{"linux https", "", "", "https://example.test/client.deb", "", "", true},
		{"linux http missing checksum", "url_rpm", "", "", "http://example.test/client.rpm", "", false},
		{"linux http checksum", "", "", "", "http://example.test/client.rpm", strings.Repeat("a", 64), true},
		{"windows ftp", "url_windows", "ftp://example.test/client.msi", "", "", "", false},
		{"windows space", "url_windows", "https://example.test/a b.msi", "", "", "", false},
		{"windows control", "url_windows", "https://example.test/a\nb.msi", "", "", "", false},
		{"debian UNC", "url_deb", "", `\\server\share\client.deb`, "", "", false},
		{"debian tab", "url_deb", "", "https://example.test/a\tb.deb", "", "", false},
		{"rpm ftp", "url_rpm", "", "", "ftp://example.test/client.rpm", "", false},
		{"rpm newline", "url_rpm", "", "", "https://example.test/a\nb.rpm", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, _ := fixture()
			p.URLWindows, p.URLDeb, p.URLRPM = tc.windows, tc.deb, tc.rpm
			if tc.windows != "" {
				p.SHA256Windows = tc.sha
			}
			if tc.deb != "" {
				p.SHA256Deb = tc.sha
			}
			if tc.rpm != "" {
				p.SHA256RPM = tc.sha
			}
			err := Validate(p)
			if tc.valid {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			var ve *ValidationError
			if !errors.As(err, &ve) || ve.Field != tc.field {
				t.Fatalf("got %v; want validation field %s", err, tc.field)
			}
		})
	}
}

func TestValidateLatestRejectsInsecureInstallerURLsClearly(t *testing.T) {
	for _, tc := range []struct{ field, value string }{
		{"url_windows", "http://example.test/client.msi"},
		{"url_windows", `\\server\share\client.msi`},
		{"url_deb", "http://example.test/client.deb"},
		{"url_rpm", "http://example.test/client.rpm"},
	} {
		t.Run(tc.field, func(t *testing.T) {
			p, _ := fixture()
			p.ClientVersion = "latest"
			switch tc.field {
			case "url_windows":
				p.URLWindows = tc.value
			case "url_deb":
				p.URLDeb = tc.value
			case "url_rpm":
				p.URLRPM = tc.value
			}
			var ve *ValidationError
			if err := Validate(p); !errors.As(err, &ve) || ve.Field != tc.field || ve.Msg != "must be https:// with the latest release" {
				t.Fatalf("got %v; want %s: must be https:// with the latest release", err, tc.field)
			}
		})
	}
}

func TestWindowsRunClientToleratesStderr(t *testing.T) {
	path, err := exec.LookPath("powershell.exe")
	if err != nil {
		t.Skip("powershell.exe unavailable")
	}
	p, s := fixture()
	rendered, err := Render("windows", p, s, "host=rd.example,key=abc")
	if err != nil {
		t.Fatal(err)
	}
	start := strings.Index(string(rendered), "function Run-Client(")
	if start < 0 {
		t.Fatal("Run-Client function missing")
	}
	end := strings.Index(string(rendered)[start:], "\n}\n")
	if end < 0 {
		t.Fatal("Run-Client function end missing")
	}
	function := string(rendered)[start : start+end+3]
	code := "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; $exe='cmd.exe'; " + function + "\ntry { $result = Run-Client @('/c','echo ok& echo warn 1>&2'); Write-Output $result } catch { Write-Error 'Run-Client threw'; exit 1 }"
	out, err := exec.Command(path, "-NoProfile", "-Command", code).CombinedOutput()
	if err != nil || !bytes.Contains(out, []byte("ok")) {
		t.Fatalf("Run-Client returned %q, error %v", out, err)
	}
}

func TestValidatePassword(t *testing.T) {
	good := "P@ss'w$rd1"
	if err := ValidatePassword(good); err != nil {
		t.Fatal(err)
	}
	if err := ValidatePassword("Pässw0rd1"); err != nil {
		t.Fatal(err)
	}
	cases := []struct{ name, value, rule string }{
		{"short", "Ab1", "length"}, {"long", "Ab1" + strings.Repeat("a", 126), "length"},
		{"uppercase", "lowercase1", "uppercase"}, {"lowercase", "UPPERCASE1", "lowercase"},
		{"digit", "NoDigitsHere", "digit"},
		{"quote", "Pass\"word1", "forbidden"}, {"backslash", `Pass\word1`, "forbidden"},
		{"newline", "Pass\nword1", "forbidden"}, {"tab", "Pass\tword1", "forbidden"}, {"delete", "Pass\x7fword1", "forbidden"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidatePassword(tc.value)
			if err == nil || !strings.Contains(err.Error(), tc.rule) {
				t.Fatalf("got %v; want %s", err, tc.rule)
			}
		})
	}
}

func TestWindowsScriptHasBOM(t *testing.T) {
	if _, err := exec.LookPath("powershell.exe"); err != nil {
		t.Skip("powershell.exe unavailable")
	}
	p, s := fixture()
	win, err := Render("windows", p, s, "host=rd.example,key=abc")
	if err != nil {
		t.Fatal(err)
	}
	lin, err := Render("linux", p, s, "host=rd.example,key=abc")
	if err != nil {
		t.Fatal(err)
	}
	bom := []byte{0xef, 0xbb, 0xbf}
	if !bytes.HasPrefix(win, bom) {
		t.Fatal("Windows script missing UTF-8 BOM")
	}
	if bytes.HasPrefix(lin, bom) {
		t.Fatal("Linux script has UTF-8 BOM")
	}
}

func TestPowerShellReadsNonASCIIScript(t *testing.T) {
	path, err := exec.LookPath("powershell.exe")
	if err != nil {
		t.Skip("powershell.exe unavailable")
	}
	want := "Pässw0rd€"
	script := withUTF8BOM([]byte("[Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output " + QuotePS(want)))
	file := filepath.Join(t.TempDir(), "non-ascii.ps1")
	if err := os.WriteFile(file, script, 0600); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(path, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file).CombinedOutput()
	got := strings.TrimSuffix(strings.TrimSuffix(string(out), "\r\n"), "\n")
	if err != nil || got != want {
		t.Fatalf("got %q, err %v; want %q", got, err, want)
	}
}

func TestValidateUnlockPIN(t *testing.T) {
	if err := ValidateUnlockPIN("12'34"); err != nil {
		t.Fatal(err)
	}
	cases := []struct{ name, value, rule string }{
		{"short", "123", "length"}, {"long", strings.Repeat("1", 129), "length"},
		{"quote", `12"34`, "forbidden"}, {"backslash", `12\34`, "forbidden"},
		{"newline", "12\n34", "forbidden"}, {"tab", "12\t34", "forbidden"}, {"delete", "12\x7f34", "forbidden"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateUnlockPIN(tc.value)
			if err == nil || !strings.Contains(err.Error(), tc.rule) {
				t.Fatalf("got %v; want %s", err, tc.rule)
			}
		})
	}
}

func TestRenderRejectsInvalidSecrets(t *testing.T) {
	p, s := fixture()
	badPassword, badPIN := "bad\nPass1", `12\34`
	for _, target := range []string{"windows", "linux"} {
		t.Run(target+"/password", func(t *testing.T) {
			s.Password = &badPassword
			if _, err := Render(target, p, s, "host=rd.example,key=abc"); err == nil || !strings.Contains(err.Error(), "password") {
				t.Fatalf("got %v", err)
			}
		})
		t.Run(target+"/PIN", func(t *testing.T) {
			s.Password = nil
			s.UnlockPIN = &badPIN
			if _, err := Render(target, p, s, "host=rd.example,key=abc"); err == nil || !strings.Contains(err.Error(), "unlock_pin") {
				t.Fatalf("got %v", err)
			}
		})
	}
	p.IncludePassword = false
	p.IncludeUnlockPIN = false
	if _, err := Render("windows", p, Secrets{Password: &badPassword, UnlockPIN: &badPIN}, "host=rd.example,key=abc"); err != nil {
		t.Fatalf("excluded secrets rejected: %v", err)
	}
}

func TestRenderIDAllowList(t *testing.T) {
	if _, ok := Lookup("id-whitelist"); ok {
		t.Fatal("id-whitelist must not be in catalog")
	}

	t.Run("included with two IDs", func(t *testing.T) {
		p := defaultProfile()
		p.ClientVersion = "1.5.0"
		p.IncludeIDAllowList = true
		p.IDAllowList = []string{"ABC123", "DEF456"}
		for _, tc := range []struct {
			os   string
			want string
		}{
			{"windows", "Run-Client @('--option', 'id-whitelist', 'ABC123,DEF456')"},
			{"linux", `"$exe" --option 'id-whitelist' 'ABC123,DEF456'`},
		} {
			out, err := Render(tc.os, p, Secrets{}, "host=rd.example,key=abc")
			if err != nil {
				t.Fatalf("%s render: %v", tc.os, err)
			}
			if !strings.Contains(string(out), tc.want) {
				t.Fatalf("%s script missing %q", tc.os, tc.want)
			}
		}
	})

	t.Run("excluded when flag off or list empty or stored in settings", func(t *testing.T) {
		cases := []struct {
			name string
			mod  func(*Profile)
		}{
			{"flag off", func(p *Profile) {
				p.IncludeIDAllowList = false
				p.IDAllowList = []string{"ABC123", "DEF456"}
			}},
			{"empty list", func(p *Profile) {
				p.IncludeIDAllowList = true
				p.IDAllowList = nil
			}},
			{"stored id-whitelist in settings dropped", func(p *Profile) {
				p.IncludeIDAllowList = false
				p.Settings["id-whitelist"] = SettingValue{Include: true, Value: "STALE999"}
			}},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				p := defaultProfile()
				p.ClientVersion = "1.5.0"
				tc.mod(&p)
				for _, target := range []string{"windows", "linux"} {
					out, err := Render(target, p, Secrets{}, "host=rd.example,key=abc")
					if err != nil {
						t.Fatalf("%s render: %v", target, err)
					}
					if strings.Contains(string(out), "id-whitelist") {
						t.Fatalf("%s script unexpectedly contains id-whitelist", target)
					}
				}
			})
		}
	})
}
