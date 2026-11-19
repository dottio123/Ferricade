// Package wire holds the JSON payloads of the RustDesk client API, as sent
// and expected by RustDesk 1.5.0. Field names are the client's wire names;
// see testdata/contracts/derived-1.5.0 for the source reference of each.
//
// Decoding must stay lenient: newer clients add fields, and an unknown key
// is never an error.
package wire
