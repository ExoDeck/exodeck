package handlers

import (
	"io/fs"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/ExoDeck/exodeck/internal/mcp"
	"github.com/ExoDeck/exodeck/internal/storage"
	"github.com/ExoDeck/exodeck/internal/vault"
)

// Server holds shared dependencies injected into every handler.
type Server struct {
	Store      *storage.Store
	Vault      *vault.Manager
	ConfigDir  string // path to directory containing config.json
	FrontendFS fs.FS  // embedded or disk frontend filesystem
	GitRunner  GitRunner
}

const (
	routePageSlug       = "/pages/{slug}"
	routeNoteSlug       = "/notes/{slug}"
	routeWhiteboardSlug = "/whiteboards/{slug}"
	routeBpmnSlug       = "/bpmn/{slug}"
)

// NewRouter creates and returns the fully configured chi router.
func NewRouter(s *Server) http.Handler {
	if s.Vault == nil {
		s.Vault = vault.New(15 * time.Minute)
	}

	r := chi.NewRouter()

	// CORS — allow all origins (same as Python backend)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"*"},
		AllowCredentials: false,
	}))

	r.Use(middleware.Recoverer)

	// No-cache headers for all non-API responses
	r.Use(noCacheStaticMiddleware)

	// API routes
	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/bootstrap", s.bootstrap)
		r.Get("/search", s.searchItems)
		r.Get("/tasks/due", s.getDueTasks)
		r.Get("/tasks", s.getAllTasks)
		r.Get("/locations", s.listLocations)
		r.Post("/locations/icon", s.uploadLocationIcon)
		r.Delete("/locations/icon", s.deleteLocationIcon)

		// Vault
		r.Get("/workspaces/{name}/vault/status", s.getVaultStatus)
		r.Post("/workspaces/{name}/vault/setup", s.setupVault)
		r.Post("/workspaces/{name}/vault/unlock", s.unlockVault)
		r.Post("/workspaces/{name}/vault/lock", s.lockVault)
		r.Post("/workspaces/{name}/vault/change-password", s.changeVaultPassword)
		r.Post("/workspaces/{name}/vault/migrate-fernet", s.migrateFernet)

		// Pages
		r.Get("/pages", s.listPages)
		r.Post("/pages", s.createPage)
		r.Get(routePageSlug, s.getPage)
		r.Put(routePageSlug, s.updatePage)
		r.Delete(routePageSlug, s.deletePage)
		r.Post(routePageSlug+"/move-to", s.movePageToLocation)

		// Groups
		r.Post("/pages/{slug}/groups", s.addGroup)
		r.Put("/pages/{slug}/groups/{groupIndex}", s.updateGroup)
		r.Delete("/pages/{slug}/groups/{groupIndex}", s.deleteGroup)
		r.Post("/pages/{slug}/groups/{groupIndex}/move", s.moveGroup)

		// Items
		r.Post("/pages/{slug}/groups/{groupIndex}/items", s.addItem)
		r.Put("/pages/{slug}/groups/{groupIndex}/items/{itemIndex}", s.updateItem)
		r.Delete("/pages/{slug}/groups/{groupIndex}/items/{itemIndex}", s.deleteItem)
		r.Post("/pages/{slug}/groups/{groupIndex}/items/{itemIndex}/move", s.moveItem)
		r.Get("/pages/{slug}/groups/{groupIndex}/items/{itemIndex}/otp", s.getOTP)

		// Media
		r.Get("/media/*", s.serveMedia)
		r.Post("/pages/{slug}/media", s.uploadMedia)
		r.Get("/pages/{slug}/media", s.listMedia)
		r.Delete("/pages/{slug}/media/{filename}", s.deleteMedia)

		// Note pages
		r.Post("/notes", s.createNote)
		r.Get(routeNoteSlug, s.getNote)
		r.Put(routeNoteSlug, s.updateNote)
		r.Delete(routeNoteSlug, s.deleteNote)
		r.Post(routeNoteSlug+"/move-to", s.moveNoteToLocation)

		// Whiteboard pages
		r.Post("/whiteboards", s.createWhiteboard)
		r.Get(routeWhiteboardSlug, s.getWhiteboard)
		r.Put(routeWhiteboardSlug, s.updateWhiteboard)
		r.Delete(routeWhiteboardSlug, s.deleteWhiteboard)
		r.Post(routeWhiteboardSlug+"/move-to", s.moveWhiteboardToLocation)

		// Business Process (BPMN) pages
		r.Post("/bpmn", s.createBpmn)
		r.Get(routeBpmnSlug, s.getBpmn)
		r.Put(routeBpmnSlug, s.updateBpmn)
		r.Delete(routeBpmnSlug, s.deleteBpmn)
		r.Post(routeBpmnSlug+"/move-to", s.moveBpmnToLocation)

		// Config
		r.Get("/config", s.getConfig)
		r.Put("/config", s.putConfig)

		// Sync
		r.Get("/sync/status/all", s.syncStatusAll)
		r.Get("/sync/status", s.syncStatus)
		r.Post("/sync", s.syncData)

		// MCP Server (also mounted at root /mcp)
		mcpSrv := mcp.NewServer(s.Store, s.ConfigDir, s.getGitRunner(), "")
		r.Handle("/mcp", mcpSrv)
		r.Handle("/mcp/*", mcpSrv)
	})

	// Root MCP Server endpoint (/mcp and /mcp/*)
	mcpSrv := mcp.NewServer(s.Store, s.ConfigDir, s.getGitRunner(), "")
	r.Handle("/mcp", mcpSrv)
	r.Handle("/mcp/*", mcpSrv)

	// Static frontend — SPA fallback: serve index.html for unknown routes
	r.NotFound(s.serveStatic)
	r.Get("/*", s.serveStatic)

	return r
}

// noCacheStaticMiddleware sets no-cache headers on all non-/api/ responses.
// Headers must be set before the next handler writes the status line.
func noCacheStaticMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isAPIPath(r.URL.Path) {
			w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
			w.Header().Set("Pragma", "no-cache")
			w.Header().Set("Expires", "0")
		}
		next.ServeHTTP(w, r)
	})
}

func isAPIPath(path string) bool {
	return strings.HasPrefix(path, "/api") || strings.HasPrefix(path, "/mcp")
}
