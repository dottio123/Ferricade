// Package grouprules owns hostname patterns and automatic group placement.
package grouprules

import (
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
)

type Rule struct {
	ID      uuid.UUID `json:"id"`
	GroupID uuid.UUID `json:"group_id"`
	Pattern string    `json:"pattern"`
}

func Valid(pattern string) error {
	if len(pattern) < 1 || len(pattern) > 128 {
		return fmt.Errorf("pattern must contain 1 to 128 characters")
	}
	for _, c := range pattern {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.ContainsRune("._-*?", c)) {
			return fmt.Errorf("pattern may contain only A-Z, a-z, 0-9, ., _, -, * and ?")
		}
	}
	return nil
}

func equalASCII(a, b rune) bool {
	if a >= 'A' && a <= 'Z' {
		a += 'a' - 'A'
	}
	if b >= 'A' && b <= 'Z' {
		b += 'a' - 'A'
	}
	return a == b
}

// Match keeps one retry point, at the last star, instead of exploring every
// possible expansion. Literal suffixes are checked first to bound common misses.
func Match(pattern, name string) bool {
	if name == "" || len(name) > 255 {
		return false
	}
	for len(pattern) > 0 && pattern[len(pattern)-1] != '*' {
		p, ps := utf8.DecodeLastRuneInString(pattern)
		if name == "" {
			return false
		}
		n, ns := utf8.DecodeLastRuneInString(name)
		if p != '?' && !equalASCII(p, n) {
			return false
		}
		pattern, name = pattern[:len(pattern)-ps], name[:len(name)-ns]
	}
	pi, ni, star, retry := 0, 0, -1, 0
	for ni < len(name) {
		if pi < len(pattern) && pattern[pi] == '*' {
			star = pi
			pi++
			retry = ni
			continue
		}
		n, ns := utf8.DecodeRuneInString(name[ni:])
		if pi < len(pattern) {
			p, ps := utf8.DecodeRuneInString(pattern[pi:])
			if p == '?' || equalASCII(p, n) {
				pi += ps
				ni += ns
				continue
			}
		}
		if star < 0 {
			return false
		}
		_, step := utf8.DecodeRuneInString(name[retry:])
		retry += step
		ni = retry
		pi = star + 1
	}
	for pi < len(pattern) && pattern[pi] == '*' {
		pi++
	}
	return pi == len(pattern)
}

func Candidates(rules []Rule, hostname string) []uuid.UUID {
	seen := map[uuid.UUID]bool{}
	ids := []uuid.UUID{}
	for _, r := range rules {
		if !seen[r.GroupID] && Match(r.Pattern, hostname) {
			seen[r.GroupID] = true
			ids = append(ids, r.GroupID)
		}
	}
	slices.SortFunc(ids, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	return ids
}
