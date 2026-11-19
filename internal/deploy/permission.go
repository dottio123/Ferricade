package deploy

// IsPermission identifies options checked through Connection::permission in RustDesk 1.5.0.
func IsPermission(key string) bool {
	switch key {
	case "enable-keyboard", "enable-clipboard", "enable-file-transfer", "enable-audio",
		"enable-remote-restart", "enable-record-session", "enable-tunnel",
		"enable-remote-printer", "enable-camera", "enable-terminal",
		"enable-block-input", "enable-privacy-mode":
		return true
	}
	return false
}
