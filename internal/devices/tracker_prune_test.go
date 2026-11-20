package devices

import (
	"testing"
	"time"
)

func TestSweepPrunesOldOfflineEntries(t *testing.T) {
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	tr := NewTracker(func() time.Time { return now })
	tr.Beat("old", []int32{1})
	tr.mu.Lock()
	delete(tr.dirty, "old") // This entry's heartbeat was already flushed.
	tr.mu.Unlock()
	now = now.Add(entryRetention)
	tr.Beat("fresh", []int32{2})

	tr.Sweep()

	tr.mu.Lock()
	defer tr.mu.Unlock()
	if _, ok := tr.entries["old"]; ok {
		t.Fatal("old offline entry remains after Sweep")
	}
	if _, ok := tr.entries["fresh"]; !ok {
		t.Fatal("fresh entry was pruned")
	}
}
