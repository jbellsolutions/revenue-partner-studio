#!/usr/bin/env python3
"""Prepare a pinned side-by-side Hermes runtime; never switch or restart it.

Only committed source is archived, into a new directory outside the source
checkout. No profile config, credentials, histories, services or installed app
are read or changed. Failed destinations are retained for diagnosis, not reused.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

DEFAULT_MANIFEST = Path(__file__).parent / "runtime_overlays" / "63279301-autonomous-release.json"
BOOTSTRAP_UV_VERSION = "0.12.7"


def _git(source: Path, *args: str) -> str:
    return subprocess.check_output(
        ["git", "-C", str(source), *args], text=True, encoding="utf-8", errors="replace",
    ).strip()


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _child(root: Path, relative: str) -> Path:
    path = root / relative
    if Path(relative).is_absolute() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("Bundle path escapes its root")
    return path


def sync_prepared(destination: Path, manifest_path: Path = DEFAULT_MANIFEST,
                  *, extras: tuple[str, ...] = ()) -> dict:
    """Resume only the dependency stage of a verified, unactivated snapshot."""
    destination = destination.resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    receipt_path = _child(destination, "orgo-runtime-receipt.json")
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if (receipt.get("state") not in {"prepared", "dependencies_ready"}
            or receipt.get("activated") is not False
            or receipt.get("destination") != str(destination)
            or receipt.get("base_revision") != manifest["base_revision"]
            or receipt.get("overlay_sha256") != manifest["patch_sha256"]):
        raise ValueError("Destination is not this unactivated prepared runtime")
    if not manifest.get("output_files"):
        raise ValueError("Overlay has no output checksums for dependency resume")
    for name, digest in manifest["output_files"].items():
        if _digest(_child(destination, name)) != digest:
            raise ValueError(f"Prepared file changed: {name}")
    for name in (".venv", ".runtime-bootstrap"):
        if _child(destination, name).is_symlink():
            raise ValueError("Runtime virtual environments must not be symlinks")
    executable = shutil.which("uv")
    if executable is None:
        # Keep bootstrap tooling inside this new runtime, never install into
        # the machine's Python or the live Hermes virtual environment.
        bootstrap = destination / ".runtime-bootstrap"
        if bootstrap.exists():
            # A failed venv can retain another interpreter's bin/python even
            # when retried with a working Python. Preserve that attempt; never
            # merge interpreters or delete diagnostic evidence on resume.
            bootstrap = Path(tempfile.mkdtemp(prefix=".runtime-bootstrap-retry-", dir=destination))
        binaries = bootstrap / ("Scripts" if os.name == "nt" else "bin")
        python = binaries / ("python.exe" if os.name == "nt" else "python")
        subprocess.run([sys.executable, "-m", "venv", str(bootstrap)], check=True)
        subprocess.run([str(python), "-m", "pip", "install", f"uv=={BOOTSTRAP_UV_VERSION}"], check=True)
        executable = str(binaries / ("uv.exe" if os.name == "nt" else "uv"))
    command = [executable, "sync", "--frozen"]
    for extra in extras:
        command.extend(["--extra", extra])
    subprocess.run(command, cwd=destination, check=True)
    receipt["state"] = "dependencies_ready"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return receipt


def prepare(source: Path, destination: Path, manifest_path: Path = DEFAULT_MANIFEST,
            *, sync: bool = False, extras: tuple[str, ...] = ()) -> dict:
    if destination.is_symlink():
        raise ValueError("Destination must not be a symlink")
    source, destination = source.resolve(), destination.resolve()
    if destination.exists() or destination.is_relative_to(source):
        raise ValueError("Destination must be new and outside the source checkout")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema_version") != 1:
        raise ValueError("Unsupported runtime overlay schema")
    if _git(source, "rev-parse", "HEAD") != manifest["base_revision"]:
        raise ValueError("Source revision does not match this tested overlay")
    if _git(source, "status", "--porcelain", "--untracked-files=no"):
        raise ValueError("Source checkout has tracked changes; left untouched")
    patch = _child(manifest_path.parent, manifest["patch"])
    if _digest(patch) != manifest["patch_sha256"]:
        raise ValueError("Overlay checksum mismatch")
    for name, digest in manifest["base_files"].items():
        if _digest(_child(source, name)) != digest:
            raise ValueError(f"Source file checksum mismatch: {name}")
    for name in manifest["new_files"]:
        if _child(source, name).exists():
            raise ValueError(f"Overlay would replace an existing file: {name}")

    # No shell, no git hooks, no worktree metadata edits in the live source.
    # The archive is pinned to the verified commit, not a changing HEAD.
    with tempfile.TemporaryFile() as archive:
        subprocess.run(
            ["git", "-C", str(source), "archive", "--format=tar", manifest["base_revision"]],
            stdout=archive, check=True,
        )
        archive.seek(0)
        destination.mkdir(parents=True, exist_ok=False)
        with tarfile.open(fileobj=archive) as contents:
            contents.extractall(destination, filter="data")
    subprocess.run(["git", "-C", str(destination), "apply", "--check", str(patch.resolve())], check=True)
    subprocess.run(["git", "-C", str(destination), "apply", str(patch.resolve())], check=True)
    receipt = {
        "schema_version": 1,
        "state": "prepared",
        "base_revision": manifest["base_revision"],
        "overlay_sha256": manifest["patch_sha256"],
        "destination": str(destination),
        "activated": False,
    }
    receipt_path = destination / "orgo-runtime-receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    if sync:
        return sync_prepared(destination, manifest_path, extras=extras)
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--sync", action="store_true", help="Install this revision's locked dependencies with uv")
    parser.add_argument("--resume-dependencies", action="store_true", help="Resume dependency installation after verifying the prepared snapshot")
    parser.add_argument("--extra", action="append", default=[], help="Optional locked dependency extra (requires --sync)")
    args = parser.parse_args()
    if args.extra and not (args.sync or args.resume_dependencies):
        parser.error("--extra requires --sync")
    try:
        if args.resume_dependencies:
            result = sync_prepared(args.destination, extras=tuple(args.extra))
        else:
            result = prepare(args.source, args.destination, sync=args.sync, extras=tuple(args.extra))
    except (ValueError, OSError, subprocess.CalledProcessError, tarfile.TarError) as exc:
        parser.exit(1, f"Runtime preparation failed; source unchanged: {exc}\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
