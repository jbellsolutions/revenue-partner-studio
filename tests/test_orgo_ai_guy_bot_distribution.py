from pathlib import Path
import json
import os
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
KIT = ROOT / "installer"
PUBLIC_ENTRY_FILES = [
    ROOT / "README.md",
    ROOT / "docs" / "agent-assisted-setup.md",
    ROOT / "scripts" / "setup-hermes-bots.sh",
]


def test_public_entry_points_use_authoritative_product_name():
    for path in PUBLIC_ENTRY_FILES:
        text = path.read_text(encoding="utf-8")
        assert "Orgo AI Guy Bot" in text, path
        assert "Korgo Bot" not in text, path
        assert "Oorgo AI Guy Bot" not in text, path


def test_ai_installer_kit_has_beginner_and_agent_entry_points():
    expected = {
        "START-HERE.md",
        "INSTALL-WITH-AI.md",
        "FOR-HERMES.md",
        "FOR-CLAUDE-CODE.md",
        "CODEX.md",
        "install.sh",
        "manifest.json",
    }
    assert expected == {path.name for path in KIT.iterdir() if path.is_file()}

    start = (KIT / "START-HERE.md").read_text(encoding="utf-8")
    contract = (KIT / "INSTALL-WITH-AI.md").read_text(encoding="utf-8")
    for text in (start, contract):
        assert "Orgo AI Guy Bot" in text
        assert "https://github.com/jbellsolutions/orgo-ai-guy-bot" in text

    for agent_file in ("FOR-HERMES.md", "FOR-CLAUDE-CODE.md", "CODEX.md"):
        agent_text = (KIT / agent_file).read_text(encoding="utf-8")
        assert "INSTALL-WITH-AI.md" in agent_text
        assert "Do not ask the user to run terminal commands" in agent_text


def test_packaged_app_carries_signed_bootstrap_installers():
    package = json.loads((ROOT / "apps/desktop/package.json").read_text(encoding="utf-8"))
    resources = package["build"]["extraResources"]
    destinations = {entry.get("to") for entry in resources}
    assert "bootstrap/install.sh" in destinations
    assert "bootstrap/install.ps1" in destinations


def test_installer_targets_existing_system_app_before_user_fallback():
    text = (KIT / "install.sh").read_text(encoding="utf-8")
    assert 'SYSTEM_APP="/Applications/Orgo AI Guy Bot.app"' in text
    assert '[[ -d "$SYSTEM_APP" || -w /Applications ]]' in text
    assert '$HOME/Applications' in text


def test_installer_discovers_one_architecture_neutral_app_artifact(tmp_path):
    script = (KIT / "install.sh").read_text(encoding="utf-8")
    function = re.search(r"^discover_source_app\(\) \{.*?^\}", script, re.MULTILINE | re.DOTALL)
    assert function, "installer must expose executable artifact-discovery logic"
    assert "release/mac-arm64" not in script

    release = tmp_path / "release"

    def discover():
        return subprocess.run(
            [
                "bash",
                "-c",
                f'PRODUCT="Orgo AI Guy Bot"\n{function.group(0)}\ndiscover_source_app "$1"',
                "artifact-discovery-test",
                str(release),
            ],
            capture_output=True,
            text=True,
        )

    x64_app = release / "mac" / "Orgo AI Guy Bot.app"
    x64_app.mkdir(parents=True)
    result = discover()
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == str(x64_app)

    x64_app.rmdir()
    result = discover()
    assert result.returncode == 8
    assert "found 0" in result.stderr

    arm64_app = release / "mac-arm64" / "Orgo AI Guy Bot.app"
    arm64_app.mkdir(parents=True)
    result = discover()
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == str(arm64_app)

    x64_app.mkdir()
    result = discover()
    assert result.returncode == 8
    assert "found 2" in result.stderr


def test_bootstrap_script_is_syntax_valid_and_exposes_safe_modes():
    script = KIT / "install.sh"
    result = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr

    text = script.read_text(encoding="utf-8")
    for required in (
        "--check",
        "--dry-run",
        "--yes",
        "pull --ff-only",
        "status --porcelain",
        "./scripts/setup-hermes-bots.sh --verify",
        "Orgo AI Guy Bot.app",
    ):
        assert required in text
    assert "rm -rf" not in text
    assert "sudo" not in text


