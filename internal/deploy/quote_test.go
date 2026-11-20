package deploy

import (
	"encoding/base64"
	"os/exec"
	"strings"
	"testing"
)

func TestQuotePS(t *testing.T) {
	for _, shell := range []string{"powershell.exe", "pwsh"} {
		t.Run(shell, func(t *testing.T) {
			path, err := exec.LookPath(shell)
			if err != nil {
				t.Skipf("%s unavailable: %v", shell, err)
			}
			for _, value := range quoteCases() {
				t.Run(value, func(t *testing.T) {
					cmd := exec.Command(path, "-NoProfile", "-Command", "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output "+QuotePS(value))
					out, err := cmd.CombinedOutput()
					got := strings.TrimSuffix(strings.TrimSuffix(string(out), "\r\n"), "\n")
					if err != nil || got != value {
						t.Fatalf("got %q, err %v; want %q", out, err, value)
					}
				})
			}
		})
	}
}

func TestQuotePSPayloadIsOneLiteral(t *testing.T) {
	path, err := exec.LookPath("powershell.exe")
	if err != nil {
		t.Skip("powershell.exe unavailable")
	}
	payload := "https://x/a’; Write-Output PWNED; ’"
	encoded := base64.StdEncoding.EncodeToString([]byte(QuotePS(payload)))
	script := "$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded + "')); " +
		"$tokens = $null; $parseErrors = $null; " +
		"[System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors) > $null; " +
		"if ($parseErrors.Count -ne 0) { exit 1 }; ($tokens | ForEach-Object { $_.Kind.ToString() }) -join ','"
	out, err := exec.Command(path, "-NoProfile", "-Command", script).CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != "StringLiteral,EndOfInput" {
		t.Fatalf("quoted payload parsed as %q, err %v", out, err)
	}
}

func TestQuoteSH(t *testing.T) {
	path, err := exec.LookPath("sh")
	if err != nil {
		path, err = exec.LookPath(`C:\Program Files\Git\bin\sh.exe`)
	}
	if err != nil {
		t.Skip("sh unavailable")
	}
	for _, value := range quoteCases() {
		cmd := exec.Command(path, "-c", "printf %s "+QuoteSH(value))
		out, err := cmd.CombinedOutput()
		if err != nil || string(out) != value {
			t.Errorf("got %q, err %v; want %q", out, err, value)
		}
	}
}

func quoteCases() []string {
	return []string{"a'b", "a‘b", "a’b", "a‚b", "a‛b", "https://x/a’; Write-Output PWNED; ’", "$(id)", "`whoami`", "%PATH%", `"x"`, "a\nb", `a\nb`, "ü€", "-NoProfile", strings.Repeat("x", 2)}
}
