package logexport

import (
	"fmt"
	"strings"
)

type AuditView struct {
	Action, ActorName, ActorRole, TargetName, RustdeskID, IP string
	System                                                   bool
	Details                                                  map[string]any
}

type description struct{ category, phrase string }

// Every known audit action has its own sentence and category. The source-scanning
// test makes adding an action without adding it here a failing change.
var descriptions = map[string]description{
	"devices.auto_sorted":          {"configuration", "ran Auto sort all"},
	"group.rule_added":             {"configuration", "added the pattern"},
	"group.rule_removed":           {"configuration", "removed the pattern"},
	"device.approved":              {"configuration", "approved"},
	"device.rejected":              {"configuration", "rejected"},
	"device.archived":              {"configuration", "archived"},
	"device.reopened":              {"configuration", "reopened"},
	"device.restored":              {"configuration", "restored"},
	"device.updated":               {"configuration", "updated"},
	"device.connect_link":          {"configuration", "generated a connect link for"},
	"device.enrolled":              {"configuration", "enrolled"},
	"device.enroll_dropped":        {"configuration", "dropped enrollment for"},
	"device.uuid_mismatch":         {"configuration", "reported uuid mismatch for"},
	"device.id_blocked":            {"configuration", "blocked ID attempt for"},
	"device.id_blocked_repeated":   {"configuration", "summarized repeated blocked ID attempts for"},
	"device.id_blocked_overflow":   {"configuration", "summarized excess blocked ID attempts for"},
	"device.alert_resolved":        {"configuration", "resolved alert on"},
	"device.deleted":               {"configuration", "deleted"},
	"access_window.opened":         {"configuration", "opened an access window on"},
	"access_window.closed":         {"configuration", "closed the access window on"},
	"id_allow_list.updated":        {"configuration", "updated the ID allow list for"},
	"auth.login":                   {"authentication", "signed in"},
	"auth.login_failed":            {"authentication", "failed sign-in"},
	"auth.logout":                  {"authentication", "signed out"},
	"auth.mfa_passed":              {"authentication", "passed two-factor verification"},
	"auth.password_changed":        {"authentication", "changed password"},
	"auth.totp_enrolled":           {"authentication", "enrolled two-factor authenticator"},
	"setup.owner_created":          {"iam", "created the owner account"},
	"setup.server_saved":           {"configuration", "saved server setup configuration"},
	"setup.completed":              {"configuration", "finished first-run setup"},
	"group.created":                {"configuration", "created group"},
	"group.renamed":                {"configuration", "renamed group"},
	"group.moved":                  {"configuration", "moved group"},
	"group.deleted":                {"configuration", "deleted group"},
	"group.updated":                {"configuration", "updated group"},
	"group.policy_changed":         {"configuration", "changed the policy of group"},
	"tag.created":                  {"configuration", "created tag"},
	"tag.updated":                  {"configuration", "updated tag"},
	"tag.deleted":                  {"configuration", "deleted tag"},
	"user.created":                 {"iam", "created user"},
	"user.updated":                 {"iam", "updated user"},
	"user.oidc_linked":             {"iam", "linked user to the sign-in provider"},
	"user.oidc_unlinked":           {"iam", "unlinked user from the sign-in provider"},
	"user.totp_reset":              {"iam", "reset two-factor authentication for user"},
	"user.totp_reset_cli":          {"iam", "reset two-factor authentication via CLI for user"},
	"user.unlocked_cli":            {"iam", "unlocked user via CLI"},
	"user.deleted":                 {"iam", "deleted user"},
	"user.grants_updated":          {"iam", "changed user grants for"},
	"user.password_reset":          {"iam", "reset password for user"},
	"server.updated":               {"configuration", "updated server configuration"},
	"settings.dashboard_updated":   {"configuration", "updated dashboard settings"},
	"settings.server_updated":      {"configuration", "updated server settings"},
	"settings.oidc_updated":        {"configuration", "changed the sign-in settings"},
	"settings.log_export_updated":  {"configuration", "changed the log export settings"},
	"ferricade.test":               {"configuration", "sent a log export test event"},
	"policy.created":               {"configuration", "created policy"},
	"policy.updated":               {"configuration", "updated policy"},
	"policy.deleted":               {"configuration", "deleted policy"},
	"policy_push.enabled":          {"configuration", "turned on policy push"},
	"session_lifetime.changed":     {"configuration", "changed sign-in duration"},
	"policy_push.disabled":         {"configuration", "turned off policy push"},
	"deployment.password_removed":  {"configuration", "removed deployment password"},
	"deployment.password_set":      {"configuration", "set deployment password"},
	"deployment.pin_removed":       {"configuration", "removed deployment PIN"},
	"deployment.pin_set":           {"configuration", "set deployment PIN"},
	"deployment.profile_updated":   {"configuration", "updated deployment profile"},
	"deployment.script_downloaded": {"configuration", "downloaded deployment script"},
	"session.started":              {"session", "started remote session"},
	"session.updated":              {"session", "updated remote session"},
	"session.ended":                {"session", "ended remote session"},
	"session.disconnect_requested": {"session", "requested remote session disconnect for"},

	"device.login_locked_out":          {"configuration", "reported a RustDesk failed-sign-in lockout on"},
	"device.login_locked_out_repeated": {"configuration", "summarized repeated RustDesk failed-sign-in lockouts on"},
}

func Known(action string) bool { _, ok := descriptions[action]; return ok }

func Category(action string) string {
	if d, ok := descriptions[action]; ok {
		return d.category
	}
	return "configuration"
}

func Sentence(action string, ev AuditView) string {
	if action == "auth.login_failed" {
		name, _ := ev.Details["username"].(string)
		msg := "Sign-in failed"
		if name != "" {
			msg += " for " + name
		}
		if ev.IP != "" {
			msg += " from " + ev.IP
		}
		return msg
	}
	actor := ev.ActorName
	role := strings.Title(ev.ActorRole)
	if ev.System || actor == "" {
		actor, role = "ferricade", "system"
	}
	phrase := action
	if d, ok := descriptions[action]; ok {
		phrase = d.phrase
	}
	msg := fmt.Sprintf("%s (%s) %s", actor, role, phrase)
	if action == "devices.auto_sorted" {
		// Details read from JSON use float64; direct callers may use integers.
		number := func(key string) string {
			if n := ev.Details[key]; n != nil {
				return fmt.Sprint(n)
			}
			return "0"
		}
		msg += fmt.Sprintf(": %s moved, %s conflicts, %s resolved, %s unchanged", number("moved"), number("conflicts"), number("resolved"), number("unchanged"))
	}
	if action == "group.rule_added" || action == "group.rule_removed" {
		pattern, _ := ev.Details["pattern"].(string)
		preposition := "to"
		if action == "group.rule_removed" {
			preposition = "from"
		}
		msg += " " + pattern + " " + preposition
	}
	if ev.TargetName != "" {
		msg += " " + ev.TargetName
		if ev.RustdeskID != "" {
			msg += " (" + ev.RustdeskID + ")"
		}
	} else if ev.RustdeskID != "" {
		msg += " " + ev.RustdeskID
	}
	if ev.IP != "" {
		msg += " from " + ev.IP
	}
	return msg
}
