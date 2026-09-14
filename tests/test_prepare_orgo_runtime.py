import hashlib
import json
import subprocess
from pathlib import Path

import pytest

from scripts.prepare_orgo_runtime import prepare, sync_prepared


def git(path, *args):
    return subprocess.check_output(["git", "-C", str(path), *args], text=True).strip()


@pytest.fixture
def bundle(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    git(source, "init")
    git(source, "config", "user.name", "Runtime test")
    git(source, "config", "user.email", "runtime-test@example.invalid")
    (source / "sample.txt").write_text("before\n", encoding="utf-8")
    git(source, "add", "sample.txt")
    git(source, "commit", "-m", "fixture")
    patch = tmp_path / "change.patch"
    patch.write_text("--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-before\n+after\n", encoding="utf-8")
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({
        "schema_version": 1, "base_revision": git(source, "rev-parse", "HEAD"),
        "patch": patch.name, "patch_sha256": hashlib.sha256(patch.read_bytes()).hexdigest(),
        "base_files": {"sample.txt": hashlib.sha256(b"before\n").hexdigest()}, "new_files": [],
        "output_files": {"sample.txt": hashlib.sha256(b"after\n").hexdigest()},
    }), encoding="utf-8")
    return source, tmp_path / "prepared", manifest


def test_prepares_committed_snapshot_without_copying_untracked_secrets(bundle):
    source, destination, manifest = bundle
    (source / "private.env").write_text("synthetic-secret", encoding="utf-8")
    receipt = prepare(source, destination, manifest)
    assert (source / "sample.txt").read_text() == "before\n"
    assert (destination / "sample.txt").read_text() == "after\n"
    assert not (destination / "private.env").exists()
    assert not git(source, "status", "--porcelain", "--untracked-files=no")
    assert receipt["state"] == "prepared" and receipt["activated"] is False
    assert json.loads((destination / "orgo-runtime-receipt.json").read_text()) == receipt


@pytest.mark.parametrize("damage", ["dirty", "revision", "checksum", "existing", "inside-source"])
def test_refuses_unsafe_or_mismatched_preparation(bundle, damage):
    source, destination, manifest = bundle
    if damage == "dirty":
        (source / "sample.txt").write_text("user edits\n", encoding="utf-8")
    elif damage == "revision":
        data = json.loads(manifest.read_text())
        data["base_revision"] = "0" * 40
        manifest.write_text(json.dumps(data), encoding="utf-8")
    elif damage == "checksum":
        (manifest.parent / "change.patch").write_text("tampered", encoding="utf-8")
    elif damage == "existing":
        destination.mkdir()
    else:
        destination = source / "nested"
    with pytest.raises(ValueError):
        prepare(source, destination, manifest)
    assert not (destination / "orgo-runtime-receipt.json").exists()
    assert (source / "sample.txt").exists()


def test_failed_dependency_install_does_not_mark_runtime_ready(bundle, monkeypatch):
    source, destination, manifest = bundle
    run = subprocess.run
    monkeypatch.setattr("scripts.prepare_orgo_runtime.shutil.which", lambda name: "test-uv")

    def fail_uv(command, **kwargs):
        if command[0] == "test-uv":
            raise subprocess.CalledProcessError(1, command)
        return run(command, **kwargs)

    monkeypatch.setattr(subprocess, "run", fail_uv)
    with pytest.raises(subprocess.CalledProcessError):
        prepare(source, destination, manifest, sync=True)
    assert json.loads((destination / "orgo-runtime-receipt.json").read_text())["state"] == "prepared"


def test_dependency_resume_refuses_changed_code(bundle):
    source, destination, manifest = bundle
    prepare(source, destination, manifest)
    (destination / "sample.txt").write_text("changed", encoding="utf-8")
    with pytest.raises(ValueError, match="Prepared file changed"):
        sync_prepared(destination, manifest)


def test_missing_uv_bootstraps_only_inside_prepared_runtime(bundle, monkeypatch):
    source, destination, manifest = bundle
    prepare(source, destination, manifest)
    calls = []
    monkeypatch.setattr("scripts.prepare_orgo_runtime.shutil.which", lambda name: None)
    monkeypatch.setattr(subprocess, "run", lambda command, **kwargs: calls.append((command, kwargs)))
    receipt = sync_prepared(destination, manifest, extras=("dev",))
    assert calls[0][0][-1] == str(destination / ".runtime-bootstrap")
    assert calls[1][0][-1].startswith("uv==")
    assert str(destination / ".runtime-bootstrap") in calls[2][0][0]
    assert calls[2][0][1:] == ["sync", "--frozen", "--extra", "dev"]
    assert calls[2][1]["cwd"] == destination
    assert receipt["state"] == "dependencies_ready" and not receipt["activated"]


def test_resume_does_not_reuse_partial_bootstrap_from_another_python(bundle, monkeypatch):
    source, destination, manifest = bundle
    prepare(source, destination, manifest)
    previous = destination / ".runtime-bootstrap"
    previous.mkdir()
    marker = previous / "pyvenv.cfg"
    marker.write_text("home = /synthetic/previous-python\n", encoding="utf-8")
    calls = []
    monkeypatch.setattr("scripts.prepare_orgo_runtime.shutil.which", lambda name: None)

    def record(command, **kwargs):
        calls.append((command, kwargs))
        if command[1:3] == ["-m", "venv"]:
            assert Path(command[-1]) != previous, "Cannot mix Python interpreters in a partial venv"

    monkeypatch.setattr(subprocess, "run", record)
    receipt = sync_prepared(destination, manifest, extras=("dev",))
    fresh = Path(calls[0][0][-1])
    assert fresh.parent == destination and fresh.is_dir()
    assert Path(calls[1][0][0]).is_relative_to(fresh)
    assert Path(calls[2][0][0]).is_relative_to(fresh)
    assert marker.read_text(encoding="utf-8") == "home = /synthetic/previous-python\n"
    assert receipt["state"] == "dependencies_ready" and not receipt["activated"]
