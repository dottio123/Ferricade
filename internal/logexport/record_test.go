package logexport

import (
	"testing"
	"time"

	"github.com/dottio123/ferricade/internal/buildinfo"
	"github.com/dottio123/ferricade/internal/store/db"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestRecordSessionEnded(t *testing.T) {
	start := time.Date(2026, 10, 21, 14, 3, 12, 481000000, time.UTC)
	end := start.Add(12*time.Minute + 45*time.Second)
	reason := "closed"
	row := db.GetLogExportSessionRow{ID: uuid.New(), DeviceID: uuid.New(), PeerName: "bob-laptop", PeerRustdeskID: "987654321", Alias: "Front Desk PC", RustdeskID: "123456789", StartedAt: start, EndedAt: &end, EndReason: &reason}
	rec := sessionRecord(row, "end", "ferricade.example.com")
	require.Equal(t, "Remote session ended: bob-laptop (987654321) to Front Desk PC (123456789) after 12 min (closed)", rec.Message)
	require.Equal(t, end.Format("2006-01-02T15:04:05.000Z"), rec.Timestamp)
	require.Equal(t, int64(765), *rec.Ferricade.Session.DurationSeconds)
	require.Equal(t, "closed", rec.Ferricade.Session.EndReason)
	startRec := sessionRecord(row, "start", "ferricade.example.com")
	require.Equal(t, "Remote session started: bob-laptop (987654321) to Front Desk PC (123456789)", startRec.Message)
	require.Nil(t, startRec.Ferricade.Session.DurationSeconds)
	short := start.Add(45 * time.Second)
	row.EndedAt = &short
	require.Equal(t, "Remote session ended: bob-laptop (987654321) to Front Desk PC (123456789) after 45 s (closed)", sessionRecord(row, "end", "ferricade.example.com").Message)
}

func TestObserverUsesBuildInfo(t *testing.T) {
	orig := buildinfo.Version
	t.Cleanup(func() { buildinfo.Version = orig })

	buildinfo.Version = ""
	obs := observer("ferricade.example.com")
	require.Equal(t, "ferricade", obs.Product)
	require.Equal(t, "ferricade.example.com", obs.Hostname)
	require.Equal(t, "dev", obs.Version)

	buildinfo.Version = "9.9.9"
	require.Equal(t, "9.9.9", observer("ferricade.example.com").Version)
}

func TestLockoutAuditRecordsExportAsFailures(t *testing.T) {
	for _, action := range []string{"device.login_locked_out", "device.login_locked_out_repeated"} {
		t.Run(action, func(t *testing.T) {
			rec, err := buildAuditRecord(db.GetLogExportAuditRow{
				ID: uuid.New(), At: time.Date(2026, 11, 18, 0, 0, 0, 0, time.UTC),
				Action: action, TargetType: "device", TargetID: uuid.NewString(), Details: []byte(`{}`),
			}, "ferricade.example", "", "")
			require.NoError(t, err)
			require.Equal(t, "failure", rec.Event.Outcome)
		})
	}
}
