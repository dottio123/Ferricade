package events

import (
	"bytes"
	"log/slog"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestMapNotificationUserEvents(t *testing.T) {
	var logs bytes.Buffer
	log := slog.New(slog.NewTextHandler(&logs, nil))
	require.Equal(t, []Event{{Type: "grants.changed", UserID: "alice"}},
		mapNotification(`{"kind":"grants","user_id":"alice"}`, log))
	require.Equal(t, []Event{{Type: TypeAuditCreated, AuditID: "audit", ActorUserID: "alice"}},
		mapNotification(`{"kind":"audit","audit_id":"audit","actor_user_id":"alice"}`, log))
	require.Equal(t, []Event{{Type: TypeAuditCreated, AuditID: "audit"}},
		mapNotification(`{"kind":"audit","audit_id":"audit","actor_user_id":null}`, log))
	// The target type lets a User's stream notice group changes.
	require.Equal(t, []Event{{Type: TypeAuditCreated, AuditID: "audit", TargetType: "group"}},
		mapNotification(`{"kind":"audit","audit_id":"audit","target_type":"group","target_id":"g"}`, log))
	require.Empty(t, mapNotification(`{"kind":"unknown"}`, log))
	require.Contains(t, logs.String(), "notification of unknown kind")
}
