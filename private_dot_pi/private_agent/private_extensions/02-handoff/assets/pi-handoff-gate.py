#!/usr/bin/env python3
"""Pi Handoff remote store. Protocol v2 adds bounded stdin JSON while keeping v1 CLI compatibility."""
import argparse
import base64
import binascii
import fcntl
import hashlib
import json
import os
import secrets
import sys
import time
from pathlib import Path

VERSION = 2
ROOT = Path(os.environ.get("PI_HANDOFF_ROOT", "~/.local/state/pi/remote-sessions")).expanduser()
MAX_PROTOCOL_BYTES = 8 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024


def emit(value):
    print(json.dumps(value, separators=(",", ":"), sort_keys=True))


def fail(message, **details):
    emit({"ok": False, "error": message, **details})
    return 2


def sha(data):
    return hashlib.sha256(data).hexdigest()


def secure(path, directory=False):
    if directory:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        os.chmod(path, 0o700 if directory else 0o600)
    except OSError:
        pass


def safe_id(value):
    if not value or value in (".", "..") or len(value) > 128 or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for character in value):
        raise ValueError("invalid session id")
    return value


def session_dir(session):
    return ROOT / "sessions" / safe_id(session)


def load_json(path, default):
    try:
        with path.open(encoding="utf8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return default
    except json.JSONDecodeError as error:
        raise ValueError(f"invalid JSON state: {path.name}") from error


def write_json(path, value):
    secure(path.parent, True)
    temporary = path.with_name(path.name + "." + secrets.token_hex(8) + ".tmp")
    with open(temporary, "x", encoding="utf8") as handle:
        json.dump(value, handle, sort_keys=True, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    secure(path)


def guarded(session):
    directory = session_dir(session)
    secure(directory, True)
    guard = directory / ".transition.lock"
    handle = open(guard, "a+", encoding="utf8")
    os.chmod(guard, 0o600)
    fcntl.flock(handle, fcntl.LOCK_EX)
    return handle


def manifest(session):
    return load_json(session_dir(session) / "current.json", {"generation": 0, "hash": None, "snapshot": None})


def lock_observation(session):
    try:
        return sha((session_dir(session) / "lock.json").read_bytes())
    except FileNotFoundError:
        return None


def read_lock(session):
    value = load_json(session_dir(session) / "lock.json", None)
    if value is None:
        return None
    if not isinstance(value, dict) or not all(isinstance(value.get(key), str) and value[key] for key in ("nonce", "token", "owner")) or not isinstance(value.get("expiresAt"), (int, float)):
        raise ValueError("recovery-required: invalid lock state")
    return value


def active_lock(session):
    value = read_lock(session)
    if value and value["expiresAt"] <= time.time():
        raise ValueError("recovery-required: lock lease expired")
    return value


def need_lock(session, nonce, token):
    value = active_lock(session)
    if not value or not secrets.compare_digest(value["nonce"], nonce) or not secrets.compare_digest(value["token"], token):
        raise ValueError("lock ownership or lease lost")
    return value


def version(_args):
    emit({"ok": True, "version": VERSION, "checksum": sha(Path(__file__).read_bytes())})


def list_sessions(_args):
    sessions = ROOT / "sessions"
    names = sorted(path.name for path in sessions.iterdir() if path.is_dir() and (path / "current.json").is_file()) if sessions.is_dir() else []
    emit({"ok": True, "sessions": names})


def acquire(args):
    with guarded(args.session):
        try:
            current = active_lock(args.session)
        except ValueError as error:
            return fail(str(error), recoveryRequired=True, recoveryToken=lock_observation(args.session))
        if current:
            return fail("session is locked")
        value = {
            "owner": args.owner,
            "nonce": secrets.token_hex(16),
            "token": secrets.token_hex(16),
            "fence": secrets.token_hex(16),
            "expiresAt": time.time() + args.lease,
        }
        write_json(session_dir(args.session) / "lock.json", value)
        emit({"ok": True, **value})


def renew(args):
    with guarded(args.session):
        try:
            value = need_lock(args.session, args.nonce, args.token)
            value["expiresAt"] = time.time() + args.lease
            write_json(session_dir(args.session) / "lock.json", value)
            emit({"ok": True, **value})
        except ValueError as error:
            return fail(str(error))


def release(args):
    with guarded(args.session):
        try:
            need_lock(args.session, args.nonce, args.token)
            (session_dir(args.session) / "lock.json").unlink(missing_ok=True)
            emit({"ok": True})
        except ValueError as error:
            return fail(str(error))


def recover(args):
    with guarded(args.session):
        observed = lock_observation(args.session)
        if observed is None:
            emit({"ok": True})
            return
        if not args.token or not secrets.compare_digest(observed, args.token):
            return fail("recovery confirmation does not match observed lock state")
        try:
            value = read_lock(args.session)
            if value and value["expiresAt"] > time.time():
                return fail("active lock")
        except ValueError:
            pass
        (session_dir(args.session) / "lock.json").unlink(missing_ok=True)
        emit({"ok": True})


def fetch(args):
    current = manifest(args.session)
    if not current["snapshot"]:
        return fail("no snapshot")
    data = (session_dir(args.session) / "snapshots" / current["snapshot"]).read_bytes()
    if sha(data) != current["hash"]:
        return fail("snapshot hash mismatch")
    emit({"ok": True, "manifest": current, "jsonl": data.decode("utf8")})


def commit(args):
    with guarded(args.session):
        try:
            owned = need_lock(args.session, args.nonce, args.token)
            current = manifest(args.session)
            expected = args.expected_hash if args.expected_hash != "" else None
            if current["generation"] != args.generation or current["hash"] != expected:
                return fail("generation or hash conflict")
            data = args.data if hasattr(args, "data") else sys.stdin.buffer.read()
            if len(data) > MAX_SNAPSHOT_BYTES:
                return fail("snapshot exceeds limit")
            if sha(data) != args.hash:
                return fail("submitted hash mismatch")
            for line in data.splitlines():
                if line.strip():
                    json.loads(line)
            snapshots = session_dir(args.session) / "snapshots"
            secure(snapshots, True)
            name = f"{current['generation'] + 1}-{args.hash}.jsonl"
            temporary = snapshots / (name + ".tmp")
            with open(temporary, "xb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, snapshots / name)
            secure(snapshots / name)
            next_manifest = {"generation": current["generation"] + 1, "hash": args.hash, "snapshot": name, "fence": owned["fence"]}
            write_json(session_dir(args.session) / "current.json", next_manifest)
            emit({"ok": True, "manifest": next_manifest})
        except (ValueError, json.JSONDecodeError) as error:
            return fail(str(error))


def make_parser():
    parser = argparse.ArgumentParser()
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("version").set_defaults(fn=version)
    subcommands.add_parser("list-sessions").set_defaults(fn=list_sessions)
    for name, handler in (("acquire-lock", acquire), ("renew-lock", renew), ("release-lock", release), ("recover-lock", recover), ("fetch-manifest", fetch), ("commit", commit)):
        command = subcommands.add_parser(name)
        command.set_defaults(fn=handler)
        command.add_argument("session")
        if name == "acquire-lock":
            command.add_argument("--owner", required=True)
            command.add_argument("--lease", type=int, default=60)
        if name == "renew-lock":
            command.add_argument("--nonce", required=True)
            command.add_argument("--token", required=True)
            command.add_argument("--lease", type=int, default=60)
        if name == "release-lock":
            command.add_argument("--nonce", required=True)
            command.add_argument("--token", required=True)
        if name == "recover-lock":
            command.add_argument("--token", required=True)
        if name == "commit":
            command.add_argument("--nonce", required=True)
            command.add_argument("--token", required=True)
            command.add_argument("--generation", type=int, required=True)
            command.add_argument("--expected-hash", default="")
            command.add_argument("--hash", required=True)
    return parser


def dispatch(command, values, data=b""):
    try:
        args = make_parser().parse_args([command, *values])
    except SystemExit as error:
        raise ValueError("invalid command arguments") from error
    args.data = data
    return args.fn(args)


def stdio():
    raw = sys.stdin.buffer.read(MAX_PROTOCOL_BYTES + 1)
    if len(raw) > MAX_PROTOCOL_BYTES:
        return fail("request exceeds limit")
    try:
        request = json.loads(raw)
        if not isinstance(request, dict) or set(request) - {"version", "command", "args", "dataBase64"}:
            raise ValueError("invalid request shape")
        if request.get("version") != VERSION or not isinstance(request.get("command"), str):
            raise ValueError("invalid protocol version or command")
        values = request.get("args", [])
        if not isinstance(values, list) or len(values) > 32 or not all(isinstance(value, str) and len(value) <= 4096 and "\0" not in value for value in values):
            raise ValueError("invalid arguments")
        encoded = request.get("dataBase64", "")
        if not isinstance(encoded, str):
            raise ValueError("invalid data")
        data = base64.b64decode(encoded, validate=True) if encoded else b""
        return dispatch(request["command"], values, data)
    except (ValueError, binascii.Error, json.JSONDecodeError):
        return fail("invalid protocol request")


if __name__ == "__main__":
    os.umask(0o077)
    secure(ROOT, True)
    if len(sys.argv) == 2 and sys.argv[1] == "--stdio":
        sys.exit(stdio() or 0)
    arguments = make_parser().parse_args()
    try:
        sys.exit(arguments.fn(arguments) or 0)
    except (ValueError, OSError) as error:
        sys.exit(fail(str(error)))
