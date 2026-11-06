#!/usr/bin/env python3
"""
Migrate StartGRD grid pages from .json extension to .grid extension.

Reads config.json to discover all workspace directories, inspects inside
each .json file to ensure only valid StartGRD grid pages are renamed, and leaves
other .json files untouched.
"""

import argparse
import json
import os
import sys
from pathlib import Path

CONFIG_FILENAME = "config.json"


def find_config_file(config_arg=None):
    """Locate config.json from CLI argument or search common locations."""
    if config_arg:
        p = Path(config_arg).resolve()
        if p.is_file():
            return p
        if p.is_dir():
            candidate = p / CONFIG_FILENAME
            if candidate.is_file():
                return candidate
        sys.exit(f"Error: Config file not found at '{config_arg}'")

    # Search current directory, script directory, and parent
    candidates = [
        Path.cwd() / CONFIG_FILENAME,
        Path(__file__).resolve().parent / CONFIG_FILENAME,
        Path(__file__).resolve().parent.parent / CONFIG_FILENAME,
    ]
    for c in candidates:
        if c.is_file():
            return c

    sys.exit(f"Error: Could not find {CONFIG_FILENAME}. Use --config <path> to specify its location.")


def _read_config(config_path):
    """Load configuration JSON from the given path."""
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        sys.exit(f"Error reading config file '{config_path}': {e}")


def _resolve_workspace_path(config_dir, path_str):
    """Normalize a workspace path string to an absolute or config_dir-relative Path."""
    if not isinstance(path_str, str):
        return None
    p = path_str.strip()
    if not p:
        return None
    return Path(p) if os.path.isabs(p) else config_dir / p


def _extract_workspace_path(config_dir, ws_entry):
    """Extract and resolve Path from a workspace entry (dict or str)."""
    if isinstance(ws_entry, dict):
        return _resolve_workspace_path(config_dir, ws_entry.get("path"))
    if isinstance(ws_entry, str):
        return _resolve_workspace_path(config_dir, ws_entry)
    return None


def _parse_workspaces(config_dir, workspaces):
    """Extract workspace Path objects from list or dict configuration."""
    entries = []
    if isinstance(workspaces, list):
        entries = workspaces
    elif isinstance(workspaces, dict):
        entries = workspaces.values()

    paths = []
    for ws in entries:
        p = _extract_workspace_path(config_dir, ws)
        if p is not None:
            paths.append(p)
    return paths


def _deduplicate_paths(paths):
    """Preserve order while removing duplicate paths."""
    unique_paths = []
    seen = set()
    for p in paths:
        resolved = p.resolve()
        if resolved not in seen:
            seen.add(resolved)
            unique_paths.append(resolved)
    return unique_paths


def get_workspace_paths(config_path, extra_paths=None):
    """Extract all workspace paths from config.json plus optional extra paths."""
    cfg = _read_config(config_path)
    config_dir = config_path.parent
    paths = _parse_workspaces(config_dir, cfg.get("workspaces"))

    # Always check default data directory in config folder as well
    default_data = config_dir / "data"
    if default_data.is_dir():
        paths.append(default_data)

    if extra_paths:
        for ep in extra_paths:
            paths.append(Path(ep))

    return _deduplicate_paths(paths)


def is_grid_page_file(file_path):
    """
    Inspect the contents of a JSON file to determine if it is a StartGRD grid page.
    A Grid page is a JSON object containing:
      - 'groups': list
      - 'page-name' (or 'page_name'): string
    Returns (is_grid, reason, page_title).
    """
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        return False, f"Not valid JSON ({e})", None

    if not isinstance(data, dict):
        return False, "Not a JSON object", None

    has_page_name = "page-name" in data or "page_name" in data
    has_groups = "groups" in data and isinstance(data["groups"], list)

    page_title = data.get("page-name") or data.get("page_name") or ""

    if has_page_name and has_groups:
        return True, "Valid grid page", page_title

    # Empty / minimal page created with page-name and flags
    if has_page_name and ("hidden" in data or "custom_sort" in data):
        return True, "Valid grid page (minimal)", page_title

    return False, "Does not match grid page structure (missing 'page-name' and 'groups')", None


def _is_candidate_json_file(filename):
    """Determine whether a file is a non-hidden .json candidate (ignoring config.json)."""
    if filename.startswith("."):
        return False
    if filename.lower() == CONFIG_FILENAME:
        return False
    return filename.lower().endswith(".json")


def _rel_path(path, base_dir):
    """Return path relative to base_dir if possible, otherwise original path."""
    try:
        return path.relative_to(base_dir)
    except ValueError:
        return path


def _apply_file_rename(old_path, new_path, rel_old, rel_new, title_info, force):
    """Perform file renaming or overwriting on disk."""
    try:
        if new_path.exists() and force:
            new_path.unlink()
        old_path.rename(new_path)
        print(f"  [RENAME] {rel_old} -> {rel_new}{title_info}")
        return "renamed"
    except Exception as e:
        print(f"  [ERROR] Failed to rename {rel_old}: {e}")
        return "error"


