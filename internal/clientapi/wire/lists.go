package wire

// Page is the paged list shape; the client sends ?current=<1-based>&pageSize=100
// and keeps fetching while current*pageSize < total.
type Page[T any] struct {
	Total int `json:"total"`
	Data  []T `json:"data"`
}

// PeerPayload is an item of GET /api/peers.
type PeerPayload struct {
	ID              string   `json:"id"`
	Info            PeerInfo `json:"info"`
	Status          int      `json:"status"`
	User            string   `json:"user"`
	UserName        string   `json:"user_name"`
	DeviceGroupName string   `json:"device_group_name"`
	Note            string   `json:"note"`
}

// PeerInfo: the client reads the hostname from device_name, not hostname.
type PeerInfo struct {
	Username   string `json:"username"`
	OS         string `json:"os"`
	DeviceName string `json:"device_name"`
}

// DeviceGroupPayload is an item of GET /api/device-group/accessible.
type DeviceGroupPayload struct {
	Name string `json:"name"`
}
