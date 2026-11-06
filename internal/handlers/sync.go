package handlers

import (
	"bytes"
	"context"
	"net/http"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// GitRunner is an interface allowing tests to inject a mock git executor.
type GitRunner interface {
	Run(ctx context.Context, cwd string, args ...string) (rc int, stdout, stderr string)
}

// RealGitRunner executes git via exec.Command.
type RealGitRunner struct{}

func (RealGitRunner) Run(ctx context.Context, cwd string, args ...string) (int, string, string) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = cwd
	if runtime.GOOS == "windows" {
		cmd.SysProcAttr = hiddenWindowSysProcAttr()
	}
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	err := cmd.Run()
	rc := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			rc = exitErr.ExitCode()
		} else {
			rc = 1
		}
	}
	return rc, outBuf.String(), errBuf.String()
}

func (s *Server) syncStatusForLocation(ctx context.Context, location string, runner GitRunner) (map[string]interface{}, int, string) {
	if !s.isSyncEnabled() {
		return map[string]interface{}{"enabled": false}, 0, ""
	}

	name, dataDir, httpStatus, errMsg := s.Store.ResolveWorkspace(location)
	if httpStatus != 0 {
		return nil, httpStatus, errMsg
	}
	if name == "docs" {
		return map[string]interface{}{"enabled": false}, 0, ""
	}

	rc, toplevel, _ := runner.Run(ctx, dataDir, "rev-parse", "--show-toplevel")
	if rc != 0 {
		return map[string]interface{}{"enabled": false, "error": "Not a git repository"}, 0, ""
	}

	toplevelPath, _ := filepath.Abs(strings.TrimSpace(toplevel))
	dataDirPath, _ := filepath.Abs(dataDir)

	if !strings.EqualFold(toplevelPath, dataDirPath) {
		return map[string]interface{}{"enabled": false, "error": "Not the root of a git repository"}, 0, ""
	}

	_, stdout, _ := runner.Run(ctx, dataDir, "status", "-s")
	return map[string]interface{}{
		"enabled":     true,
		"uncommitted": strings.TrimSpace(stdout) != "",
		"output":      strings.TrimSpace(stdout),
	}, 0, ""
}

func (s *Server) isSyncEnabled() bool {
	cfg, err := loadConfigFromDir(s.ConfigDir)
	if err != nil {
		return false
	}
	return cfg.EnableGitSync
}

func (s *Server) getGitRunner() GitRunner {
	if s.GitRunner != nil {
		return s.GitRunner
	}
	return RealGitRunner{}
}

func (s *Server) syncStatusAll(w http.ResponseWriter, r *http.Request) {
	runner := s.getGitRunner()
	names := s.Store.WorkspaceNames()
	result := map[string]interface{}{}
	for _, name := range names {
		status, httpStatus, errMsg := s.syncStatusForLocation(r.Context(), name, runner)
		if httpStatus != 0 {
			jsonError(w, httpStatus, errMsg)
			return
		}
		result[name] = status
	}
	jsonOK(w, result)
}

func (s *Server) syncStatus(w http.ResponseWriter, r *http.Request) {
	location := r.URL.Query().Get("location")
	runner := s.getGitRunner()
	status, httpStatus, errMsg := s.syncStatusForLocation(r.Context(), location, runner)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	jsonOK(w, status)
}

func (s *Server) syncData(w http.ResponseWriter, r *http.Request) {
	if !s.isSyncEnabled() {
		jsonError(w, 403, "Git sync is disabled")
		return
	}

	location := r.URL.Query().Get("location")
	workspaceName, dataDir, httpStatus, errMsg := s.Store.ResolveWorkspace(location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	if workspaceName == "docs" {
		jsonError(w, 403, "Git sync is disabled for docs workspace")
		return
	}

	runner := s.getGitRunner()
	ctx := r.Context()

	rc, toplevel, _ := runner.Run(ctx, dataDir, "rev-parse", "--show-toplevel")
	if rc != 0 {
		jsonError(w, 400, "Location is not a Git repository")
		return
	}
	toplevelPath, _ := filepath.Abs(strings.TrimSpace(toplevel))
	dataDirPath, _ := filepath.Abs(dataDir)
	if !strings.EqualFold(toplevelPath, dataDirPath) {
		jsonError(w, 400, "Location is not the root of a Git repository")
		return
	}

	commands := [][]string{
		{"add", "."},
		{"commit", "-m", "Auto-sync from StartGRD"},
		{"pull", "--rebase"},
		{"push"},
	}

	var logs []string
	for _, args := range commands {
		rc, stdout, stderr := runner.Run(ctx, dataDir, args...)
		logs = append(logs, "$ git "+strings.Join(args, " ")+"\n"+stdout+stderr)
		if rc != 0 {
			if args[0] == "commit" && (strings.Contains(stdout, "nothing to commit") || strings.Contains(stdout, "nothing added to commit")) {
				continue
			}
			detail := stderr
			if detail == "" {
				detail = stdout
			}
			jsonError(w, 500, "Git command failed: git "+strings.Join(args, " ")+"\n"+detail)
			return
		}
	}

	s.Store.ReloadCacheForWorkspace(workspaceName)
	jsonOK(w, map[string]interface{}{
		"status": "success",
		"log":    strings.Join(logs, "\n"),
	})
}
