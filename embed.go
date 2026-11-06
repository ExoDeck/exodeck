package main

import (
	"embed"
)

//go:embed frontend
var FrontendFS embed.FS

//go:embed docs
var DocsFS embed.FS
