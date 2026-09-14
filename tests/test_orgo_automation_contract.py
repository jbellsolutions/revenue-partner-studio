from __future__ import annotations

import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class UpstreamWorkflowContractTests(unittest.TestCase):
    def test_daily_nick_sync_separates_untrusted_tests_from_write_token(self) -> None:
        workflow = ROOT / ".github/workflows/orgo-upstream-sync.yml"
        text = workflow.read_text(encoding="utf-8")

        self.assertIn("cron:", text)
        self.assertIn("https://github.com/nickvasilescu/korgo-bot.git", text)
        self.assertIn("verify-upstream:", text)
        self.assertIn("publish-upstream:", text)
        verify = text.split("verify-upstream:", 1)[1].split("publish-upstream:", 1)[0]
        publish = text.split("publish-upstream:", 1)[1]
        self.assertIn("contents: read", verify)
        self.assertNotIn("contents: write", verify)
        self.assertIn("contents: write", publish)
        self.assertIn("git merge --no-edit upstream/main", verify)
        self.assertIn("refs/heads/orgo-verified-candidate", verify)
        self.assertIn("commit.verification.verified", verify)
        self.assertIn(".author.login", verify)
        self.assertIn('trusted_author="nickvasilescu"', verify)
        self.assertIn(".signature.signer.login", verify)
        self.assertIn('trusted_github_signer="web-flow"', verify)
        self.assertIn(".signature.wasSignedByGitHub", verify)
        self.assertIn("blocked-untrusted-upstream-author", verify)
        self.assertIn('git rev-list "$merge_base..upstream/main"', verify)
        self.assertIn(".github/**", verify)
        self.assertIn("blocked-protected-path", verify)
        self.assertIn("git bundle create", verify)
        self.assertIn("git bundle verify", publish)
        self.assertIn("git push origin", publish)
        self.assertNotIn("--force", publish)


class LocalSchedulerContractTests(unittest.TestCase):
    def test_launch_agent_installer_schedules_verified_apply_daily(self) -> None:
        installer = ROOT / "scripts/install-orgo-maintenance.sh"
        text = installer.read_text(encoding="utf-8")

        self.assertIn("com.orgo.ai-guy-bot.maintenance", text)
        self.assertIn("StartCalendarInterval", text)
        self.assertIn('"--apply"', text)
        self.assertIn("launchctl bootstrap", text)
        self.assertIn("launchctl kickstart", text)
        self.assertIn("StandardOutPath", text)
        self.assertIn("StandardErrorPath", text)
        self.assertIn('"--app"', text)
        self.assertIn('APP_PATH="$1"', text)
        self.assertNotIn("/Users/home", text)

    def test_beginner_installer_enables_daily_maintenance(self) -> None:
        installer = (ROOT / "installer/install.sh").read_text(encoding="utf-8")

        self.assertIn("install-orgo-maintenance.sh", installer)
        self.assertIn('install-orgo-maintenance.sh" "$DEST"', installer)
        self.assertIn("Daily self-update installed", installer)


