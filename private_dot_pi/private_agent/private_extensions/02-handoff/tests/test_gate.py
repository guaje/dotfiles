import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HELPER = Path(__file__).parents[1] / "assets" / "pi-handoff-gate.py"
VECTORS = Path(__file__).parents[1] / "assets" / "protocol-test-vectors.json"


class GateTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.root.cleanup()

    def call(self, *args, data=b""):
        env = {**os.environ, "PI_HANDOFF_ROOT": self.root.name}
        process = subprocess.run([sys.executable, str(HELPER), *args], input=data, capture_output=True, env=env, check=False)
        return process.returncode, json.loads(process.stdout)

    def stdio(self, request):
        return self.call("--stdio", data=json.dumps(request).encode())

    def test_version_and_locked_cas_commit(self):
        code, value = self.call("version")
        self.assertEqual(code, 0)
        self.assertEqual(value["version"], 3)
        self.assertEqual(value["checksum"], hashlib.sha256(HELPER.read_bytes()).hexdigest())
        self.assertEqual(value["limits"]["protocol"], [2, 3])
        self.assertGreater(value["limits"]["snapshotBytes"], value["limits"]["chunkBytes"])
        code, lock = self.call("acquire-lock", "session", "--owner", "test")
        self.assertEqual(code, 0)
        data = b'{"type":"session"}\n'
        digest = hashlib.sha256(data).hexdigest()
        code, committed = self.call("commit", "session", "--nonce", lock["nonce"], "--token", lock["token"], "--generation", "0", "--hash", digest, data=data)
        self.assertEqual(code, 0)
        self.assertEqual(committed["manifest"]["generation"], 1)
        code, fetched = self.call("fetch-manifest", "session")
        self.assertEqual(code, 0)
        self.assertEqual(fetched["jsonl"], data.decode())
        code, conflict = self.call("commit", "session", "--nonce", lock["nonce"], "--token", lock["token"], "--generation", "0", "--hash", digest, data=data)
        self.assertEqual(code, 2)
        self.assertFalse(conflict["ok"])

    def test_expired_lock_requires_matching_explicit_recovery(self):
        _code, lock = self.call("acquire-lock", "stale", "--owner", "test")
        lock_path = Path(self.root.name) / "sessions" / "stale" / "lock.json"
        state = json.loads(lock_path.read_text())
        state["expiresAt"] = 0
        lock_path.write_text(json.dumps(state))
        code, blocked = self.call("acquire-lock", "stale", "--owner", "other")
        self.assertEqual(code, 2)
        self.assertTrue(blocked["recoveryRequired"])
        self.assertTrue(lock_path.exists())
        code, wrong = self.call("recover-lock", "stale", "--token", "wrong")
        self.assertEqual(code, 2)
        self.assertTrue(lock_path.exists())
        code, recovered = self.call("recover-lock", "stale", "--token", blocked["recoveryToken"])
        self.assertEqual(code, 0)
        self.assertFalse(lock_path.exists())
        code, reacquired = self.call("acquire-lock", "stale", "--owner", "other")
        self.assertEqual(code, 0)
        self.assertNotEqual(reacquired["token"], lock["token"])

    def test_malformed_lock_requires_matching_state_recovery(self):
        directory = Path(self.root.name) / "sessions" / "malformed"
        directory.mkdir(parents=True)
        lock_path = directory / "lock.json"
        lock_path.write_text("not-json")
        code, blocked = self.call("acquire-lock", "malformed", "--owner", "test")
        self.assertEqual(code, 2)
        self.assertTrue(blocked["recoveryRequired"])
        code, recovered = self.call("recover-lock", "malformed", "--token", blocked["recoveryToken"])
        self.assertEqual(code, 0)
        self.assertFalse(lock_path.exists())

    def test_wrong_owner_cannot_release(self):
        _code, lock = self.call("acquire-lock", "owned", "--owner", "test")
        code, value = self.call("release-lock", "owned", "--nonce", lock["nonce"], "--token", "wrong")
        self.assertEqual(code, 2)
        self.assertFalse(value["ok"])

    def test_stdio_and_shared_vectors(self):
        vectors = json.loads(VECTORS.read_text())
        for request in vectors["validRequests"]:
            code, value = self.stdio(request)
            if request["command"] in ("version", "list-sessions", "acquire-lock"):
                self.assertIn("ok", value)
                self.assertIn(code, (0, 2))
        data = b'{"type":"session"}\n'
        code, value = self.stdio({"version": 2, "command": "version", "dataBase64": base64.b64encode(data).decode()})
        self.assertEqual(code, 0)
        self.assertTrue(value["ok"])
        code, modern = self.stdio({"version": 3, "command": "version"})
        self.assertEqual(code, 0)
        self.assertEqual(modern["limits"]["chunkBytes"], 2 * 1024 * 1024)
        for request in vectors["invalidRequests"]:
            code, value = self.stdio(request)
            self.assertEqual(code, 2)
            self.assertFalse(value["ok"])

    def lock_args(self, session):
        code, lock = self.call("acquire-lock", session, "--owner", "test")
        self.assertEqual(code, 0)
        return ["--nonce", lock["nonce"], "--token", lock["token"]]

    def stage(self, session, args, data, chunk_bytes):
        digest = hashlib.sha256(data).hexdigest()
        code, begun = self.call("begin-upload", session, *args, "--total-bytes", str(len(data)), "--chunk-bytes", str(chunk_bytes), "--sha256", digest)
        self.assertEqual(code, 0, begun)
        upload = begun["upload"]["id"]
        for index in range(0, max(1, -(-len(data) // chunk_bytes))):
            chunk = data[index * chunk_bytes:(index + 1) * chunk_bytes]
            code, stored = self.call("put-chunk", session, *args, "--upload", upload, "--index", str(index), "--sha256", hashlib.sha256(chunk).hexdigest(), data=chunk)
            self.assertEqual(code, 0, stored)
        return upload, digest

    def test_chunked_upload_promotes_one_atomic_snapshot(self):
        args = self.lock_args("big")
        data = b'{"type":"session"}\n{"type":"message"}\n'
        upload, digest = self.stage("big", args, data, 8)
        code, staged = self.call("fetch-manifest", "big")
        self.assertEqual(code, 2)
        self.assertFalse(staged.get("ok"))
        code, done = self.call("finish-upload", "big", *args, "--upload", upload, "--generation", "0", "--hash", digest)
        self.assertEqual(code, 0, done)
        self.assertEqual(done["manifest"]["generation"], 1)
        code, fetched = self.call("fetch-manifest", "big")
        self.assertEqual(fetched["jsonl"], data.decode())
        self.assertFalse((Path(self.root.name) / "sessions" / "big" / "incoming" / upload).exists())

    def test_partial_upload_cannot_be_committed(self):
        args = self.lock_args("partial")
        digest = hashlib.sha256(b"0123456789").hexdigest()
        code, begun = self.call("begin-upload", "partial", *args, "--total-bytes", "10", "--chunk-bytes", "4", "--sha256", digest)
        upload = begun["upload"]["id"]
        self.call("put-chunk", "partial", *args, "--upload", upload, "--index", "0", "--sha256", hashlib.sha256(b"0123").hexdigest(), data=b"0123")
        code, early = self.call("finish-upload", "partial", *args, "--upload", upload, "--generation", "0", "--hash", digest)
        self.assertEqual(code, 2)
        self.assertIn("assembled", early["error"])
        code, manifest = self.call("fetch-manifest", "partial")
        self.assertEqual(code, 2)

    def test_chunk_hash_mismatch_and_ordering_are_rejected(self):
        args = self.lock_args("chunks")
        digest = hashlib.sha256(b"0123456789").hexdigest()
        code, begun = self.call("begin-upload", "chunks", *args, "--total-bytes", "10", "--chunk-bytes", "4", "--sha256", digest)
        upload = begun["upload"]["id"]
        code, skipped = self.call("put-chunk", "chunks", *args, "--upload", upload, "--index", "1", "--sha256", hashlib.sha256(b"4567").hexdigest(), data=b"4567")
        self.assertEqual(code, 2)
        self.assertIn("out of order", skipped["error"])
        code, bad = self.call("put-chunk", "chunks", *args, "--upload", upload, "--index", "0", "--sha256", hashlib.sha256(b"wrong").hexdigest(), data=b"0123")
        self.assertEqual(code, 2)
        self.assertIn("chunk hash mismatch", bad["error"])

    def test_abort_discards_staged_chunks(self):
        args = self.lock_args("abandoned")
        upload, digest = self.stage("abandoned", args, b"01234567", 4)
        code, aborted = self.call("abort-upload", "abandoned", *args, "--upload", upload)
        self.assertEqual(code, 0, aborted)
        code, finished = self.call("finish-upload", "abandoned", *args, "--upload", upload, "--generation", "0", "--hash", digest)
        self.assertEqual(code, 2)
        self.assertIn("unknown or finished upload", finished["error"])

    def test_declared_total_and_chunk_size_are_enforced_at_begin(self):
        args = self.lock_args("limits")
        digest = hashlib.sha256(b"").hexdigest()
        code, huge = self.call("begin-upload", "limits", *args, "--total-bytes", str(1024 * 1024 * 1024 * 8), "--chunk-bytes", "4", "--sha256", digest)
        self.assertEqual(code, 2)
        self.assertIn("session limit", huge["error"])
        code, fat = self.call("begin-upload", "limits", *args, "--total-bytes", "8", "--chunk-bytes", str(64 * 1024 * 1024), "--sha256", digest)
        self.assertEqual(code, 2)
        self.assertIn("chunk size exceeds", fat["error"])

    def test_snapshot_can_be_downloaded_in_chunks(self):
        args = self.lock_args("dl")
        data = b'{"type":"session"}\n' + b'{"type":"message"}\n' * 40
        upload, digest = self.stage("dl", args, data, 32)
        self.assertEqual(self.call("finish-upload", "dl", *args, "--upload", upload, "--generation", "0", "--hash", digest)[0], 0)
        code, first = self.call("fetch-chunk", "dl", "--offset", "0", "--length", "16")
        self.assertEqual(code, 0)
        self.assertEqual(first["total"], len(data))
        self.assertEqual(first["manifest"]["hash"], digest)
        self.assertEqual(base64.b64decode(first["base64"]), data[:16])
        assembled = b""
        offset = 0
        while offset < len(data):
            code, page = self.call("fetch-chunk", "dl", "--offset", str(offset), "--length", "64")
            self.assertEqual(code, 0)
            blob = base64.b64decode(page["base64"])
            self.assertTrue(len(blob) <= 64)
            assembled += blob
            offset += len(blob)
        self.assertEqual(assembled, data)
        self.assertEqual(hashlib.sha256(assembled).hexdigest(), digest)
        code, missing = self.call("fetch-chunk", "empty", "--offset", "0", "--length", "16")
        self.assertEqual(code, 2)
        self.assertIn("no snapshot", missing["error"])

    def test_invalid_session_never_escapes_root(self):
        code, _value = self.call("acquire-lock", "../bad", "--owner", "test")
        self.assertNotEqual(code, 0)

    def test_dot_segments_rejected(self):
        for bad in (".", "..", "a/./b", "a/../b"):
            code, _value = self.call("acquire-lock", bad, "--owner", "test")
            self.assertNotEqual(code, 0, f"{bad} should be rejected")


if __name__ == "__main__":
    unittest.main()
