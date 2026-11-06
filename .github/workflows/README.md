# GitHub Workflows — ExoDeck

This folder contains two GitHub Actions workflows.

---

## `ci.yml` — Continuous Integration

Runs the full **Go test suite** and linting on every push and pull request to any branch.

| Trigger | Branches |
|---------|----------|
| `push` | all (`**`) |
| `pull_request` | all (`**`) |

---

## `version.yml` — Automatic Semantic Versioning

Bumps the application version on every push to `main` based on commit message prefixes.

### Trigger

| Trigger | Branch |
|---------|--------|
| `push` | `main` only |

The workflow **will not re-trigger itself**: GitHub Actions does not fire workflows from pushes made with `GITHUB_TOKEN`, and an additional `github.actor != 'github-actions[bot]'` guard is in place as a safety net.

---

### Commit Message Conventions

The highest-priority prefix found in the commits since the last tag determines the bump type.

| Prefix | Bump | Example commit |
|--------|------|----------------|
| `major:` | Major (`X.0.0`) | `major: redesign data model` |
| `feat:` | Minor (`0.X.0`) | `feat: add dark-mode toggle` |
| anything else | Patch (`0.0.X`) | `fix: correct sidebar scroll` |

Prefixes are **case-insensitive** (`Feat:`, `FEAT:`, `feat:` all count).  
Conventional Commits scopes are also supported: `feat(sidebar):` counts as `feat`.

> **Priority**: if a batch of commits contains both `feat:` and `fix:` messages, the minor bump wins. `major:` always takes precedence over everything else.

---

### Version Source of Truth

The version is stored as a **git tag** (e.g. `v1.2.3`). The `version.go` file is updated by the workflow to reflect the current version:

```go
var Version = "1.2.3"
```

During builds, the version can be injected via ldflags: `-X main.Version=<version>`, or it will use the value from the file.

---

### Workflow Behaviour

#### First run (no existing `v*.*.*` tag)

1. Sets the initial version to "0.0.0".
2. Updates `version.go` using `.github/scripts/update-version.sh`.
3. Commits `version.go` with message `chore: initialize version to 0.0.0`.
4. Creates and pushes git tag `v0.0.0`.

#### Subsequent runs

1. Finds the latest `v*.*.*` tag.
2. Collects all commit subjects since that tag.
3. Determines the bump type from commit prefixes (see table above).
4. Computes the new version number.
5. Updates `version.go` using `.github/scripts/update-version.sh`.
6. Commits the change as `chore: bump version to X.Y.Z`.
7. Creates tag `vX.Y.Z` and pushes both the commit and the tag.

---

### Manual Version Override

If you need to set a specific version (e.g. after a hotfix), create the tag manually:

```bash
git tag v1.2.3
git push origin v1.2.3
```

The next push to `main` will then bump relative to `v1.2.3`.
