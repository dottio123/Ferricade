package auth

import "time"

// SessionLifetime returns the absolute lifetime and strictness rank. Browser
// sessions rank below every persistent option despite their seven-day cap.
func SessionLifetime(lifetime string) (duration time.Duration, rank int, ok bool) {
	switch lifetime {
	case "browser":
		return SessionMaxAge, 0, true
	case "8h":
		return 8 * time.Hour, 1, true
	case "1d":
		return 24 * time.Hour, 2, true
	case "7d":
		return 7 * 24 * time.Hour, 3, true
	case "30d":
		return 30 * 24 * time.Hour, 4, true
	default:
		return 0, 0, false
	}
}