def test_multi_instance_launcher_is_safe_and_installed(tmp_path):
    launcher = ROOT / "scripts" / "orgo-ai-guy-bot"
    result = subprocess.run(["bash", "-n", str(launcher)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr

    text = launcher.read_text(encoding="utf-8")
    assert "--orgo-instance=" in text
    assert "/usr/bin/open -na" in text
    assert "^[a-z0-9][a-z0-9_-]{0,63}$" in text

    fake_app = tmp_path / "Orgo AI Guy Bot.app"
    fake_app.mkdir()
    invalid = subprocess.run(
        ["bash", str(launcher), "../escape"],
        capture_output=True,
        text=True,
        env={**os.environ, "ORGO_AI_GUY_BOT_APP": str(fake_app)},
        check=False,
    )
    assert invalid.returncode == 2
    assert "Instance names must use" in invalid.stderr

    installer = (KIT / "install.sh").read_text(encoding="utf-8")
    assert 'LAUNCHER_DEST="$LAUNCHER_DIR/orgo-ai-guy-bot"' in installer
    assert 'install -m 0755 "$CHECKOUT/scripts/orgo-ai-guy-bot" "$LAUNCHER_DEST"' in installer


def test_installer_reuses_its_own_checkout_and_verifies_the_launched_process():
    text = (KIT / "install.sh").read_text(encoding="utf-8")
    assert 'SCRIPT_REPO=' in text
    assert 'CHECKOUT="$SCRIPT_REPO"' in text
    assert 'stop_installed_app' in text
    assert 'installed_app_is_healthy' in text
    assert 'did not stay running' in text
    assert 'after_log_state" != "$before_log_state' in text
    assert 'pgrep -f "^$executable$"' in text


def test_installer_restores_existing_app_when_post_backup_install_fails(tmp_path):
    if sys.platform != "darwin":
        return

    checkout = tmp_path / "checkout"
    (checkout / ".git").mkdir(parents=True)
    scripts = checkout / "scripts"
    scripts.mkdir()
    setup = scripts / "setup-hermes-bots.sh"
    setup.write_text("#!/bin/bash\nexit 0\n", encoding="utf-8")
    setup.chmod(0o755)

    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    dispatcher = fake_bin / "fixture"
    dispatcher.write_text(
        """#!/bin/bash
name="$(basename "$0")"
case "$name" in
  uname) printf 'Darwin\\n' ;;
  node) printf '22.22.0\\n' ;;
  git)
    [[ "$*" == *"remote get-url origin"* ]] && printf 'https://github.com/jbellsolutions/orgo-ai-guy-bot.git\\n'
    exit 0
    ;;
  npm)
    mkdir -p "$ORGO_AI_GUY_BOT_HOME/apps/desktop/release/mac-arm64/Orgo AI Guy Bot.app"
    ;;
  uv|uvx) exit 0 ;;
esac
""",
        encoding="utf-8",
    )
    dispatcher.chmod(0o755)
    for name in ("uname", "node", "git", "npm", "uv", "uvx"):
        (fake_bin / name).symlink_to(dispatcher)

    applications = tmp_path / "Applications"
    installed = applications / "Orgo AI Guy Bot.app"
    installed.mkdir(parents=True)
    (installed / "old-version.txt").write_text("old\n", encoding="utf-8")
    env = {
        **os.environ,
        "PATH": f"{fake_bin}:/usr/bin:/bin",
        "ORGO_AI_GUY_BOT_HOME": str(checkout),
        "ORGO_AI_GUY_BOT_APPLICATIONS_DIR": str(applications),
    }

    result = subprocess.run(
        ["bash", str(KIT / "install.sh"), "--yes"],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )

    assert result.returncode != 0
    assert (installed / "old-version.txt").read_text(encoding="utf-8") == "old\n"
    assert not list(applications.glob("Orgo AI Guy Bot.app.backup.*"))


def test_restore_keeps_backup_separate_when_failed_replacement_cannot_be_quarantined(tmp_path):
    text = (KIT / "install.sh").read_text(encoding="utf-8")
    function = re.search(r"restore_previous_app\(\) \{.*?^\}", text, flags=re.MULTILINE | re.DOTALL)
    assert function is not None

    destination = tmp_path / "Orgo AI Guy Bot.app"
    backup = tmp_path / "Orgo AI Guy Bot.app.backup.fixture"
    destination.mkdir()
    backup.mkdir()
    (backup / "old-version.txt").write_text("old\n", encoding="utf-8")

    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_mv = fake_bin / "mv"
    fake_mv.write_text(
        """#!/bin/bash
if [[ "$1" == "$FAIL_SOURCE" ]]; then
  exit 73
fi
exec /bin/mv "$@"
""",
        encoding="utf-8",
    )
    fake_mv.chmod(0o755)

    script = f"""set -u
PRODUCT='Orgo AI Guy Bot'
INSTALL_ROOT="$3"
DEST="$1"
backup="$2"
install_complete=false
{function.group(0)}
false
restore_previous_app
"""
    result = subprocess.run(
        [
            "bash",
            "-c",
            script,
            "rollback-quarantine-test",
            str(destination),
            str(backup),
            str(tmp_path),
        ],
        capture_output=True,
        text=True,
        env={
            **os.environ,
            "PATH": f"{fake_bin}:/usr/bin:/bin",
            "FAIL_SOURCE": str(destination),
        },
        check=False,
    )

    assert result.returncode != 0
    assert destination.is_dir()
    assert backup.is_dir()
    assert (backup / "old-version.txt").read_text(encoding="utf-8") == "old\n"
    assert not (destination / backup.name).exists()


def test_installer_kit_contains_no_embedded_secret_values():
    combined = "\n".join(path.read_text(encoding="utf-8") for path in KIT.iterdir() if path.is_file())
    forbidden_fragments = ("ghp_", "github_pat_", "sk-", "Bearer ", "SUPER_BROWSER_INVITE_CODE=")
    for fragment in forbidden_fragments:
        assert fragment not in combined
