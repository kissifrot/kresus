"""Exercise preview publication with a fake GitHub CLI, without network access."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "publish-preview.sh"


@unittest.skipIf(os.name == "nt", "The publication job runs on Linux.")
class PublishPreviewTests(unittest.TestCase):
    def run_publish(self, missing="", failing=""):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            log = root / "calls.jsonl"
            cli = root / "gh"
            cli.write_text(
                f"#!{sys.executable}\n"
                "import json, os, pathlib, sys\n"
                "args = sys.argv[1:]\n"
                "with open(os.environ['TEST_GH_LOG'], 'a') as log:\n"
                "    log.write(json.dumps(args) + '\\n')\n"
                "if args[:2] == ['run', 'download']:\n"
                "    name = args[args.index('--name') + 1]\n"
                "    path = pathlib.Path(args[args.index('--dir') + 1])\n"
                "    if name == os.environ.get('TEST_FAILING'):\n"
                "        sys.exit(1)\n"
                "    path.mkdir(parents=True, exist_ok=True)\n"
                "    names = {'kresus-linux-deb': 'Kresus.deb', "
                "'kresus-windows-msi': 'Kresus.msi', "
                "'kresus-windows-nsis': 'Kresus-setup.exe'}\n"
                "    if name != os.environ.get('TEST_MISSING'):\n"
                "        (path / names[name]).write_text('installer')\n",
                encoding="utf-8",
            )
            cli.chmod(0o755)
            env = {
                **os.environ,
                "PATH": f"{root}{os.pathsep}{os.environ['PATH']}",
                "GITHUB_RUN_ID": "42",
                "PREVIEW_TAG": "preview-test-1",
                "TEST_GH_LOG": str(log),
                "TEST_MISSING": missing,
                "TEST_FAILING": failing,
            }
            result = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True)
            calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
            return result, calls

    def test_publishes_all_three_installers_as_a_prerelease(self):
        result, calls = self.run_publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 4)
        self.assertTrue(all(call[:3] == ["run", "download", "42"] for call in calls[:3]))
        release = calls[-1]
        self.assertEqual(release[:3], ["release", "create", "preview-test-1"])
        self.assertEqual([Path(path).name for path in release[3:6]], [
            "Kresus.deb", "Kresus.msi", "Kresus-setup.exe"
        ])
        self.assertIn("--prerelease", release)
        self.assertIn("--verify-tag", release)
        self.assertIn("--latest=false", release)

    def test_does_not_publish_if_an_installer_is_missing(self):
        result, calls = self.run_publish("kresus-windows-msi")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Expected exactly one", result.stderr)
        self.assertFalse(any(call[:2] == ["release", "create"] for call in calls))

    def test_does_not_publish_if_download_fails(self):
        result, calls = self.run_publish(failing="kresus-windows-msi")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(call[:2] == ["release", "create"] for call in calls))


if __name__ == "__main__":
    unittest.main()
