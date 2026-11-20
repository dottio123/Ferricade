package deploy

import "strings"

var psSingleQuotes = strings.NewReplacer("'", "''", "‘", "‘‘", "’", "’’", "‚", "‚‚", "‛", "‛‛")

func QuotePS(s string) string { return "'" + psSingleQuotes.Replace(s) + "'" }

func QuoteSH(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'" }
