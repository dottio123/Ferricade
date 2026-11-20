package recorder

import (
	"bytes"
	"encoding/json"
	"strings"
)

const redacted = "[redacted]"

// secretKeys are JSON keys whose values never reach a capture file.
var secretKeys = map[string]bool{
	"password":                     true,
	"address_book_password":        true,
	"preset-address-book-password": true,
	"secret":                       true,
	"tfaCode":                      true,
	"verificationCode":             true,
	"access_token":                 true,
	"hash":                         true, // address book peer password hash: password-equivalent
}

// Redact replaces the values of secret keys anywhere in a JSON document,
// including inside string values that hold JSON text (the address book's
// "data", audit "info"). Numbers keep their exact text. Input that is not
// JSON is returned unchanged.
func Redact(body []byte) []byte {
	v, ok := decode(body)
	if !ok {
		return body
	}
	out, err := json.Marshal(redact(v))
	if err != nil {
		return body
	}
	return out
}

func decode(b []byte) (any, bool) {
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var v any
	if d.Decode(&v) != nil || d.More() {
		return nil, false
	}
	return v, true
}

func redact(v any) any {
	switch t := v.(type) {
	case map[string]any:
		for k, child := range t {
			if secretKeys[k] {
				t[k] = redacted
			} else {
				t[k] = redact(child)
			}
		}
	case []any:
		for i, child := range t {
			t[i] = redact(child)
		}
	case string:
		// JSON text nested in a string is redacted too and stays a string.
		if s := strings.TrimSpace(t); strings.HasPrefix(s, "{") || strings.HasPrefix(s, "[") {
			if inner, ok := decode([]byte(s)); ok {
				if b, err := json.Marshal(redact(inner)); err == nil {
					return string(b)
				}
			}
		}
	}
	return v
}
