package wire

import (
	"encoding/json"
	"strings"
)

// HeartbeatRequest is POST /api/heartbeat (src/hbbs_http/sync.rs). Sent every
// 15 s when idle and every 3 s while sessions are open.
type HeartbeatRequest struct {
	ID         string  `json:"id"`
	UUID       string  `json:"uuid"`
	Ver        int64   `json:"ver"`
	Conns      []int32 `json:"conns,omitempty"`
	ModifiedAt int64   `json:"modified_at"`
}

// HeartbeatResponse: the client acts on each key only when present.
type HeartbeatResponse struct {
	Sysinfo    bool      `json:"sysinfo,omitempty"`
	Disconnect []int32   `json:"disconnect,omitempty"`
	ModifiedAt *int64    `json:"modified_at,omitempty"`
	Strategy   *Strategy `json:"strategy,omitempty"`
}

// Strategy overwrites client options; ModifiedAt in the heartbeat versions it.
type Strategy struct {
	ConfigOptions map[string]string `json:"config_options,omitempty"`
	Extra         map[string]string `json:"extra,omitempty"`
}

// SysinfoRequest is POST /api/sysinfo. The reply is plain text.
type SysinfoRequest struct {
	ID       string `json:"id"`
	UUID     string `json:"uuid"`
	Version  string `json:"version"`
	Hostname string `json:"hostname"`
	OS       string `json:"os"`
	CPU      string `json:"cpu"`
	Memory   string `json:"memory"`
	Username string `json:"username"`
	// Presets holds every string-valued "preset-*" key the client sends,
	// except secrets: keys ending in "-password" (in any case), such as
	// preset-address-book-password, are dropped.
	Presets map[string]string `json:"-"`
}

const (
	SysinfoUpdated = "SYSINFO_UPDATED"
	IDNotFound     = "ID_NOT_FOUND"
	presetPrefix   = "preset-"
)

// ParseSysinfo decodes a sysinfo body, collecting "preset-*" keys into
// Presets. Keys ending in "-password" (case-insensitive) are dropped, so a
// preset password is never stored.
func ParseSysinfo(b []byte) (SysinfoRequest, error) {
	var s SysinfoRequest
	if err := json.Unmarshal(b, &s); err != nil {
		return SysinfoRequest{}, err
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(b, &all); err != nil {
		return SysinfoRequest{}, err
	}
	for k, raw := range all {
		if !strings.HasPrefix(k, presetPrefix) || strings.HasSuffix(strings.ToLower(k), "-password") {
			continue
		}
		var v string
		if json.Unmarshal(raw, &v) != nil {
			continue
		}
		if s.Presets == nil {
			s.Presets = map[string]string{}
		}
		s.Presets[k] = v
	}
	return s, nil
}

// DevicesCLIRequest is POST /api/devices/cli, sent by
// `rustdesk --assign --token <t> ...` with the token as a Bearer header.
// An empty response body means success.
type DevicesCLIRequest struct {
	ID                  string `json:"id"`
	UUID                string `json:"uuid"`
	UserName            string `json:"user_name,omitempty"`
	StrategyName        string `json:"strategy_name,omitempty"`
	AddressBookName     string `json:"address_book_name,omitempty"`
	AddressBookTag      string `json:"address_book_tag,omitempty"`
	AddressBookAlias    string `json:"address_book_alias,omitempty"`
	AddressBookPassword string `json:"address_book_password,omitempty"`
	AddressBookNote     string `json:"address_book_note,omitempty"`
	DeviceGroupName     string `json:"device_group_name,omitempty"`
	Note                string `json:"note,omitempty"`
	DeviceUsername      string `json:"device_username,omitempty"`
	DeviceName          string `json:"device_name,omitempty"`
}

// DeviceRef is the body of POST /api/currentUser and /api/logout.
type DeviceRef struct {
	ID   string `json:"id"`
	UUID string `json:"uuid"`
}
