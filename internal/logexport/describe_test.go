package logexport

import (
	"go/ast"
	"go/parser"
	"go/token"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dottio123/ferricade/internal/store/db"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestSessionLifetimeDescription(t *testing.T) {
	require.True(t, Known("session_lifetime.changed"))
	require.Equal(t, "configuration", Category("session_lifetime.changed"))
	require.Contains(t, Sentence("session_lifetime.changed", AuditView{ActorName: "owner", ActorRole: "owner"}), "changed sign-in duration")
}

func TestBlockedIDAlarmDescriptions(t *testing.T) {
	for _, action := range []string{"device.id_blocked", "device.id_blocked_repeated", "device.id_blocked_overflow"} {
		require.True(t, Known(action))
		require.Equal(t, "configuration", Category(action))
	}
}

func TestLockoutAlarmDescriptions(t *testing.T) {
	for _, action := range []string{"device.login_locked_out", "device.login_locked_out_repeated"} {
		require.True(t, Known(action))
		require.Equal(t, "configuration", Category(action))
		require.Contains(t, Sentence(action, AuditView{TargetName: "lab"}), "lockout")
	}
}

func TestGroupRuleSentences(t *testing.T) {
	for _, tt := range []struct{ action, verb string }{{"group.rule_added", "added"}, {"group.rule_removed", "removed"}} {
		require.Equal(t, "configuration", Category(tt.action))
		preposition := "to"
		if tt.verb == "removed" {
			preposition = "from"
		}
		require.Equal(t, "jane (Admin) "+tt.verb+" the pattern w-*-it-* "+preposition+" IT Workstations from 203.0.113.1", Sentence(tt.action, AuditView{ActorName: "jane", ActorRole: "admin", TargetName: "IT Workstations", IP: "203.0.113.1", Details: map[string]any{"pattern": "w-*-it-*"}}))
	}
}

func TestAutoSortSentence(t *testing.T) {
	require.True(t, Known("devices.auto_sorted"))
	require.Equal(t, "configuration", Category("devices.auto_sorted"))
	require.Equal(t, "jane (Owner) ran Auto sort all: 37 moved, 4 conflicts, 2 resolved, 210 unchanged from 203.0.113.5", Sentence("devices.auto_sorted", AuditView{ActorName: "jane", ActorRole: "owner", IP: "203.0.113.5", Details: map[string]any{"moved": float64(37), "conflicts": float64(4), "resolved": float64(2), "unchanged": float64(210)}}))
}

func TestEveryAuditActionHasSentenceAndCategory(t *testing.T) {
	actions := map[string]bool{}
	valid := regexp.MustCompile(`^[a-z_]+\.[a-z_]+$`)
	add := func(s string) {
		if valid.MatchString(s) {
			actions[s] = true
		}
	}
	root := filepath.Join("..")
	require.NoError(t, filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			return err
		}
		ast.Inspect(file, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.ValueSpec:
				for i, name := range x.Names {
					if (strings.HasPrefix(name.Name, "Action") || strings.HasPrefix(name.Name, "action")) && i < len(x.Values) {
						if lit, ok := x.Values[i].(*ast.BasicLit); ok && lit.Kind == token.STRING {
							if s, e := strconv.Unquote(lit.Value); e == nil {
								add(s)
							}
						}
					}
				}
			case *ast.KeyValueExpr:
				if key, ok := x.Key.(*ast.Ident); ok && key.Name == "Action" {
					if lit, ok := x.Value.(*ast.BasicLit); ok && lit.Kind == token.STRING {
						if s, e := strconv.Unquote(lit.Value); e == nil {
							add(s)
						}
					}
				}
			case *ast.AssignStmt:
				for i, left := range x.Lhs {
					if id, ok := left.(*ast.Ident); ok && id.Name == "action" && i < len(x.Rhs) {
						if lit, ok := x.Rhs[i].(*ast.BasicLit); ok && lit.Kind == token.STRING {
							if s, e := strconv.Unquote(lit.Value); e == nil {
								add(s)
							}
						}
					}
				}
			}
			return true
		})
		return nil
	}))
	ts, err := os.ReadFile(filepath.Join("..", "..", "web", "src", "features", "audit", "describe.ts"))
	require.NoError(t, err)
	for _, match := range regexp.MustCompile(`case '([a-z_]+\.[a-z_]+)'`).FindAllStringSubmatch(string(ts), -1) {
		add(match[1])
	}
	require.GreaterOrEqual(t, len(actions), 50, "collector found too few actions")
	for action := range actions {
		require.True(t, Known(action), "missing description for %s", action)
		require.NotEmpty(t, Category(action))
		require.NotEmpty(t, descriptions[action].phrase, "missing sentence for %s", action)
		require.NotContains(t, Sentence(action, AuditView{ActorName: "jane", ActorRole: "admin", TargetName: "target"}), action, "fallback sentence for %s", action)
	}
	t.Logf("collected %d audit actions", len(actions))
}

func TestRecordSentences(t *testing.T) {
	cases := []struct {
		view AuditView
		want string
	}{
		{AuditView{Action: "device.approved", ActorName: "jane", ActorRole: "admin", TargetName: "Front Desk PC", RustdeskID: "123456789", IP: "203.0.113.5"}, "jane (Admin) approved Front Desk PC (123456789) from 203.0.113.5"},
		{AuditView{Action: "auth.login_failed", Details: map[string]any{"username": "jane"}, IP: "203.0.113.5"}, "Sign-in failed for jane from 203.0.113.5"},
		{AuditView{Action: "auth.login", ActorName: "jane", ActorRole: "owner", IP: "203.0.113.5"}, "jane (Owner) signed in from 203.0.113.5"},
		{AuditView{Action: "access_window.closed", System: true, TargetName: "Front Desk PC", RustdeskID: "123456789", Details: map[string]any{"reason": "expired"}}, "ferricade (system) closed the access window on Front Desk PC (123456789)"},
	}
	for _, tc := range cases {
		require.Equal(t, tc.want, Sentence(tc.view.Action, tc.view))
	}
	ip := netip.MustParseAddr("198.51.100.7")
	start := time.Date(2026, 10, 21, 14, 0, 0, 0, time.UTC)
	end := start.Add(12 * time.Minute)
	reason := "closed"
	session := db.GetLogExportSessionRow{ID: uuid.New(), DeviceID: uuid.New(), PeerName: "bob-laptop", PeerRustdeskID: "987654321", Alias: "Front Desk PC", RustdeskID: "123456789", ClientIP: &ip, StartedAt: start, EndedAt: &end, EndReason: &reason}
	require.Equal(t, "Remote session started: bob-laptop (987654321) to Front Desk PC (123456789) from 198.51.100.7", sessionRecord(session, "start", "ferricade.example.com").Message)
	require.Equal(t, "Remote session ended: bob-laptop (987654321) to Front Desk PC (123456789) after 12 min (closed)", sessionRecord(session, "end", "ferricade.example.com").Message)
}