def _process_grid_candidate(old_path, workspace_dir, dry_run, force, verbose):
    """
    Check if a candidate .json file is a grid page and rename it if appropriate.
    Returns outcome status string: 'renamed', 'non_grid', 'skipped', or 'error'.
    """
    rel_old = _rel_path(old_path, workspace_dir)
    is_grid, reason, page_title = is_grid_page_file(old_path)
    if not is_grid:
        if verbose:
            print(f"  [IGNORE] Not a grid page: {rel_old} ({reason})")
        return "non_grid"

    new_path = old_path.with_suffix(".grid")
    rel_new = _rel_path(new_path, workspace_dir)
    title_info = f" (page: '{page_title}')" if page_title else ""

    if new_path.exists() and not force:
        print(f"  [SKIP] Target already exists: {rel_new}{title_info} (use --force to overwrite)")
        return "skipped"

    if dry_run:
        print(f"  [DRY-RUN] Would rename: {rel_old} -> {rel_new}{title_info}")
        return "renamed"

    return _apply_file_rename(old_path, new_path, rel_old, rel_new, title_info, force)


def rename_json_files_in_workspace(workspace_dir, dry_run=False, force=False, verbose=False):
    """
    Scan workspace directory recursively and rename .json files to .grid ONLY
    if their content represents a StartGRD grid page.
    Skips:
      - Dot-files (e.g. .startgrd_vault.json, .startgrd_index.json)
      - Dot-directories (e.g. .git)
      - config.json
      - Any JSON file that is NOT a StartGRD grid page
    """
    if not workspace_dir.is_dir():
        print(f"  [WARN] Directory does not exist: {workspace_dir}")
        return 0, 0, 0, 0

    stats = {"renamed": 0, "non_grid": 0, "skipped": 0, "error": 0}

    for root, dirs, files in os.walk(workspace_dir):
        # Ignore dot-directories in place so os.walk does not descend into them
        dirs[:] = [d for d in dirs if not d.startswith(".")]

        for filename in files:
            if not _is_candidate_json_file(filename):
                continue

            old_path = Path(root) / filename
            status = _process_grid_candidate(old_path, workspace_dir, dry_run, force, verbose)
            stats[status] += 1

    return stats["renamed"], stats["non_grid"], stats["skipped"], stats["error"]


def main():
    parser = argparse.ArgumentParser(
        description="Rename StartGRD JSON grid pages to .grid extension based on config.json workspaces."
    )
    parser.add_argument(
        "--config",
        "-c",
        help=f"Path to {CONFIG_FILENAME} (defaults to searching current/script directory)",
        default=None,
    )
    parser.add_argument(
        "--path",
        "-p",
        action="append",
        dest="extra_paths",
        help="Additional workspace folder path to process (can be specified multiple times)",
    )
    parser.add_argument(
        "--dry-run",
        "-n",
        action="store_true",
        help="Perform a trial run without renaming any files",
    )
    parser.add_argument(
        "--force",
        "-f",
        action="store_true",
        help="Overwrite existing .grid files if they already exist",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Show detailed messages including non-grid JSON files being ignored",
    )

    args = parser.parse_args()

    config_path = find_config_file(args.config)
    print(f"Using config: {config_path}")

    workspaces = get_workspace_paths(config_path, extra_paths=args.extra_paths)
    if not workspaces:
        print("No workspace directories found to process.")
        return

    print(f"Found {len(workspaces)} workspace(s):")
    for ws in workspaces:
        print(f" - {ws}")

    if args.dry_run:
        print("\n=== DRY RUN MODE: No files will be modified ===\n")
    else:
        print("\nStarting renaming...\n")

    total_renamed = 0
    total_non_grid = 0
    total_skipped = 0
    total_errors = 0

    for ws in workspaces:
        print(f"Processing workspace: {ws}")
        renamed, non_grid, skipped, errors = rename_json_files_in_workspace(
            ws, dry_run=args.dry_run, force=args.force, verbose=args.verbose
        )
        total_renamed += renamed
        total_non_grid += non_grid
        total_skipped += skipped
        total_errors += errors

    print("\nSummary:")
    action_word = "Would rename" if args.dry_run else "Renamed"
    print(f"  {action_word}: {total_renamed} grid page(s)")
    print(f"  Ignored non-grid JSON: {total_non_grid} file(s)")
    if total_skipped:
        print(f"  Skipped (already exists): {total_skipped} file(s)")
    if total_errors:
        print(f"  Errors: {total_errors} file(s)")

    if args.dry_run and total_renamed > 0:
        print("\nRun without --dry-run to apply changes.")


if __name__ == "__main__":
    main()
