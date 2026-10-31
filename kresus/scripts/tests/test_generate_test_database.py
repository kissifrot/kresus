"""Checks the properties of generated data without touching existing databases."""
import importlib.util
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "generate_test_database.py"
spec = importlib.util.spec_from_file_location("kresus_generator", SCRIPT)
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)


class GeneratedDatabaseTests(unittest.TestCase):
    def test_monthly_incomes_and_operation_counts(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "example.sqlite3"
            generator.generate(path, 12000)
            with closing(sqlite3.connect(path)) as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM transactions").fetchone()[0], 12000)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM transactions WHERE account_id='test-courant'").fetchone()[0], 10000)
                rows = db.execute("SELECT substr(operation_date,1,7), label, COUNT(*), MIN(amount_cents) FROM transactions WHERE label IN ('Salaire fictif','Pension fictive') GROUP BY 1,2").fetchall()
                self.assertEqual(len(rows), 242)
                self.assertTrue(all(count == 1 and amount > 0 for _, _, count, amount in rows))
                self.assertEqual((rows[0][0], rows[-1][0]), ("2016-10", "2026-10"))

    def test_small_volume_and_existing_file_are_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "example.sqlite3"
            generator.generate(path, 12)
            with closing(sqlite3.connect(path)) as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM transactions").fetchone()[0], 12)
            before = path.read_bytes()
            with self.assertRaises(FileExistsError):
                generator.generate(path, 12)
            self.assertEqual(path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
