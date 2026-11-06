package main

// Version is set at build time via -ldflags "-X main.Version=<ver>".
// Falls back to "0.41.0" when built without the flag (e.g. `go run .`).
var Version = "0.41.0"
