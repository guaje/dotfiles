#!/usr/bin/env python3
"""Pi Handoff remote store. Standard-library-only, JSON-lines protocol."""
import argparse, hashlib, json, os, secrets, shutil, stat, sys, tempfile, time
from pathlib import Path

VERSION = 1
ROOT = Path(os.environ.get("PI_HANDOFF_ROOT", "~/.local/state/pi/remote-sessions")).expanduser()

def fail(message): print(json.dumps({"ok": False, "error": message}, separators=(",", ":"))); return 2
def sha(data): return hashlib.sha256(data).hexdigest()
def secure(path, directory=False):
    path.mkdir(mode=0o700, parents=True, exist_ok=True) if directory else None
    try: os.chmod(path, 0o700 if directory else 0o600)
    except OSError: pass
def safe_id(value):
    if not value or value in (".", "..") or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for c in value): raise ValueError("invalid session id")
    return value
def session_dir(sid): return ROOT / "sessions" / safe_id(sid)
def output(value): print(json.dumps({"ok": True, **value}, separators=(",", ":"), sort_keys=True))
def load_json(path, default):
    try:
        with path.open(encoding="utf8") as f: return json.load(f)
    except FileNotFoundError: return default
def write_json(path, data):
    secure(path.parent, True); tmp = path.with_name(path.name + "." + secrets.token_hex(8) + ".tmp")
    with open(tmp, "x", encoding="utf8") as f: json.dump(data, f, sort_keys=True, separators=(",", ":")); f.write("\n"); f.flush(); os.fsync(f.fileno())
    os.replace(tmp, path); secure(path)
def manifest(sid): return load_json(session_dir(sid) / "current.json", {"generation": 0, "hash": None, "snapshot": None})
def lock(sid): return load_json(session_dir(sid) / "lock.json", None)
def active_lock(sid):
    value = lock(sid)
    if value and value["expiresAt"] <= time.time(): (session_dir(sid) / "lock.json").unlink(missing_ok=True); return None
    return value
def need_lock(sid, nonce, token):
    value = active_lock(sid)
    if not value or value.get("nonce") != nonce or value.get("token") != token: raise ValueError("lock ownership or lease lost")
    return value
def version(_): output({"version": VERSION, "checksum": sha(Path(__file__).read_bytes())})
def home(_): output({"home": str(Path.home()), "root": str(ROOT)})
def list_workspaces(_): output({"workspaces": [str(Path.home())]})
def list_sessions(_):
    base = ROOT / "sessions"; secure(base, True); output({"sessions": sorted(p.name for p in base.iterdir() if p.is_dir())})
def acquire(args):
    sid = args.session; d = session_dir(sid); secure(d, True); value = active_lock(sid)
    if value: return fail("session is locked")
    value = {"owner": args.owner, "nonce": secrets.token_hex(16), "token": secrets.token_hex(16), "fence": secrets.token_hex(16), "expiresAt": time.time()+args.lease}
    # Atomic mkdir is the lock primitive; recover stale abandoned directory first.
    lockdir = d / ".lock";
    try: lockdir.mkdir(mode=0o700)
    except FileExistsError: return fail("session is locked")
    write_json(d / "lock.json", value); output(value)
def renew(args):
    try: value = need_lock(args.session, args.nonce, args.token); value["expiresAt"] = time.time()+args.lease; write_json(session_dir(args.session)/"lock.json", value); output(value)
    except ValueError as e: return fail(str(e))
def fetch(args):
    m = manifest(args.session)
    if not m["snapshot"]: return fail("no snapshot")
    data = (session_dir(args.session)/"snapshots"/m["snapshot"]).read_bytes()
    if sha(data) != m["hash"]: return fail("snapshot hash mismatch")
    output({"manifest":m,"jsonl":data.decode("utf8")})
def commit(args):
    try:
        value = need_lock(args.session,args.nonce,args.token); d=session_dir(args.session); current=manifest(args.session)
        expected_hash = args.expected_hash if args.expected_hash != "" else None
        if current["generation"] != args.generation or current["hash"] != expected_hash: return fail("generation or hash conflict")
        data=sys.stdin.buffer.read(); actual=sha(data)
        if actual != args.hash: return fail("submitted hash mismatch")
        # Validate UTF-8 JSONL before promotion; each nonblank record must be JSON.
        for line in data.splitlines():
            if line.strip(): json.loads(line)
        snaps=d/"snapshots"; secure(snaps,True); name=f"{current['generation']+1}-{actual}.jsonl"; tmp=snaps/(name+".tmp")
        with open(tmp,"xb") as f: f.write(data); f.flush(); os.fsync(f.fileno())
        os.replace(tmp,snaps/name); secure(snaps/name)
        next_m={"generation":current["generation"]+1,"hash":actual,"snapshot":name,"fence":value["fence"]}; write_json(d/"current.json",next_m)
        for old in sorted(snaps.glob("*.jsonl"))[:-5]: old.unlink(missing_ok=True)
        output({"manifest":next_m})
    except (ValueError,json.JSONDecodeError) as e: return fail(str(e))
def release(args):
    try: need_lock(args.session,args.nonce,args.token); (session_dir(args.session)/"lock.json").unlink(missing_ok=True); (session_dir(args.session)/".lock").rmdir(); output({})
    except (ValueError,OSError) as e: return fail(str(e))
def recover(args):
    value=active_lock(args.session)
    if value: return fail("active lock")
    d=session_dir(args.session); (d/"lock.json").unlink(missing_ok=True)
    try: (d/".lock").rmdir()
    except OSError: pass
    output({})
def main():
    os.umask(0o077); secure(ROOT,True); p=argparse.ArgumentParser(); sub=p.add_subparsers(dest="command",required=True)
    sub.add_parser("version").set_defaults(fn=version); sub.add_parser("home").set_defaults(fn=home); sub.add_parser("list-workspaces").set_defaults(fn=list_workspaces); sub.add_parser("list-sessions").set_defaults(fn=list_sessions)
    for name, fn in [("acquire-lock",acquire),("renew-lock",renew),("release-lock",release),("recover-lock",recover),("fetch-manifest",fetch),("commit",commit)]:
        q=sub.add_parser(name); q.set_defaults(fn=fn); q.add_argument("session")
        if name in ("acquire-lock",): q.add_argument("--owner",required=True); q.add_argument("--lease",type=int,default=60)
        if name in ("renew-lock",): q.add_argument("--nonce",required=True); q.add_argument("--token",required=True); q.add_argument("--lease",type=int,default=60)
        if name in ("release-lock",): q.add_argument("--nonce",required=True); q.add_argument("--token",required=True)
        if name=="commit": q.add_argument("--nonce",required=True); q.add_argument("--token",required=True); q.add_argument("--generation",type=int,required=True); q.add_argument("--expected-hash"); q.add_argument("--hash",required=True)
    args=p.parse_args()
    try: result=args.fn(args); return result or 0
    except (ValueError, OSError) as error: return fail(str(error))
if __name__=="__main__": sys.exit(main())
