from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import scripts.orgo_maintenance as maintenance
from scripts.orgo_maintenance import (
    MaintenanceError,
    ORGO_ORIGIN_URL,
    ORGO_UPSTREAM_URL,
    inspect_repository,
)


def git(cwd: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def stamp_app(app: Path, sha: str, **overrides) -> None:
    stamp = app / "Contents/Resources/install-stamp.json"
    stamp.parent.mkdir(parents=True, exist_ok=True)
    stamp.write_text(json.dumps({"schemaVersion": 1, "commit": sha,
                                "dirty": False, **overrides}), encoding="utf-8")


class RepositoryInspectionTests(unittest.TestCase):
    def test_dirty_checkout_is_blocked_before_update(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            seed = root / "seed"
            seed.mkdir()
            git(seed, "init", "-b", "main")
            git(seed, "config", "user.name", "Orgo Test")
            git(seed, "config", "user.email", "orgo-test@example.invalid")
            (seed / "README.md").write_text("initial\n", encoding="utf-8")
            git(seed, "add", "README.md")
            git(seed, "commit", "-m", "initial")

            origin = root / "origin.git"
            upstream = root / "upstream.git"
            git(root, "clone", "--bare", str(seed), str(origin))
            git(root, "clone", "--bare", str(seed), str(upstream))

            checkout = root / "checkout"
            git(root, "clone", str(origin), str(checkout))
            git(checkout, "remote", "set-url", "origin", ORGO_ORIGIN_URL)
            git(checkout, "remote", "add", "upstream", ORGO_UPSTREAM_URL)
            (checkout / "dirty.txt").write_text("local edit\n", encoding="utf-8")

            inspection = inspect_repository(checkout, fetch=False)

            self.assertEqual(inspection.action, "blocked")
            self.assertEqual(inspection.reason, "dirty-checkout")
            self.assertTrue(inspection.dirty)

    def test_clean_checkout_plans_fast_forward_when_origin_is_ahead(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            repo = root / "repo"
            repo.mkdir()
            git(repo, "init", "-b", "main")
            git(repo, "config", "user.name", "Orgo Test")
            git(repo, "config", "user.email", "orgo-test@example.invalid")
            (repo / "README.md").write_text("initial\n", encoding="utf-8")
            git(repo, "add", "README.md")
            git(repo, "commit", "-m", "initial")
            initial_sha = git(repo, "rev-parse", "HEAD")
            git(repo, "remote", "add", "origin", ORGO_ORIGIN_URL)
            git(repo, "remote", "add", "upstream", ORGO_UPSTREAM_URL)
            git(repo, "update-ref", "refs/remotes/upstream/main", initial_sha)

            (repo / "README.md").write_text("initial\nremote update\n", encoding="utf-8")
            git(repo, "add", "README.md")
            git(repo, "commit", "-m", "remote update")
            origin_sha = git(repo, "rev-parse", "HEAD")
            git(repo, "update-ref", "refs/remotes/origin/main", origin_sha)
            git(repo, "checkout", "--detach", initial_sha)
            git(repo, "branch", "-f", "main", initial_sha)
            git(repo, "checkout", "main")

            inspection = inspect_repository(repo, fetch=False)

            self.assertEqual(inspection.action, "update")
            self.assertEqual(inspection.reason, "origin-ahead")
            self.assertEqual(inspection.head_sha, initial_sha)
            self.assertEqual(inspection.origin_sha, origin_sha)

    def test_diverged_checkout_is_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            repo = Path(raw) / "repo"
            repo.mkdir()
            git(repo, "init", "-b", "main")
            git(repo, "config", "user.name", "Orgo Test")
            git(repo, "config", "user.email", "orgo-test@example.invalid")
            (repo / "README.md").write_text("initial\n", encoding="utf-8")
            git(repo, "add", "README.md")
            git(repo, "commit", "-m", "initial")
            initial_sha = git(repo, "rev-parse", "HEAD")
            git(repo, "remote", "add", "origin", ORGO_ORIGIN_URL)
            git(repo, "remote", "add", "upstream", ORGO_UPSTREAM_URL)
            git(repo, "update-ref", "refs/remotes/upstream/main", initial_sha)

            (repo / "local.txt").write_text("local\n", encoding="utf-8")
            git(repo, "add", "local.txt")
            git(repo, "commit", "-m", "local")
            git(repo, "checkout", "--detach", initial_sha)
            (repo / "remote.txt").write_text("remote\n", encoding="utf-8")
            git(repo, "add", "remote.txt")
            git(repo, "commit", "-m", "remote")
            origin_sha = git(repo, "rev-parse", "HEAD")
            git(repo, "update-ref", "refs/remotes/origin/main", origin_sha)
            git(repo, "checkout", "main")

            inspection = inspect_repository(repo, fetch=False)

            self.assertEqual(inspection.action, "blocked")
            self.assertEqual(inspection.reason, "diverged-from-origin")


class AppSwapTests(unittest.TestCase):
    def test_failed_candidate_health_restores_original_app(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            installed = root / "Applications" / "Orgo AI Guy Bot.app"
            candidate = root / "candidate" / "Orgo AI Guy Bot.app"
            backup_root = root / "backups"
            installed.mkdir(parents=True)
            candidate.mkdir(parents=True)
            (installed / "version.txt").write_text("old\n", encoding="utf-8")
            (candidate / "version.txt").write_text("new\n", encoding="utf-8")

            events: list[str] = []

            def stop_running() -> None:
                events.append("stopped")

            def failed_health_check() -> bool:
                events.append("health-checked")
                self.assertEqual(
                    (installed / "version.txt").read_text(encoding="utf-8"),
                    "new\n",
                )
                return False

            with self.assertRaisesRegex(MaintenanceError, "health check failed"):
                maintenance.swap_installed_app(
                    candidate,
                    installed,
                    backup_root,
                    stop_running=stop_running,
                    health_check=failed_health_check,
                )

            self.assertEqual(events, ["stopped", "health-checked"])
            self.assertEqual(
                (installed / "version.txt").read_text(encoding="utf-8"),
                "old\n",
            )

    def test_activation_failure_restores_original_app(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            installed = root / "Orgo AI Guy Bot.app"
            candidate = root / "candidate.app"
            backup_root = root / "backups"
            installed.mkdir()
            candidate.mkdir()
            (installed / "version.txt").write_text("old\n", encoding="utf-8")
            (candidate / "version.txt").write_text("new\n", encoding="utf-8")

            def fail_activation(_staged: Path, _installed: Path) -> None:
                raise OSError("activation failed")

            with self.assertRaisesRegex(OSError, "activation failed"):
                maintenance.swap_installed_app(
                    candidate,
                    installed,
                    backup_root,
                    stop_running=lambda: None,
                    health_check=lambda: True,
                    activate_candidate=fail_activation,
                )

            self.assertTrue(installed.exists())
            self.assertEqual((installed / "version.txt").read_text(encoding="utf-8"), "old\n")

    def test_successful_swap_prunes_old_app_backups(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            installed = root / "Orgo AI Guy Bot.app"
            candidate = root / "candidate.app"
            backup_root = root / "backups"
            installed.mkdir()
            candidate.mkdir()
            backup_root.mkdir()
            (installed / "version.txt").write_text("current\n", encoding="utf-8")
            (candidate / "version.txt").write_text("new\n", encoding="utf-8")
            for index in range(3):
                old = backup_root / f"Orgo AI Guy Bot-{'a' * 31}{index}.app"
                old.mkdir()
                os.utime(old, (index + 1, index + 1))
            unrelated_dir = backup_root / "family-photos"
            unrelated_dir.mkdir()
            (unrelated_dir / "keep.txt").write_text("keep\n", encoding="utf-8")
            unrelated_file = backup_root / "taxes.pdf"
            unrelated_file.write_text("keep\n", encoding="utf-8")

            maintenance.swap_installed_app(
                candidate,
                installed,
                backup_root,
                stop_running=lambda: None,
                health_check=lambda: True,
                max_backups=2,
            )

            updater_backups = list(backup_root.glob("Orgo AI Guy Bot-*.app"))
            self.assertEqual(len(updater_backups), 2)
            self.assertEqual((unrelated_dir / "keep.txt").read_text(encoding="utf-8"), "keep\n")
            self.assertEqual(unrelated_file.read_text(encoding="utf-8"), "keep\n")
            self.assertEqual((installed / "version.txt").read_text(encoding="utf-8"), "new\n")


class UpdateApplicationTests(unittest.TestCase):
    def test_failed_candidate_does_not_move_main_or_keep_bad_app(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            repo = root / "repo"
            repo.mkdir()
            git(repo, "init", "-b", "main")
            git(repo, "config", "user.name", "Orgo Test")
            git(repo, "config", "user.email", "orgo-test@example.invalid")
            (repo / "README.md").write_text("initial\n", encoding="utf-8")
            git(repo, "add", "README.md")
            git(repo, "commit", "-m", "initial")
            initial_sha = git(repo, "rev-parse", "HEAD")
            git(repo, "remote", "add", "origin", ORGO_ORIGIN_URL)
            git(repo, "remote", "add", "upstream", ORGO_UPSTREAM_URL)
            git(repo, "update-ref", "refs/remotes/upstream/main", initial_sha)

            (repo / "README.md").write_text("initial\nupdate\n", encoding="utf-8")
            git(repo, "add", "README.md")
            git(repo, "commit", "-m", "update")
            origin_sha = git(repo, "rev-parse", "HEAD")
            git(repo, "update-ref", "refs/remotes/origin/main", origin_sha)
            git(repo, "checkout", "--detach", initial_sha)
            git(repo, "branch", "-f", "main", initial_sha)
            git(repo, "checkout", "main")
            inspection = inspect_repository(repo, fetch=False)

            installed = root / "Applications" / "Orgo AI Guy Bot.app"
            installed.mkdir(parents=True)
            (installed / "version.txt").write_text("old\n", encoding="utf-8")

            def build_candidate(worktree: Path) -> Path:
                self.assertEqual(git(worktree, "rev-parse", "HEAD"), origin_sha)
                candidate = worktree / "Orgo AI Guy Bot.app"
                candidate.mkdir()
                (candidate / "version.txt").write_text("new\n", encoding="utf-8")
                return candidate

            with self.assertRaisesRegex(MaintenanceError, "health check failed"):
                maintenance.apply_repository_update(
                    repo,
                    inspection,
                    installed,
                    root / "backups",
                    build_candidate=build_candidate,
                    stop_running=lambda: None,
                    health_check=lambda: False,
                )

            self.assertEqual(git(repo, "rev-parse", "HEAD"), initial_sha)
            self.assertEqual(
                (installed / "version.txt").read_text(encoding="utf-8"),
                "old\n",
            )

    def test_healthy_candidate_moves_main_and_keeps_backup(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            repo = root / "repo"
            repo.mkdir()
            git(repo, "init", "-b", "main")
            git(repo, "config", "user.name", "Orgo Test")
            git(repo, "config", "user.email", "orgo-test@example.invalid")
            (repo / "README.md").write_text("initial\n", encoding="utf-8")
            git(repo, "add", "README.md")
            git(repo, "commit", "-m", "initial")
            initial_sha = git(repo, "rev-parse", "HEAD")
            git(repo, "remote", "add", "origin", ORGO_ORIGIN_URL)
            git(repo, "remote", "add", "upstream", ORGO_UPSTREAM_URL)
            git(repo, "update-ref", "refs/remotes/upstream/main", initial_sha)

            (repo / "README.md").write_text("initial\nupdate\n", encoding="utf-8")
            git(repo, "add", "README.md")
            git(repo, "commit", "-m", "update")
            origin_sha = git(repo, "rev-parse", "HEAD")
            git(repo, "update-ref", "refs/remotes/origin/main", origin_sha)
            git(repo, "checkout", "--detach", initial_sha)
            git(repo, "branch", "-f", "main", initial_sha)
            git(repo, "checkout", "main")
            inspection = inspect_repository(repo, fetch=False)

            installed = root / "Applications" / "Orgo AI Guy Bot.app"
            installed.mkdir(parents=True)
            (installed / "version.txt").write_text("old\n", encoding="utf-8")
            backup_root = root / "backups"

            def build_candidate(worktree: Path) -> Path:
                candidate = worktree / "Orgo AI Guy Bot.app"
                candidate.mkdir()
                (candidate / "version.txt").write_text("new\n", encoding="utf-8")
                return candidate

            maintenance.apply_repository_update(
                repo,
                inspection,
                installed,
                backup_root,
                build_candidate=build_candidate,
                stop_running=lambda: None,
                health_check=lambda: True,
            )

            self.assertEqual(git(repo, "rev-parse", "HEAD"), origin_sha)
            self.assertEqual(
                (installed / "version.txt").read_text(encoding="utf-8"),
                "new\n",
            )
            backups = list(backup_root.glob("*.app/version.txt"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_text(encoding="utf-8"), "old\n")

    def test_finalize_race_restores_original_app(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            repo = root / "repo"
            repo.mkdir()
            git(repo, "init", "-b", "main")
            git(repo, "config", "user.name", "Orgo Test")
            git(repo, "config", "user.email", "orgo-test@example.invalid")
            (repo / "README.md").write_text("initial\n", encoding="utf-8")
            git(repo, "add", "README.md")
            git(repo, "commit", "-m", "initial")
            initial_sha = git(repo, "rev-parse", "HEAD")
            git(repo, "remote", "add", "origin", ORGO_ORIGIN_URL)
            git(repo, "remote", "add", "upstream", ORGO_UPSTREAM_URL)
            git(repo, "update-ref", "refs/remotes/upstream/main", initial_sha)

            (repo / "README.md").write_text("initial\nupdate\n", encoding="utf-8")
            git(repo, "add", "README.md")
            git(repo, "commit", "-m", "origin update")
            origin_sha = git(repo, "rev-parse", "HEAD")
            git(repo, "update-ref", "refs/remotes/origin/main", origin_sha)
            git(repo, "checkout", "--detach", initial_sha)
            git(repo, "branch", "-f", "main", initial_sha)
            git(repo, "checkout", "main")
            inspection = inspect_repository(repo, fetch=False)

            installed = root / "Applications" / "Orgo AI Guy Bot.app"
            installed.mkdir(parents=True)
            (installed / "version.txt").write_text("old\n", encoding="utf-8")
            backup_root = root / "backups"

            def build_candidate(worktree: Path) -> Path:
                candidate = worktree / "Orgo AI Guy Bot.app"
                candidate.mkdir()
                (candidate / "version.txt").write_text("new\n", encoding="utf-8")
                return candidate

            def race_during_health() -> bool:
                (repo / "race.txt").write_text("race\n", encoding="utf-8")
                git(repo, "add", "race.txt")
                git(repo, "commit", "-m", "concurrent main move")
                return True

            with self.assertRaises(subprocess.CalledProcessError):
                maintenance.apply_repository_update(
                    repo,
                    inspection,
                    installed,
                    backup_root,
                    build_candidate=build_candidate,
                    stop_running=lambda: None,
                    health_check=race_during_health,
                )

            self.assertNotEqual(git(repo, "rev-parse", "HEAD"), origin_sha)
            self.assertEqual((installed / "version.txt").read_text(encoding="utf-8"), "old\n")

    def test_finalize_stop_failure_restores_original_app_and_preserves_merge_error(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            repo = root / "repo"
            repo.mkdir()
            git(repo, "init", "-b", "main")
            git(repo, "config", "user.name", "Orgo Test")
            git(repo, "config", "user.email", "orgo-test@example.invalid")
            (repo / "README.md").write_text("initial\n", encoding="utf-8")
            git(repo, "add", "README.md")
            git(repo, "commit", "-m", "initial")
            initial_sha = git(repo, "rev-parse", "HEAD")
            git(repo, "remote", "add", "origin", ORGO_ORIGIN_URL)
            git(repo, "remote", "add", "upstream", ORGO_UPSTREAM_URL)
            git(repo, "update-ref", "refs/remotes/upstream/main", initial_sha)

            (repo / "README.md").write_text("initial\nupdate\n", encoding="utf-8")
            git(repo, "add", "README.md")
            git(repo, "commit", "-m", "origin update")
            origin_sha = git(repo, "rev-parse", "HEAD")
            git(repo, "update-ref", "refs/remotes/origin/main", origin_sha)
            git(repo, "checkout", "--detach", initial_sha)
            git(repo, "branch", "-f", "main", initial_sha)
            git(repo, "checkout", "main")
            inspection = inspect_repository(repo, fetch=False)

            installed = root / "Applications" / "Orgo AI Guy Bot.app"
            installed.mkdir(parents=True)
            (installed / "version.txt").write_text("old\n", encoding="utf-8")

            def build_candidate(worktree: Path) -> Path:
                candidate = worktree / "Orgo AI Guy Bot.app"
                candidate.mkdir()
                (candidate / "version.txt").write_text("new\n", encoding="utf-8")
                return candidate

            stop_calls = 0

            def stop_running() -> None:
                nonlocal stop_calls
                stop_calls += 1
                if stop_calls == 2:
                    raise OSError("second stop failed")

            def race_during_health() -> bool:
                (repo / "race.txt").write_text("race\n", encoding="utf-8")
                git(repo, "add", "race.txt")
                git(repo, "commit", "-m", "concurrent main move")
                return True

            with self.assertRaises(subprocess.CalledProcessError) as raised:
                maintenance.apply_repository_update(
                    repo,
                    inspection,
                    installed,
                    root / "backups",
                    build_candidate=build_candidate,
                    stop_running=stop_running,
                    health_check=race_during_health,
                )

            self.assertEqual(
                raised.exception.cmd,
                ["git", "merge", "--ff-only", origin_sha],
            )
            self.assertEqual(stop_calls, 2)
            self.assertEqual((installed / "version.txt").read_text(encoding="utf-8"), "old\n")


class CandidateBuildTests(unittest.TestCase):
    def test_production_build_discovers_x64_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            worktree = Path(raw)
            candidate = (
                worktree
                / "apps/desktop/release/mac-x64/Orgo AI Guy Bot.app"
            )
            candidate.mkdir(parents=True)
            commands: list[list[str]] = []
            original_run = maintenance._run

            def record_run(command, *, cwd, check=True):
                commands.append(list(command))
                return subprocess.CompletedProcess(command, 0)

            maintenance._run = record_run
            try:
                result = maintenance.production_build_candidate(worktree)
            finally:
                maintenance._run = original_run

            self.assertEqual(result, candidate)
            self.assertEqual(
                commands[-1],
                ["/usr/bin/codesign", "--verify", "--deep", "--strict", str(candidate)],
            )

    def test_production_build_rejects_missing_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            worktree = Path(raw)
            (worktree / "apps/desktop").mkdir(parents=True)
            original_run = maintenance._run
            maintenance._run = lambda command, *, cwd, check=True: subprocess.CompletedProcess(
                command, 0
            )
            try:
                with self.assertRaisesRegex(
                    MaintenanceError,
                    "expected exactly one candidate app, found 0",
                ):
                    maintenance.production_build_candidate(worktree)
            finally:
                maintenance._run = original_run

    def test_production_build_rejects_ambiguous_candidates(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            worktree = Path(raw)
            desktop = worktree / "apps/desktop"
            for architecture in ("mac-arm64", "mac-x64"):
                (desktop / f"release/{architecture}/Orgo AI Guy Bot.app").mkdir(
                    parents=True
                )
            original_run = maintenance._run
            maintenance._run = lambda command, *, cwd, check=True: subprocess.CompletedProcess(
                command, 0
            )
            try:
                with self.assertRaisesRegex(
                    MaintenanceError,
                    "expected exactly one candidate app, found 2",
                ):
                    maintenance.production_build_candidate(worktree)
            finally:
                maintenance._run = original_run


class RuntimeHealthTests(unittest.TestCase):
    def test_health_check_waits_and_targets_requested_app(self) -> None:
        app = Path("/tmp/Custom Orgo.app")
        calls: list[list[str]] = []
        sleeps: list[float] = []

        class Result:
            returncode = 0

        def run_command(command, **_kwargs):
            calls.append(list(command))
            return Result()

        self.assertTrue(
            maintenance.installed_app_is_healthy(
                app,
                run_command=run_command,
                sleep=sleeps.append,
                grace_seconds=7,
            )
        )
        resolved_app = app.resolve()
        self.assertEqual(calls[0], ["/usr/bin/open", "-a", str(resolved_app)])
        self.assertIn(str(resolved_app / "Contents/MacOS/Orgo AI Guy Bot"), calls[1][-1])
        self.assertEqual(sleeps, [7])

    def test_stop_waits_until_requested_app_process_exits(self) -> None:
        app = Path("/tmp/Custom Orgo.app")
        calls: list[list[str]] = []
        sleeps: list[float] = []
        pgrep_codes = iter([0, 1])

        class Result:
            def __init__(self, returncode: int):
                self.returncode = returncode

        def run_command(command, **_kwargs):
            calls.append(list(command))
            if command[0] == "/usr/bin/pgrep":
                return Result(next(pgrep_codes))
            return Result(0)

        maintenance.stop_installed_app(
            app,
            run_command=run_command,
            sleep=sleeps.append,
            timeout_seconds=3,
        )
        pgrep_calls = [command for command in calls if command[0] == "/usr/bin/pgrep"]
        self.assertEqual(len(pgrep_calls), 2)
        self.assertIn(str(app / "Contents/MacOS/Orgo AI Guy Bot"), pgrep_calls[0][-1])
        self.assertEqual(sleeps, [1])

    def test_stop_aborts_after_timeout_when_process_remains(self) -> None:
        with self.assertRaisesRegex(MaintenanceError, "did not stop"):
            maintenance.stop_installed_app(
                Path("/tmp/Custom Orgo.app"),
                run_command=lambda *_args, **_kwargs: subprocess.CompletedProcess([], 0),
                sleep=lambda _seconds: None,
                timeout_seconds=2,
            )


class MaintenanceLockTests(unittest.TestCase):
    def test_second_concurrent_run_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            lock_path = Path(raw) / "maintenance.lock"
            with maintenance.MaintenanceLock(lock_path):
                with self.assertRaisesRegex(MaintenanceError, "already running"):
                    with maintenance.MaintenanceLock(lock_path):
                        self.fail("second lock acquisition unexpectedly succeeded")


class CommandLineTests(unittest.TestCase):
    def test_check_writes_durable_no_update_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            repo = root / "repo"
            repo.mkdir()
            git(repo, "init", "-b", "main")
            git(repo, "config", "user.name", "Orgo Test")
            git(repo, "config", "user.email", "orgo-test@example.invalid")
            (repo / "README.md").write_text("initial\n", encoding="utf-8")
            git(repo, "add", "README.md")
            git(repo, "commit", "-m", "initial")
            sha = git(repo, "rev-parse", "HEAD")
            git(repo, "remote", "add", "origin", ORGO_ORIGIN_URL)
            git(repo, "remote", "add", "upstream", ORGO_UPSTREAM_URL)
            git(repo, "update-ref", "refs/remotes/origin/main", sha)
            git(repo, "update-ref", "refs/remotes/upstream/main", sha)
            state_dir = root / "state"

            installed = root / "installed.app"
            stamp_app(installed, sha)

            exit_code = maintenance.main(
                [
                    "--check",
                    "--no-fetch",
                    "--repo",
                    str(repo),
                    "--state-dir",
                    str(state_dir),
                    "--app", str(installed),
                ]
            )

            self.assertEqual(exit_code, 0)
            receipt = json.loads(
                (state_dir / "last-run.json").read_text(encoding="utf-8")
            )
            self.assertEqual(receipt["product"], "Orgo AI Guy Bot")
            self.assertEqual(receipt["status"], "up-to-date")
            self.assertEqual(receipt["head_sha"], sha)
            self.assertEqual(receipt["origin_sha"], sha)
            self.assertEqual(receipt["upstream_sha"], sha)

    def test_apply_is_a_noop_when_origin_is_current(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            repo = root / "repo"
            repo.mkdir()
            git(repo, "init", "-b", "main")
            git(repo, "config", "user.name", "Orgo Test")
            git(repo, "config", "user.email", "orgo-test@example.invalid")
            (repo / "README.md").write_text("initial\n", encoding="utf-8")
            git(repo, "add", "README.md")
            git(repo, "commit", "-m", "initial")
            sha = git(repo, "rev-parse", "HEAD")
            git(repo, "remote", "add", "origin", ORGO_ORIGIN_URL)
            git(repo, "remote", "add", "upstream", ORGO_UPSTREAM_URL)
            git(repo, "update-ref", "refs/remotes/origin/main", sha)
            git(repo, "update-ref", "refs/remotes/upstream/main", sha)
            state_dir = root / "state"

            installed = root / "installed.app"
            stamp_app(installed, sha)

            exit_code = maintenance.main(
                [
                    "--apply",
                    "--no-fetch",
                    "--repo",
                    str(repo),
                    "--state-dir",
                    str(state_dir),
                    "--app", str(installed),
                ]
            )

            self.assertEqual(exit_code, 0)
            receipt = json.loads(
                (state_dir / "last-run.json").read_text(encoding="utf-8")
            )
            self.assertEqual(receipt["status"], "up-to-date")

    def test_apply_activates_verified_origin_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            repo = root / "repo"
            repo.mkdir()
            git(repo, "init", "-b", "main")
            git(repo, "config", "user.name", "Orgo Test")
            git(repo, "config", "user.email", "orgo-test@example.invalid")
            (repo / "README.md").write_text("initial\n", encoding="utf-8")
            git(repo, "add", "README.md")
            git(repo, "commit", "-m", "initial")
            initial_sha = git(repo, "rev-parse", "HEAD")
            git(repo, "remote", "add", "origin", ORGO_ORIGIN_URL)
            git(repo, "remote", "add", "upstream", ORGO_UPSTREAM_URL)
            git(repo, "update-ref", "refs/remotes/upstream/main", initial_sha)
            (repo / "README.md").write_text("initial\nupdate\n", encoding="utf-8")
            git(repo, "add", "README.md")
            git(repo, "commit", "-m", "update")
            origin_sha = git(repo, "rev-parse", "HEAD")
            git(repo, "update-ref", "refs/remotes/origin/main", origin_sha)
            git(repo, "checkout", "--detach", initial_sha)
            git(repo, "branch", "-f", "main", initial_sha)
            git(repo, "checkout", "main")

            installed = root / "Applications" / "Orgo AI Guy Bot.app"
            installed.mkdir(parents=True)
            (installed / "version.txt").write_text("old\n", encoding="utf-8")
            state_dir = root / "state"

            def build_candidate(worktree: Path) -> Path:
                candidate = worktree / "Orgo AI Guy Bot.app"
                candidate.mkdir()
                (candidate / "version.txt").write_text("new\n", encoding="utf-8")
                return candidate

            exit_code = maintenance.main(
                [
                    "--apply",
                    "--no-fetch",
                    "--repo",
                    str(repo),
                    "--state-dir",
                    str(state_dir),
                    "--app",
                    str(installed),
                    "--backup-dir",
                    str(root / "backups"),
                ],
                build_candidate=build_candidate,
                stop_running=lambda: None,
                health_check=lambda: True,
            )

            self.assertEqual(exit_code, 0)
            self.assertEqual(git(repo, "rev-parse", "HEAD"), origin_sha)
            self.assertEqual(
                (installed / "version.txt").read_text(encoding="utf-8"),
                "new\n",
            )
            receipt = json.loads(
                (state_dir / "last-run.json").read_text(encoding="utf-8")
            )
            self.assertEqual(receipt["status"], "updated")
            self.assertEqual(receipt["head_sha"], origin_sha)

    def test_preflight_failure_writes_sanitized_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            repo = root / "repo"
            repo.mkdir()
            git(repo, "init", "-b", "main")
            git(repo, "config", "user.name", "Orgo Test")
            git(repo, "config", "user.email", "orgo-test@example.invalid")
            (repo / "README.md").write_text("initial\n", encoding="utf-8")
            git(repo, "add", "README.md")
            git(repo, "commit", "-m", "initial")
            git(repo, "remote", "add", "origin", "https://token-secret@example.invalid/repo.git")
            git(repo, "remote", "add", "upstream", ORGO_UPSTREAM_URL)
            state_dir = root / "state"

            result = maintenance.main(
                [
                    "--check",
                    "--no-fetch",
                    "--repo",
                    str(repo),
                    "--state-dir",
                    str(state_dir),
                ]
            )

            self.assertEqual(result, 1)
            raw_receipt = (state_dir / "last-run.json").read_text(encoding="utf-8")
            receipt = json.loads(raw_receipt)
            self.assertEqual(receipt["status"], "failed")
            self.assertNotIn("token-secret", raw_receipt)

    def test_candidate_gate_builds_only_after_required_checks(self) -> None:
        commands = maintenance.candidate_build_commands()

        self.assertEqual(commands[0], ["npm", "ci"])
        self.assertIn(
            ["npx", "tsc", "-p", "tsconfig.electron.json", "--noEmit"],
            commands,
        )
        self.assertIn(["npx", "tsc", "-p", "tsconfig.json", "--noEmit"], commands)
        self.assertIn(["npm", "run", "lint"], commands)
        self.assertIn("electron/product.test.ts", " ".join(commands[-2]))
        self.assertEqual(commands[-1], ["npm", "run", "dist:bot:mac:dmg"])


class InstalledReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-b", "main")
        git(self.repo, "config", "user.name", "Orgo Test")
        git(self.repo, "config", "user.email", "orgo-test@example.invalid")
        (self.repo / "version").write_text("old")
        git(self.repo, "add", "version")
        git(self.repo, "commit", "-m", "old")
        self.old_sha = git(self.repo, "rev-parse", "HEAD")
        (self.repo / "version").write_text("new")
        git(self.repo, "commit", "-am", "new")
        self.sha = git(self.repo, "rev-parse", "HEAD")
        git(self.repo, "remote", "add", "origin", ORGO_ORIGIN_URL)
        git(self.repo, "remote", "add", "upstream", ORGO_UPSTREAM_URL)
        for remote in ("origin", "upstream"):
            git(self.repo, "update-ref", f"refs/remotes/{remote}/main", self.sha)
        self.app = self.root / "installed.app"
        stamp_app(self.app, self.old_sha)
        self.builds = 0

    def run_maintenance(self, mode="--check", healthy=True, during_build=None):
        def build(worktree):
            self.builds += 1
            self.assertNotEqual(worktree, self.repo)
            self.assertEqual(git(worktree, "rev-parse", "HEAD"), self.sha)
            candidate = worktree / "candidate.app"
            stamp_app(candidate, self.sha)
            if during_build:
                during_build()
            return candidate

        code = maintenance.main(
            [mode, "--no-fetch", "--repo", str(self.repo), "--app", str(self.app),
             "--state-dir", str(self.root / "state"),
             "--backup-dir", str(self.root / "backups")],
            build_candidate=build, stop_running=lambda: None,
            health_check=healthy if callable(healthy) else lambda: healthy,
        )
        return code, json.loads((self.root / "state/last-run.json").read_text())

    def test_check_detects_old_app_with_current_checkout_without_building(self):
        code, receipt = self.run_maintenance()
        self.assertEqual(code, 0)
        self.assertEqual(receipt["status"], "update-available")
        self.assertEqual(receipt["reason"], "installed-app-behind")
        self.assertEqual(self.builds, 0)

    def test_reconcile_preserves_head_and_is_idempotent(self):
        code, receipt = self.run_maintenance("--apply")
        self.assertEqual(code, 0)
        self.assertEqual(receipt["status"], "updated")
        self.assertEqual(self.builds, 1)
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), self.sha)
        self.assertEqual(git(self.repo, "status", "--porcelain"), "")
        self.assertEqual(len(list((self.root / "backups").glob("*.app"))), 1)
        code, receipt = self.run_maintenance("--apply")
        self.assertEqual(receipt["status"], "up-to-date")
        self.assertEqual(self.builds, 1)

    def test_failed_health_rolls_back_without_moving_head(self):
        code, receipt = self.run_maintenance("--apply", healthy=False)
        self.assertEqual(code, 1)
        self.assertEqual(receipt["status"], "failed")
        stamp = json.loads((self.app / "Contents/Resources/install-stamp.json").read_text())
        self.assertEqual(stamp["commit"], self.old_sha)
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), self.sha)

    def test_untrusted_stamps_never_trigger_replacement(self):
        for stamp in (None, "not json", "[]", json.dumps({"schemaVersion": 1}),
                      json.dumps({"schemaVersion": 1, "commit": self.old_sha, "dirty": True}),
                      json.dumps({"schemaVersion": 2, "commit": self.old_sha, "dirty": False}),
                      json.dumps({"schemaVersion": 1, "commit": "a" * 40, "dirty": False})):
            with self.subTest(stamp=stamp):
                path = self.app / "Contents/Resources/install-stamp.json"
                if stamp is None:
                    path.unlink()
                else:
                    path.write_text(stamp)
                code, receipt = self.run_maintenance("--apply")
                self.assertEqual(receipt["status"], "blocked")
                self.assertEqual(self.builds, 0)

    def test_dirty_checkout_stays_blocked_even_with_stale_app(self):
        (self.repo / "user-work").write_text("preserve")
        _, receipt = self.run_maintenance("--apply")
        self.assertEqual(receipt["reason"], "dirty-checkout")
        self.assertEqual(self.builds, 0)

    def test_edit_during_build_aborts_before_replacing_app(self):
        code, receipt = self.run_maintenance(
            "--apply", during_build=lambda: (self.repo / "user-work").write_text("preserve"),
        )
        self.assertEqual(code, 1)
        self.assertEqual(receipt["status"], "failed")
        stamp = json.loads((self.app / "Contents/Resources/install-stamp.json").read_text())
        self.assertEqual(stamp["commit"], self.old_sha)
        self.assertEqual((self.repo / "user-work").read_text(), "preserve")

    def test_edit_during_health_rolls_back_and_preserves_edit(self):
        def edit_during_health():
            (self.repo / "user-work").write_text("preserve")
            return True

        code, receipt = self.run_maintenance("--apply", healthy=edit_during_health)
        self.assertEqual(code, 1)
        self.assertEqual(receipt["status"], "failed")
        stamp = json.loads((self.app / "Contents/Resources/install-stamp.json").read_text())
        self.assertEqual(stamp["commit"], self.old_sha)
        self.assertEqual((self.repo / "user-work").read_text(), "preserve")
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), self.sha)


if __name__ == "__main__":
    unittest.main()
