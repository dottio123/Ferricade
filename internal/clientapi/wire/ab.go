package wire

import "encoding/json"

// LegacyAB is the body of GET and POST /api/ab. Data is JSON text of
// LegacyABData. An empty book may be answered with the literal "null".
type LegacyAB struct {
	Data            string `json:"data"`
	LicensedDevices int    `json:"licensed_devices,omitempty"`
}

type LegacyABData struct {
	Tags      []string `json:"tags"`
	Peers     []ABPeer `json:"peers"`
	TagColors string   `json:"tag_colors"` // JSON text of map[tag]ARGB
}

type ABPeer struct {
	ID       string   `json:"id"`
	Username string   `json:"username"`
	Hostname string   `json:"hostname"`
	Platform string   `json:"platform"`
	Alias    string   `json:"alias"`
	Tags     []string `json:"tags"`
	Hash     string   `json:"hash,omitempty"`
}

// Decode parses the nested Data text.
func (a LegacyAB) Decode() (LegacyABData, error) {
	var d LegacyABData
	err := json.Unmarshal([]byte(a.Data), &d)
	return d, err
}

// Colors parses the nested TagColors text; empty text means no colors.
func (d LegacyABData) Colors() (map[string]int64, error) {
	m := map[string]int64{}
	if d.TagColors == "" {
		return m, nil
	}
	err := json.Unmarshal([]byte(d.TagColors), &m)
	return m, err
}
