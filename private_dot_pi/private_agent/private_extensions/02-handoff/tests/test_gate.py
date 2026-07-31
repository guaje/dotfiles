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
        self.assertEqual(value["version"], 2)
        self.assertEqual(value["checksum"], hashlib.sha256(HELPER.read_bytes()).hexdigest())
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
        for request in vectors["invalidRequests"]:
            code, value = self.stdio(request)
            self.assertEqual(code, 2)
            self.assertFalse(value["ok"])

    def test_invalid_session_never_escapes_root(self):
        code, _value = self.call("acquire-lock", "../bad", "--owner", "test")
        self.assertNotEqual(code, 0)

    def test_dot_segments_rejected(self):
        for bad in (".", "..", "a/./b", "a/../b"):
            code, _value = self.call("acquire-lock", bad, "--owner", "test")
            self.assertNotEqual(code, 0, f"{bad} should be rejected")


if __name__ == "__main__":
    unittest.main()
