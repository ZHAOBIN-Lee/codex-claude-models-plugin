#!/usr/bin/env python3
"""Enter an Anthropic API credential locally without command-line or environment secrets."""

import argparse
import getpass
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import warnings


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse normally echoes unknown arguments, which might contain an accidentally pasted key.
        self.exit(2, "Invalid command-line options. Use --help; enter API keys only at the hidden prompt.\n")


def private_path(target, directory=False):
    info = target.lstat()
    expected = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    mode = 0o700 if directory else 0o600
    if not expected or stat.S_IMODE(info.st_mode) != mode or (hasattr(os, "getuid") and info.st_uid != os.getuid()):
        raise ValueError("The API credential destination must be private, owned by you, and not a symlink.")


def create_private_directory(root):
    current = Path(root.anchor)
    for part in root.parts[1:]:
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            try:
                current.mkdir(mode=0o700)
            except FileExistsError:
                pass
            info = current.lstat()
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError("The credential path must not contain symlink ancestors.")
    private_path(root, directory=True)


def save_credentials(codex_home, api_key, workspace_id=None):
    if not isinstance(api_key, str) or not 16 <= len(api_key) <= 1024 or not re.fullmatch(r"[A-Za-z0-9_-]+", api_key):
        raise ValueError("Invalid API key format; no credential was saved.")
    if workspace_id is not None and (not isinstance(workspace_id, str) or not re.fullmatch(r"wrkspc_[A-Za-z0-9_-]{1,200}", workspace_id)):
        raise ValueError("Invalid workspace ID format; no credential was saved.")
    home = Path(os.path.abspath(os.path.expanduser(codex_home)))
    root = home / "claude-models" / "api"
    create_private_directory(root)
    destination = root / "credentials.json"
    if os.path.lexists(destination):
        private_path(destination)
    payload = {"schema_version": 1, "api_key": api_key}
    if workspace_id is not None:
        payload["workspace_id"] = workspace_id
    fd, temporary = tempfile.mkstemp(prefix=".credentials-", suffix=".tmp", dir=root)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(payload, stream, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
        directory_fd = os.open(root, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = SafeArgumentParser(description="Save a private Anthropic API key; does not enable paid fallback or make network requests.")
    parser.add_argument("--codex-home", default=os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
    parser.add_argument("--workspace-id", help="Optional Anthropic workspace ID (not an API key)")
    args = parser.parse_args()
    if not sys.stdin.isatty():
        parser.exit(1, "Use an interactive terminal: API keys are accepted only through a hidden prompt.\n")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            api_key = getpass.getpass("Anthropic API key (hidden): ")
        save_credentials(args.codex_home, api_key, args.workspace_id)
    except (OSError, ValueError, EOFError, getpass.GetPassWarning):
        parser.exit(1, "Credential entry failed. Check the hidden input and the private destination permissions; no key is printed.\n")
    except KeyboardInterrupt:
        parser.exit(130, "Credential entry cancelled.\n")
    print("Private credentials saved. This does not enable paid fallback. Run api-status to inspect its separate configuration.")


if __name__ == "__main__":
    main()