class RemoteMaintenanceContractTests(unittest.TestCase):
    def _run_remote_maintenance_fixture(
        self,
        *,
        failure: str,
        rollback_reset_fails: bool = False,
        pre_update_dirty: bool = False,
        updater_leaves_dirty: bool = False,
        supervisor_managed: bool = False,
    ) -> tuple[subprocess.CompletedProcess[str], dict[str, object], list[str]]:
        source = (ROOT / "scripts/orgo-remote-maintenance.sh").read_text(
            encoding="utf-8"
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            state_home = root / "home"
            checkout = root / "checkout"
            checkout.mkdir()
            calls = root / "calls.log"

            dispatcher = fake_bin / "fixture-command"
            dispatcher.write_text(
                textwrap.dedent(
                    """\
                    #!/bin/bash
                    set -u
                    name="$(basename "$0")"
                    printf '%s %s\n' "$name" "$*" >>"$CALLS_FILE"
                    case "$name" in
                      flock) exit 0 ;;
                      git)
                        case "$*" in
                          *"status --porcelain"*)
                            if [[ "$PRE_UPDATE_DIRTY" == 1 ]] || { [[ "$UPDATER_LEAVES_DIRTY" == 1 ]] && [[ -f "$UPDATE_ATTEMPTED_FILE" ]]; }; then
                              printf ' M hermes_cli/runtime.py\n'
                            fi
                            ;;
                          *"rev-parse --is-inside-work-tree"*) printf 'true\n' ;;
                          *"rev-parse HEAD"*) printf '%s\n' "$PRE_UPDATE_SHA" ;;
                          *"cat-file -e"*) exit 0 ;;
                          *"reset --hard"*)
                            [[ "${ROLLBACK_RESET_FAILS:-0}" == 1 ]] && exit 72
                            : >"$ROLLED_BACK_FILE"
                            ;;
                        esac
                        ;;
                      hermes)
                        case "$1 ${2:-}" in
                          "--version ") printf 'Hermes fixture\n' ;;
                          "backup --output") : >"$3" ;;
                          "update --check") printf 'fixture update available\n' ;;
                          "update --help") printf '%s\n' '  --keep-stash' ;;
                          "update --yes")
                            : >"$UPDATE_ATTEMPTED_FILE"
                            [[ "$FAILURE" == update ]] && exit 41
                            : >"$UPDATED_FILE"
                            ;;
                          "gateway status")
                            if [[ "$FAILURE" == health && -f "$UPDATED_FILE" && ! -f "$ROLLED_BACK_FILE" ]]; then
                              exit 42
                            fi
                            ;;
                          "gateway restart") exit 0 ;;
                          "import --force") exit 0 ;;
                          "mcp test") exit 0 ;;
                          "curator run") exit 0 ;;
                        esac
                        ;;
                      supervisorctl)
                        if [[ "$SUPERVISOR_MANAGED" != 1 ]]; then
                          printf 'ERROR (no such process)\n'
                          exit 3
                        fi
                        case "$*" in
                          "status speakeragent-gateway")
                            if [[ -f "$SUPERVISOR_STOPPED_FILE" ]]; then
                              printf 'speakeragent-gateway STOPPED Not started\n'
                              exit 3
                            fi
                            printf 'speakeragent-gateway RUNNING pid 123, uptime 0:01:00\n'
                            ;;
                          "status hermes-gateway")
                            printf 'hermes-gateway: ERROR (no such process)\n'
                            exit 3
                            ;;
                          "stop speakeragent-gateway")
                            : >"$SUPERVISOR_STOPPED_FILE"
                            ;;
                          "restart speakeragent-gateway")
                            rm -f "$SUPERVISOR_STOPPED_FILE"
                            ;;
                        esac
                        ;;
                      uvx) exit 0 ;;
                    esac
                    """
                ),
                encoding="utf-8",
            )
            dispatcher.chmod(0o755)
            for command in ("flock", "git", "hermes", "supervisorctl", "uvx"):
                (fake_bin / command).symlink_to(dispatcher)

            runnable = root / "maintenance.sh"
            source = source.replace(
                'export PATH="/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin"',
                f'export PATH="{fake_bin}:/usr/bin:/bin"',
            ).replace(
                'BACKUP_DIR="/root/orgo-ai-guy-bot-backups/daily"',
                f'BACKUP_DIR="{root / "backups"}"',
            )
            runnable.write_text(source, encoding="utf-8")
            runnable.chmod(0o755)

            sha = "0123456789abcdef0123456789abcdef01234567"
            env = {
                **os.environ,
                "HERMES_HOME": str(state_home),
                "HERMES_RUNTIME_CHECKOUT": str(checkout),
                "CALLS_FILE": str(calls),
                "PRE_UPDATE_SHA": sha,
                "FAILURE": failure,
                "ROLLBACK_RESET_FAILS": "1" if rollback_reset_fails else "0",
                "PRE_UPDATE_DIRTY": "1" if pre_update_dirty else "0",
                "UPDATER_LEAVES_DIRTY": "1" if updater_leaves_dirty else "0",
                "SUPERVISOR_MANAGED": "1" if supervisor_managed else "0",
                "SUPERVISOR_STOPPED_FILE": str(root / "supervisor-stopped"),
                "UPDATE_ATTEMPTED_FILE": str(root / "update-attempted"),
                "ROLLED_BACK_FILE": str(root / "rolled-back"),
                "UPDATED_FILE": str(root / "updated"),
            }
            result = subprocess.run(
                [str(runnable)], capture_output=True, text=True, env=env, check=False
            )
            receipt = json.loads(
                (state_home / "maintenance/last-run.json").read_text(encoding="utf-8")
            )
            call_lines = calls.read_text(encoding="utf-8").splitlines()
            return result, receipt, call_lines

    def test_failed_update_can_rollback_dirt_created_by_the_updater(self) -> None:
        result, receipt, calls = self._run_remote_maintenance_fixture(
            failure="update", updater_leaves_dirty=True
        )

        self.assertNotEqual(0, result.returncode)
        self.assertEqual("rolled-back", receipt["status"])
        self.assertTrue(any("git -C" in line and "reset --hard" in line for line in calls))
        self.assertTrue(any("hermes import --force" in line for line in calls))

    def test_dirty_checkout_before_update_is_still_refused(self) -> None:
        result, receipt, calls = self._run_remote_maintenance_fixture(
            failure="none", pre_update_dirty=True
        )

        self.assertNotEqual(0, result.returncode)
        self.assertEqual("failed", receipt["status"])
        self.assertFalse(any("hermes update --yes" in line for line in calls))
        self.assertFalse(any("reset --hard" in line for line in calls))
        self.assertFalse(any("hermes import --force" in line for line in calls))

    def test_failed_update_restores_exact_code_and_data_then_verifies_health(self) -> None:
        result, receipt, calls = self._run_remote_maintenance_fixture(failure="update")

        sha = "0123456789abcdef0123456789abcdef01234567"
        self.assertNotEqual(0, result.returncode)
        self.assertEqual("rolled-back", receipt["status"])
        self.assertEqual(sha, receipt["pre_update_sha"])
        stop = next(i for i, line in enumerate(calls) if "gateway stop" in line)
        reset = next(i for i, line in enumerate(calls) if f"reset --hard {sha}" in line)
        sync = next(
            i
            for i, line in enumerate(calls)
            if "uvx --from uv==0.9.28 uv sync --locked --python 3.11 --extra all --extra dev"
            in line
        )
        restore = next(i for i, line in enumerate(calls) if "hermes import --force" in line)
        restart = max(i for i, line in enumerate(calls) if "gateway restart" in line)
        verify = max(i for i, line in enumerate(calls) if "mcp test super-browser" in line)
        self.assertLess(stop, reset)
        self.assertLess(reset, sync)
        self.assertLess(sync, restore)
        self.assertLess(restore, restart)
        self.assertLess(restart, verify)

    def test_rollback_restarts_stopped_supervisor_program_before_verifying(self) -> None:
        result, receipt, calls = self._run_remote_maintenance_fixture(
            failure="update", supervisor_managed=True
        )

        self.assertNotEqual(0, result.returncode)
        self.assertEqual("rolled-back", receipt["status"])
        restore = next(i for i, line in enumerate(calls) if "hermes import --force" in line)
        restart = next(
            i
            for i, line in enumerate(calls)
            if line == "supervisorctl restart speakeragent-gateway"
        )
        verify = max(i for i, line in enumerate(calls) if "mcp test super-browser" in line)
        self.assertLess(restore, restart)
        self.assertLess(restart, verify)

    def test_failed_post_update_health_uses_the_same_rollback_transaction(self) -> None:
        result, receipt, calls = self._run_remote_maintenance_fixture(failure="health")

        self.assertNotEqual(0, result.returncode)
        self.assertEqual("rolled-back", receipt["status"])
        self.assertTrue(any("hermes import --force" in line for line in calls))
        self.assertGreaterEqual(
            sum("hermes gateway status" in line for line in calls), 3
        )

    def test_rollback_failure_is_recorded_separately(self) -> None:
        result, receipt, calls = self._run_remote_maintenance_fixture(
            failure="update", rollback_reset_fails=True
        )

        self.assertNotEqual(0, result.returncode)
        self.assertEqual("rollback-failed", receipt["status"])
        self.assertFalse(any("hermes import --force" in line for line in calls))

    def test_remote_timer_updates_and_self_heals_with_verified_services(self) -> None:
        script = (ROOT / "scripts/orgo-remote-maintenance.sh").read_text(
            encoding="utf-8"
        )
        service = (ROOT / "installer/systemd/orgo-maintenance.service").read_text(
            encoding="utf-8"
        )
        timer = (ROOT / "installer/systemd/orgo-maintenance.timer").read_text(
            encoding="utf-8"
        )

        self.assertIn("flock -n", script)
        self.assertIn("hermes backup", script)
        self.assertNotIn("tar -czf", script)
        self.assertIn("LOG_MAX_BYTES=5242880", script)
        self.assertIn("maintenance.log.1", script)
        self.assertIn("hermes update --check", script)
        self.assertIn("update_args=(--yes --backup)", script)
        self.assertIn("hermes update --help", script)
        self.assertIn("update_args+=(--keep-stash)", script)
        self.assertIn('hermes update "${update_args[@]}"', script)
        self.assertIn("hermes gateway status", script)
        self.assertIn("hermes gateway restart", script)
        self.assertIn("supervisorctl restart", script)
        for server in ("orgo-agent", "orgo", "super-browser"):
            self.assertIn(f"hermes mcp test {server}", script)
        self.assertNotIn("printenv", script)
        self.assertIn("Environment=HERMES_HOME=/root/.hermes", service)
        self.assertIn("ExecStart=/usr/local/sbin/orgo-remote-maintenance", service)
        self.assertIn("OnCalendar=*-*-*", timer)
        self.assertIn("Persistent=true", timer)
        self.assertIn("RandomizedDelaySec", timer)

        loop = (ROOT / "scripts/orgo-maintenance-loop.sh").read_text(encoding="utf-8")
        supervisor = (ROOT / "installer/supervisor/orgo-maintenance.conf").read_text(encoding="utf-8")
        self.assertIn("03:30", loop)
        self.assertIn("orgo-remote-maintenance", loop)
        self.assertIn("[program:orgo-maintenance]", supervisor)
        self.assertIn("autorestart=true", supervisor)


class ProductRenameContractTests(unittest.TestCase):
    def test_public_repository_links_target_renamed_orgo_repo(self) -> None:
        paths = (
            "docs/agent-assisted-setup.md",
            "package.json",
            "apps/desktop/src/app/settings/about-settings.tsx",
        )
        for relative in paths:
            text = (ROOT / relative).read_text(encoding="utf-8")
            self.assertIn("jbellsolutions/orgo-ai-guy-bot", text, relative)
            self.assertNotIn("nickvasilescu/hermes-bots", text, relative)

    def test_public_docs_and_current_ui_use_orgo_ai_guy_bot(self) -> None:
        paths = [
            "README.md",
            "NOTICE.md",
            "SECURITY.md",
            "SUPPORT.md",
            "hermes_cli/orgo_agent_mcp.py",
            "PRIVACY.md",
            "CONTRIBUTING.md",
            "CODE_OF_CONDUCT.md",
            "docs/bot-product-release-scope.md",
            "apps/desktop/README.md",
            "apps/desktop/src/store/updates.ts",
            "apps/desktop/src/app/settings/about-settings.tsx",
            "apps/desktop/electron/main.ts",
        ]
        for relative in paths:
            text = (ROOT / relative).read_text(encoding="utf-8")
            self.assertNotIn("Korgo Bot", text, relative)
            self.assertIn("Orgo AI Guy Bot", text, relative)

        stale_messages = {
            "apps/desktop/src/store/updates.ts": "Pull a reviewed Orgo AI Guy Bot",
            "apps/desktop/src/app/settings/about-settings.tsx": "Update from source with git pull",
            "apps/desktop/electron/main.ts": "Update by pulling a reviewed Orgo AI Guy Bot",
        }
        for relative, stale_message in stale_messages.items():
            text = (ROOT / relative).read_text(encoding="utf-8")
            self.assertIn("maintenance", text.lower(), relative)
            self.assertNotIn(stale_message, text, relative)


if __name__ == "__main__":
    unittest.main()
