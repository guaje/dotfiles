import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HELPER = Path(__file__).parents[1] / "assets" / "pi-handoff-gate.py"
class GateTests(unittest.TestCase):
    def setUp(self): self.root = tempfile.TemporaryDirectory()
    def tearDown(self): self.root.cleanup()
    def call(self, *args, data=b""):
        env = {**os.environ, "PI_HANDOFF_ROOT": self.root.name}
        process = subprocess.run([sys.executable, str(HELPER), *args], input=data, capture_output=True, env=env, check=False)
        return process.returncode, json.loads(process.stdout)
    def test_version_and_locked_cas_commit(self):
        code, value = self.call("version"); self.assertEqual(code, 0); self.assertEqual(value["version"], 1); self.assertEqual(value["checksum"], hashlib.sha256(HELPER.read_bytes()).hexdigest())
        code, lock = self.call("acquire-lock", "session", "--owner", "test"); self.assertEqual(code, 0)
        data = b'{"type":"session"}\n'; digest = hashlib.sha256(data).hexdigest()
        code, committed = self.call("commit", "session", "--nonce", lock["nonce"], "--token", lock["token"], "--generation", "0", "--hash", digest, data=data)
        self.assertEqual(code, 0); self.assertEqual(committed["manifest"]["generation"], 1)
        code, fetched = self.call("fetch-manifest", "session"); self.assertEqual(code, 0); self.assertEqual(fetched["jsonl"], data.decode())
        code, conflict = self.call("commit", "session", "--nonce", lock["nonce"], "--token", lock["token"], "--generation", "0", "--hash", digest, data=data)
        self.assertEqual(code, 2); self.assertFalse(conflict["ok"])
    def test_invalid_session_never_escapes_root(self):
        code, value = self.call("acquire-lock", "../bad", "--owner", "test"); self.assertNotEqual(code, 0)
    def test_dot_segments_rejected(self):
        for bad in (".", "..", "a/./b", "a/../b"):
            code, value = self.call("acquire-lock", bad, "--owner", "test")
            self.assertNotEqual(code, 0, f"{bad} should be rejected")
if __name__ == "__main__": unittest.main()
