#!/usr/bin/env python3
"""Verified maintenance controller for Orgo AI Guy Bot.

The updater is deliberately conservative: candidate code is tested in an
isolated worktree, the installed app moves only after those checks pass, and
the checked-out main branch moves only after the replacement app is healthy.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import fcntl
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Callable, Sequence
from urllib.parse import urlparse

ORGO_PRODUCT_NAME = "Orgo AI Guy Bot"
ORGO_ORIGIN_URL = "https://github.com/jbellsolutions/orgo-ai-guy-bot.git"
ORGO_UPSTREAM_URL = "https://github.com/nickvasilescu/korgo-bot.git"


class MaintenanceError(RuntimeError):
    """Raised when a maintenance safety invariant is not satisfied."""


class MaintenanceLock:
    """Process lock that rejects overlapping maintenance runs."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._handle = None

    def __enter__(self) -> "MaintenanceLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._handle = self.path.open("a+", encoding="utf-8")
        try:
            fcntl.flock(self._handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            self._handle.close()
            self._handle = None
            raise MaintenanceError("maintenance is already running") from exc
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        if self._handle is not None:
            fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
            self._handle.close()
            self._handle = None


@dataclasses.dataclass(frozen=True)
class RepositoryInspection:
    action: str
    reason: str
    dirty: bool
    branch: str
    head_sha: str
    origin_sha: str
    upstream_sha: str
    upstream_pending: bool


def _run(command: Sequence[str], *, cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    environment = {
        key: value
        for key in ("HOME", "LOGNAME", "TMPDIR", "USER")
        if (value := os.environ.get(key)) is not None
    }
    environment.update(
        {
            "CI": "1",
            "GIT_TERMINAL_PROMPT": "0",
            "HERMES_DESKTOP_PRODUCT": "bot",
            "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        }
    )
    return subprocess.run(
        list(command),
        cwd=cwd,
        check=check,
        capture_output=True,
        text=True,
        env=environment,
    )


def _git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return _run(("git", *args), cwd=repo, check=check)


def _canonical_remote(value: str) -> str:
    candidate = value.strip()
    if candidate.startswith("git@github.com:"):
        candidate = "https://github.com/" + candidate.removeprefix("git@github.com:")
    parsed = urlparse(candidate)
    normalized = f"{parsed.netloc}{parsed.path}" if parsed.netloc else candidate
    return normalized.lower().removesuffix(".git").rstrip("/")


def _is_ancestor(repo: Path, older: str, newer: str) -> bool:
    result = _git(repo, "merge-base", "--is-ancestor", older, newer, check=False)
    return result.returncode == 0


def inspect_repository(repo: Path, *, fetch: bool = True) -> RepositoryInspection:
    repo = Path(repo).expanduser().resolve()
    if not (repo / ".git").exists():
        raise MaintenanceError(f"not a git checkout: {repo}")

    origin_url = _git(repo, "remote", "get-url", "origin").stdout.strip()
    upstream_url = _git(repo, "remote", "get-url", "upstream").stdout.strip()
    if _canonical_remote(origin_url) != _canonical_remote(ORGO_ORIGIN_URL):
        raise MaintenanceError("unexpected origin remote")
    if _canonical_remote(upstream_url) != _canonical_remote(ORGO_UPSTREAM_URL):
        raise MaintenanceError("unexpected upstream remote")

    branch = _git(repo, "branch", "--show-current").stdout.strip()
    dirty = bool(_git(repo, "status", "--porcelain").stdout.strip())
    if dirty:
        return RepositoryInspection("blocked", "dirty-checkout", True, branch, "", "", "", False)
    if branch != "main":
        return RepositoryInspection("blocked", "wrong-branch", False, branch, "", "", "", False)
    if fetch:
        _git(repo, "fetch", "--quiet", "origin", "main")
        _git(repo, "fetch", "--quiet", "upstream", "main")

    head_sha = _git(repo, "rev-parse", "HEAD").stdout.strip()
    origin_sha = _git(repo, "rev-parse", "origin/main").stdout.strip()
    upstream_sha = _git(repo, "rev-parse", "upstream/main").stdout.strip()
    upstream_pending = not _is_ancestor(repo, upstream_sha, head_sha)
    if head_sha != origin_sha and _is_ancestor(repo, head_sha, origin_sha):
        return RepositoryInspection(
            "update",
            "origin-ahead",
            False,
            branch,
            head_sha,
            origin_sha,
            upstream_sha,
            upstream_pending,
        )
    if head_sha != origin_sha:
        return RepositoryInspection(
            "blocked",
            "diverged-from-origin",
            False,
            branch,
            head_sha,
            origin_sha,
            upstream_sha,
            upstream_pending,
        )
    return RepositoryInspection(
        "none",
        "clean-checkout",
        False,
        branch,
        head_sha,
        origin_sha,
        upstream_sha,
        upstream_pending,
    )


def inspect_installed_app(
    repo: Path, inspection: RepositoryInspection, app: Path,
) -> RepositoryInspection:
    """Reconcile a known clean ancestor build even when no git pull is needed.

    Unknown, customized, or newer installations require review; a stamp is
    evidence for reconciliation, never permission to bypass repository gates.
    """
    if inspection.action != "none":
        return inspection
    try:
        stamp = json.loads((app / "Contents/Resources/install-stamp.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        stamp = None
    if (
        not isinstance(stamp, dict)
        or stamp.get("schemaVersion") != 1
        or stamp.get("dirty") is not False
        or not isinstance(stamp.get("commit"), str)
        or not re.fullmatch(r"[0-9a-f]{40}", stamp["commit"])
    ):
        return dataclasses.replace(inspection, action="blocked", reason="installed-stamp-untrusted")
    if stamp["commit"] == inspection.origin_sha:
        return inspection
    if not _is_ancestor(repo, stamp["commit"], inspection.origin_sha):
        return dataclasses.replace(inspection, action="blocked", reason="installed-app-not-ancestor")
    return dataclasses.replace(inspection, action="update", reason="installed-app-behind")


def swap_installed_app(
    candidate: Path,
    installed: Path,
    backup_root: Path,
    *,
    stop_running: Callable[[], None],
    health_check: Callable[[], bool],
    activate_candidate: Callable[[Path, Path], None] | None = None,
    max_backups: int = 3,
) -> Path:
    """Activate a candidate app and restore the prior bundle if unhealthy."""

    candidate = Path(candidate).resolve()
    installed = Path(installed).resolve()
    backup_root = Path(backup_root).resolve()
    if not candidate.is_dir():
        raise MaintenanceError(f"candidate app is missing: {candidate}")
    if not installed.is_dir():
        raise MaintenanceError(f"installed app is missing: {installed}")

    token = uuid.uuid4().hex
    staged = installed.parent / f".{installed.name}.candidate-{token}"
    rollback = installed.parent / f".{installed.name}.rollback-{token}"
    backup = backup_root / f"{installed.stem}-{token}.app"
    installed.parent.mkdir(parents=True, exist_ok=True)
    backup_root.mkdir(parents=True, exist_ok=True)
    shutil.copytree(candidate, staged, symlinks=True)

    original_moved = False
    try:
        stop_running()
        installed.rename(rollback)
        original_moved = True
        (activate_candidate or (lambda source, target: source.rename(target)))(staged, installed)
        if not health_check():
            raise MaintenanceError("candidate app health check failed")
    except BaseException:
        if original_moved:
            if installed.is_dir():
                shutil.rmtree(installed, ignore_errors=True)
            elif installed.exists() or installed.is_symlink():
                installed.unlink(missing_ok=True)
            if rollback.exists():
                rollback.rename(installed)
        if staged.exists():
            shutil.rmtree(staged, ignore_errors=True)
        raise

    rollback.rename(backup)
    updater_backup_name = re.compile(
        rf"^{re.escape(installed.stem)}-[0-9a-f]{{32}}\.app$"
    )
    backups = sorted(
        (
            path
            for path in backup_root.iterdir()
            if updater_backup_name.fullmatch(path.name)
            and path.is_dir()
            and not path.is_symlink()
        ),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for old_backup in backups[max(1, max_backups) :]:
        shutil.rmtree(old_backup)
    return backup


def apply_repository_update(
    repo: Path,
    inspection: RepositoryInspection,
    installed: Path,
    backup_root: Path,
    *,
    build_candidate: Callable[[Path], Path],
    stop_running: Callable[[], None],
    health_check: Callable[[], bool],
) -> None:
    """Build an origin candidate in isolation without moving main early."""

    repo = Path(repo).resolve()
    if inspection.action != "update":
        raise MaintenanceError(f"repository is not eligible for update: {inspection.reason}")

    def check_reconciliation_target() -> None:
        if inspection.reason == "installed-app-behind":
            current = inspect_repository(repo, fetch=False)
            if current.action != "none" or current.head_sha != inspection.origin_sha:
                raise MaintenanceError("repository changed during installed-app reconciliation")

    worktree = Path(tempfile.mkdtemp(prefix="orgo-ai-guy-bot-update-"))
    try:
        shutil.rmtree(worktree)
        _git(repo, "worktree", "add", "--detach", str(worktree), inspection.origin_sha)
        candidate = build_candidate(worktree)
        check_reconciliation_target()
        backup = swap_installed_app(
            candidate,
            installed,
            backup_root,
            stop_running=stop_running,
            health_check=health_check,
        )
        try:
            check_reconciliation_target()
            if inspection.head_sha != inspection.origin_sha:
                _git(repo, "merge", "--ff-only", inspection.origin_sha)
        except BaseException:
            try:
                stop_running()
            except BaseException:
                pass
            failed_candidate = installed.parent / f".{installed.name}.failed-{uuid.uuid4().hex}"
            installed.rename(failed_candidate)
            try:
                backup.rename(installed)
            except BaseException:
                failed_candidate.rename(installed)
                raise
            shutil.rmtree(failed_candidate, ignore_errors=True)
            raise
    finally:
        _git(repo, "worktree", "remove", "--force", str(worktree), check=False)
        shutil.rmtree(worktree, ignore_errors=True)


def candidate_build_commands() -> list[list[str]]:
    """Return the ordered verification gate for an update candidate."""

    return [
        ["npm", "ci"],
        ["npx", "tsc", "-p", "tsconfig.electron.json", "--noEmit"],
        ["npx", "tsc", "-p", "tsconfig.json", "--noEmit"],
        ["npm", "run", "lint"],
        [
            "npx",
            "vitest",
            "run",
            "--project",
            "ui",
            "src/lib/product.test.ts",
            "src/app/bot-product/setup-overlay.test.ts",
            "src/app/right-sidebar/desktop/index.test.tsx",
        ],
        [
            "npx",
            "vitest",
            "run",
            "--project",
            "electron",
            "electron/product.test.ts",
            "electron/bootstrap-runner.test.ts",
            "electron/orgo-desktop.test.ts",
            "electron/legacy-safe-storage-wiring.test.ts",
            "electron/bot-product-build.test.ts",
        ],
        ["npm", "run", "dist:bot:mac:dmg"],
    ]


def production_build_candidate(worktree: Path) -> Path:
    desktop = worktree / "apps/desktop"
    for command in candidate_build_commands():
        _run(command, cwd=desktop)
    candidates = sorted(
        candidate
        for candidate in desktop.glob("release/mac*/Orgo AI Guy Bot.app")
        if candidate.is_dir()
    )
    if len(candidates) != 1:
        raise MaintenanceError(
            f"expected exactly one candidate app, found {len(candidates)}"
        )
    candidate = candidates[0]
    _run(("/usr/bin/codesign", "--verify", "--deep", "--strict", str(candidate)), cwd=desktop)
    return candidate


def stop_installed_app(
    requested_app: Path | None = None,
    *,
    run_command: Callable[..., subprocess.CompletedProcess] = subprocess.run,
    sleep: Callable[[float], None] = time.sleep,
    timeout_seconds: int = 10,
) -> None:
    app = Path(requested_app or "/Applications/Orgo AI Guy Bot.app").resolve()
    process_pattern = str(app / "Contents/MacOS/Orgo AI Guy Bot")
    run_command(
        [
            "/usr/bin/osascript",
            "-e",
            'tell application id "com.nousresearch.hermes-bots" to quit',
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    for _ in range(max(0, timeout_seconds)):
        running = run_command(
            ["/usr/bin/pgrep", "-f", process_pattern],
            check=False,
            capture_output=True,
            text=True,
        )
        if running.returncode != 0:
            return
        sleep(1)
    raise MaintenanceError("installed app did not stop before replacement")


def installed_app_is_healthy(
    requested_app: Path | None = None,
    *,
    run_command: Callable[..., subprocess.CompletedProcess] = subprocess.run,
    sleep: Callable[[float], None] = time.sleep,
    grace_seconds: float = 8,
) -> bool:
    app = Path(requested_app or "/Applications/Orgo AI Guy Bot.app").resolve()
    launched = run_command(
        ["/usr/bin/open", "-a", str(app)],
        check=False,
        capture_output=True,
        text=True,
    )
    if launched.returncode != 0:
        return False
    sleep(grace_seconds)
    running = run_command(
        ["/usr/bin/pgrep", "-f", str(app / "Contents/MacOS/Orgo AI Guy Bot")],
        check=False,
        capture_output=True,
        text=True,
    )
    return running.returncode == 0


def _write_receipt(state_dir: Path, receipt: dict[str, object]) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    target = state_dir / "last-run.json"
    temporary = state_dir / f".last-run-{uuid.uuid4().hex}.tmp"
    temporary.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    os.replace(temporary, target)


def main(
    argv: Sequence[str] | None = None,
    *,
    build_candidate: Callable[[Path], Path] | None = None,
    stop_running: Callable[[], None] | None = None,
    health_check: Callable[[], bool] | None = None,
) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--check", action="store_true", help="check update state only")
    modes.add_argument("--apply", action="store_true", help="apply a verified update")
    parser.add_argument("--no-fetch", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=Path.home() / "Library/Application Support/Hermes Bots/maintenance",
    )
    parser.add_argument("--app", type=Path, default=Path("/Applications/Orgo AI Guy Bot.app"))
    parser.add_argument(
        "--backup-dir",
        type=Path,
        default=Path.home() / "Backups/Orgo AI Guy Bot/apps",
    )
    args = parser.parse_args(argv)

    with MaintenanceLock(args.state_dir / "maintenance.lock"):
        try:
            inspection = inspect_repository(args.repo, fetch=not args.no_fetch)
            inspection = inspect_installed_app(args.repo, inspection, args.app)
            status = {
                "none": "up-to-date",
                "update": "update-available",
                "blocked": "blocked",
            }[inspection.action]
            if args.apply and inspection.action == "update":
                apply_repository_update(
                    args.repo,
                    inspection,
                    args.app,
                    args.backup_dir,
                    build_candidate=build_candidate or production_build_candidate,
                    stop_running=stop_running or (lambda: stop_installed_app(args.app)),
                    health_check=health_check or (lambda: installed_app_is_healthy(args.app)),
                )
                status = "updated"
            receipt: dict[str, object] = {
                "product": ORGO_PRODUCT_NAME,
                "status": status,
                "reason": inspection.reason,
                "checked_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "head_sha": inspection.origin_sha if status == "updated" else inspection.head_sha,
                "origin_sha": inspection.origin_sha,
                "upstream_sha": inspection.upstream_sha,
                "upstream_pending": inspection.upstream_pending,
            }
            exit_code = 0
        except Exception as exc:
            if isinstance(exc, MaintenanceError):
                reason = str(exc)
            elif isinstance(exc, subprocess.CalledProcessError):
                command = exc.cmd[0] if isinstance(exc.cmd, (list, tuple)) and exc.cmd else "command"
                reason = f"command-failed:{Path(str(command)).name}"
            else:
                reason = type(exc).__name__
            receipt = {
                "product": ORGO_PRODUCT_NAME,
                "status": "failed",
                "reason": reason,
                "checked_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "head_sha": "",
                "origin_sha": "",
                "upstream_sha": "",
                "upstream_pending": False,
            }
            exit_code = 1
        _write_receipt(args.state_dir, receipt)
        print(json.dumps(receipt, sort_keys=True))
        return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
