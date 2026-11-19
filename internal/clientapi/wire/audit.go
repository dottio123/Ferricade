package wire

// ConnAudit is POST /api/audit/conn. One connection posts several records
// sharing conn_id: action "new" (with ip), then one without action carrying
// peer [id, name] and type, then action "close". Nonce is unique per record
// and is how retried posts are deduplicated.
type ConnAudit struct {
	ID           string   `json:"id"`
	UUID         string   `json:"uuid"`
	ConnID       int32    `json:"conn_id"`
	SessionID    uint64   `json:"session_id"`
	Nonce        string   `json:"nonce"`
	Action       string   `json:"action,omitempty"`
	IP           string   `json:"ip,omitempty"`
	Peer         []string `json:"peer,omitempty"`
	Type         *int     `json:"type,omitempty"` // 0 remote, 1 file, 2 port forward, 3 camera, 4 terminal
	PrimaryAuth  *int     `json:"primary_auth,omitempty"`
	TwoFactor    *int     `json:"two_factor,omitempty"`
	ConnAuditRef string   `json:"conn_audit_ref,omitempty"`
}

// FileAudit is POST /api/audit/file. Info is JSON text.
type FileAudit struct {
	ID     string `json:"id"`
	UUID   string `json:"uuid"`
	PeerID string `json:"peer_id"`
	ConnID int32  `json:"conn_id"`
	Type   int    `json:"type"` // 0 remote send, 1 remote receive
	Path   string `json:"path"`
	IsFile bool   `json:"is_file"`
	Info   string `json:"info"`
	Nonce  string `json:"nonce"`
}

// AlarmAudit is POST /api/audit/alarm. Info is JSON text.
type AlarmAudit struct {
	ID           string `json:"id"`
	UUID         string `json:"uuid"`
	Typ          int    `json:"typ"`
	Info         string `json:"info"`
	ConnID       int32  `json:"conn_id"`
	Nonce        string `json:"nonce"`
	ConnAuditRef string `json:"conn_audit_ref,omitempty"`
}

const (
	ConnActionNew   = "new"
	ConnActionClose = "close"
)
