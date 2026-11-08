package main

// Version is set at build time via -ldflags "-X main.Version=<ver>".
// Falls back to "1.1.1" when built without the flag (e.g. `go run .`).
var Version = "1.1.1"
