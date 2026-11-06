"""Check that the versioned installer configuration can open Kresus files."""
import json
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]
TAURI = PROJECT / "src-tauri"


class FileAssociationTests(unittest.TestCase):
    def test_cross_platform_association_and_linux_launcher(self):
        config = json.loads((TAURI / "tauri.conf.json").read_text(encoding="utf-8"))
        bundle = config["bundle"]
        associations = [item for item in bundle["fileAssociations"] if "kresus" in item["ext"]]
        self.assertEqual(len(associations), 1)
        self.assertEqual(associations[0]["mimeType"], "application/x-kresus")
        self.assertEqual(associations[0]["role"], "Editor")

        deb = bundle["linux"]["deb"]
        desktop = (TAURI / deb["desktopTemplate"]).read_text(encoding="utf-8")
        self.assertIn("Exec=kresus %f\n", desktop)
        self.assertIn("MimeType=application/x-kresus;", desktop)
        mime_path = deb["files"]["/usr/share/mime/packages/kresus.xml"]
        root = ET.parse(TAURI / mime_path).getroot()
        ns = {"m": "http://www.freedesktop.org/standards/shared-mime-info"}
        mime = root.find("m:mime-type", ns)
        self.assertIsNotNone(mime)
        self.assertEqual(mime.get("type"), "application/x-kresus")
        self.assertIsNotNone(mime.find("m:glob[@pattern='*.kresus']", ns))


if __name__ == "__main__":
    unittest.main()
