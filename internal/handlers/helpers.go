package handlers

import (
	"io"

	"github.com/ExoDeck/exodeck/internal/config"
	"github.com/ExoDeck/exodeck/internal/models"
)

// loadConfigFromDir is a thin wrapper so sync.go can call config.Load without
// importing the config package directly (keeping the import graph simple).
func loadConfigFromDir(dir string) (models.ConfigModel, error) {
	return config.Load(dir)
}

func writeRaw(w io.Writer, data []byte) {
	_, _ = w.Write(data)
}

func writeString(w io.Writer, data string) {
	_, _ = io.WriteString(w, data)
}
