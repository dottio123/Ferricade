package stats

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dottio123/ferricade/internal/store/db"
)

// maxAttention caps the attention list.
const maxAttention = 50

// Attention kinds, in the order the list is sorted by.
const (
	KindUUIDMismatch            = "uuid_mismatch"
	KindAccessWindowUnconfirmed = "access_window_unconfirmed"
	KindGroupConflict           = "group_conflict"
	KindPendingLong             = "pending_long"
	KindOfflineLong             = "offline_long"
	KindOutdatedClient          = "outdated_client"
)

var kindOrder = map[string]int{KindUUIDMismatch: 0, KindAccessWindowUnconfirmed: 1, KindGroupConflict: 2, KindPendingLong: 3, KindOfflineLong: 4, KindOutdatedClient: 5}

// UnknownVersion is how devices that never reported a client version are listed.
const UnknownVersion = "unknown"

// UngroupedName names the entry for approved devices without a group.
const UngroupedName = "Ungrouped"

// DeviceCounts count devices by state; Online counts approved devices only.
type DeviceCounts struct {
	Approved, Pending, Rejected, Archived, Online int
}

type OSCount struct {
	Name  string
	Count int
}

type VersionCount struct {
	Version  string
	Count    int
	Outdated bool
}

// GroupCount counts the approved devices of a group; ID is nil for Ungrouped.
type GroupCount struct {
	ID            *uuid.UUID
	Name          string
	Online, Total int
}

// Attention is one thing the owner should look at.
type Attention struct {
	Kind       string
	DeviceID   uuid.UUID
	RustdeskID string
	Name       string
	Since      time.Time
	Detail     string
}

// SummaryResult is everything the dashboard's command center shows.
type SummaryResult struct {
	GeneratedAt    time.Time
	Devices        DeviceCounts
	ActiveSessions int // open sessions of approved devices
	OpenAlerts     int
	OS             []OSCount      // approved devices, most devices first; never nil
	Versions       []VersionCount // approved devices, newest first; never nil
	Groups         []GroupCount   // approved devices, by name, Ungrouped last; never nil
	Attention      []Attention    // never nil
}

var linuxDistributions = map[string]string{
	"ubuntu": "Ubuntu", "debian": "Debian", "fedora": "Fedora", "centos": "CentOS", "rhel": "RHEL",
	"rocky": "Rocky Linux", "almalinux": "AlmaLinux", "arch": "Arch Linux", "manjaro": "Manjaro",
	"linuxmint": "Linux Mint", "opensuse": "openSUSE", "opensuse-leap": "openSUSE", "opensuse-tumbleweed": "openSUSE",
	"sles": "SLES", "pop": "Pop!_OS", "elementary": "elementary OS", "kali": "Kali Linux",
	"raspbian": "Raspberry Pi OS", "alpine": "Alpine Linux", "nixos": "NixOS", "gentoo": "Gentoo",
	"zorin": "Zorin OS", "endeavouros": "EndeavourOS", "deepin": "deepin", "kylin": "Kylin", "uos": "UOS",
}

// osName maps the text of devices.os before " / " to a display name.
func osName(raw string) string {
	name, _, _ := strings.Cut(raw, " / ")
	id := strings.ToLower(strings.TrimSpace(name))
	switch id {
	case "windows":
		return "Windows"
	case "linux":
		return "Linux"
	case "macos":
		return "macOS"
	case "android":
		return "Android"
	}
	if id == "" || id == "unknown" {
		return "Other"
	}
	if distro, ok := linuxDistributions[id]; ok {
		return distro
	}
	runes := []rune(id)
	return strings.ToUpper(string(runes[0])) + string(runes[1:])
}

// CompareVersions compares dotted numeric versions part by part. A missing
// part, and a part that is not a number, counts as 0.
func CompareVersions(a, b string) int {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := range max(len(pa), len(pb)) {
		if c := cmp.Compare(versionPart(pa, i), versionPart(pb, i)); c != 0 {
			return c
		}
	}
	return 0
}

func versionPart(parts []string, i int) int {
	if i >= len(parts) {
		return 0
	}
	n, err := strconv.Atoi(parts[i])
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// deviceName is what the console calls a device: its alias, else its
// hostname, else its RustDesk ID.
func deviceName(alias, hostname, rustdeskID string) string {
	switch {
	case alias != "":
		return alias
	case hostname != "":
		return hostname
	}
	return rustdeskID
}

// Summary computes the dashboard summary at now. online reports whether an
// approved device is online (devices.Tracker.Online); nil means none is.
func Summary(ctx context.Context, pool *pgxpool.Pool, online func(rustdeskID string) bool, now time.Time, scope ...*uuid.UUID) (SummaryResult, error) {
	var scopeUser *uuid.UUID
	if len(scope) > 0 {
		scopeUser = scope[0]
	}
	q := db.New(pool)
	th, err := LoadThresholds(ctx, q)
	if err != nil {
		return SummaryResult{}, err
	}
	devs, err := q.SummaryDevices(ctx, scopeUser)
	if err != nil {
		return SummaryResult{}, fmt.Errorf("stats: summary devices: %w", err)
	}
	groupRows, err := q.SummaryGroups(ctx, scopeUser)
	if err != nil {
		return SummaryResult{}, fmt.Errorf("stats: summary groups: %w", err)
	}
	alerts, err := q.SummaryOpenPolicyAlerts(ctx, scopeUser)
	if err != nil {
		return SummaryResult{}, fmt.Errorf("stats: summary alerts: %w", err)
	}
	sessions, err := q.CountOpenSessionsOfAllApproved(ctx, scopeUser)
	if err != nil {
		return SummaryResult{}, fmt.Errorf("stats: summary sessions: %w", err)
	}

	res := SummaryResult{
		GeneratedAt: now, ActiveSessions: int(sessions), OpenAlerts: len(alerts),
		OS: []OSCount{}, Versions: []VersionCount{}, Groups: []GroupCount{}, Attention: []Attention{},
	}
	var att []Attention
	for _, a := range alerts {
		kind, detail := KindUUIDMismatch, "A client with a different UUID is using this ID"
		if a.Kind == KindAccessWindowUnconfirmed {
			kind, detail = KindAccessWindowUnconfirmed, "Access window close is not confirmed by the device"
		}
		if a.Kind == KindGroupConflict {
			kind, detail = KindGroupConflict, a.GroupNames
		}
		att = append(att, Attention{
			Kind: kind, DeviceID: a.DeviceID, RustdeskID: a.RustdeskID,
			Name: deviceName(a.Alias, a.Hostname, a.RustdeskID), Since: a.CreatedAt,
			Detail: detail,
		})
	}

	osCount := map[string]int{}
	verCount := map[string]int{}
	type tally struct{ online, total int }
	groupTallies := map[uuid.UUID]*tally{}
	var ungrouped tally
	pendingAfter := time.Duration(th.PendingHours) * time.Hour
	offlineAfter := time.Duration(th.OfflineDays) * 24 * time.Hour

	for _, d := range devs {
		name := deviceName(d.Alias, d.Hostname, d.RustdeskID)
		switch d.State {
		case "pending":
			res.Devices.Pending++
			if now.Sub(d.FirstSeenAt) > pendingAfter {
				att = append(att, Attention{
					Kind: KindPendingLong, DeviceID: d.ID, RustdeskID: d.RustdeskID, Name: name, Since: d.FirstSeenAt,
					Detail: fmt.Sprintf("Waiting for approval for over %d hours", th.PendingHours),
				})
			}
			continue
		case "rejected":
			res.Devices.Rejected++
			continue
		case "archived":
			res.Devices.Archived++
			continue
		}

		res.Devices.Approved++
		isOnline := online != nil && online(d.RustdeskID)
		if isOnline {
			res.Devices.Online++
		}
		osCount[osName(d.OS)]++
		ver := d.ClientVersion
		if ver == "" {
			ver = UnknownVersion
		}
		verCount[ver]++
		t := &ungrouped
		if d.GroupID != nil {
			if groupTallies[*d.GroupID] == nil {
				groupTallies[*d.GroupID] = &tally{}
			}
			t = groupTallies[*d.GroupID]
		}
		t.total++
		if isOnline {
			t.online++
		}
		if !isOnline && now.Sub(d.LastSeenAt) > offlineAfter {
			att = append(att, Attention{
				Kind: KindOfflineLong, DeviceID: d.ID, RustdeskID: d.RustdeskID, Name: name, Since: d.LastSeenAt,
				Detail: fmt.Sprintf("Not seen for over %d days", th.OfflineDays),
			})
		}
		// A device that never reported a version is not called outdated.
		if th.MinClientVersion != "" && d.ClientVersion != "" && CompareVersions(d.ClientVersion, th.MinClientVersion) < 0 {
			att = append(att, Attention{
				// Nothing marks when a client became outdated; the age of the device stands in.
				Kind: KindOutdatedClient, DeviceID: d.ID, RustdeskID: d.RustdeskID, Name: name, Since: d.FirstSeenAt,
				Detail: fmt.Sprintf("Client %s is older than %s", d.ClientVersion, th.MinClientVersion),
			})
		}
	}

	for name, count := range osCount {
		res.OS = append(res.OS, OSCount{Name: name, Count: count})
	}
	slices.SortFunc(res.OS, func(a, b OSCount) int {
		if (a.Name == "Other") != (b.Name == "Other") {
			if a.Name == "Other" {
				return 1
			}
			return -1
		}
		return cmp.Or(cmp.Compare(b.Count, a.Count), strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)), strings.Compare(a.Name, b.Name))
	})
	for v, n := range verCount {
		outdated := th.MinClientVersion != "" && v != UnknownVersion && CompareVersions(v, th.MinClientVersion) < 0
		res.Versions = append(res.Versions, VersionCount{Version: v, Count: n, Outdated: outdated})
	}
	slices.SortFunc(res.Versions, func(a, b VersionCount) int {
		if au, bu := a.Version == UnknownVersion, b.Version == UnknownVersion; au != bu {
			if au {
				return 1
			}
			return -1
		}
		return cmp.Or(CompareVersions(b.Version, a.Version), cmp.Compare(a.Version, b.Version))
	})

	for _, g := range groupRows {
		id := g.ID
		gc := GroupCount{ID: &id, Name: g.Name}
		if t := groupTallies[g.ID]; t != nil {
			gc.Online, gc.Total = t.online, t.total
		}
		res.Groups = append(res.Groups, gc)
	}
	slices.SortFunc(res.Groups, func(a, b GroupCount) int {
		return cmp.Or(cmp.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)), cmp.Compare(a.Name, b.Name))
	})
	if ungrouped.total > 0 {
		res.Groups = append(res.Groups, GroupCount{Name: UngroupedName, Online: ungrouped.online, Total: ungrouped.total})
	}

	slices.SortFunc(att, func(a, b Attention) int {
		return cmp.Or(
			cmp.Compare(kindOrder[a.Kind], kindOrder[b.Kind]),
			a.Since.Compare(b.Since),
			cmp.Compare(a.RustdeskID, b.RustdeskID),
		)
	})
	res.Attention = append(res.Attention, att[:min(len(att), maxAttention)]...)
	return res, nil
}
