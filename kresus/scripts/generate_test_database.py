#!/usr/bin/env python3
"""Generate a deterministic Kresus database with fictitious transactions."""

import argparse
import datetime as dt
import os
from pathlib import Path
import random
import sqlite3

PROJECT = Path(__file__).resolve().parents[1]
SCHEMA = PROJECT / "src-tauri" / "src" / "schema.sql"
DEFAULT_OUTPUT = PROJECT / "donnees-test" / "kresus-test-12000.sqlite3"
START = dt.date(2016, 10, 29)
END = dt.date(2026, 10, 28)


def generate(path: Path, count: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Atomic exclusive creation prevents overwriting an existing database.
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    try:
        rng = random.Random(20261029)
        with sqlite3.connect(path) as db:
            db.execute("PRAGMA foreign_keys = ON")
            db.executescript(SCHEMA.read_text(encoding="utf-8"))
            db.executemany("INSERT INTO accounts VALUES (?, ?, ?, ?, ?)", [
                ("test-courant", "Compte courant — test", "Compte courant", 150000, "Banque fictive"),
                ("test-epargne", "Livret — test", "Épargne", 500000, "Banque fictive"),
            ])
            db.executemany("INSERT INTO categories VALUES (?, ?, ?)", [
                ("food", "Alimentation", None), ("food-store", "Épicerie", "food"),
                ("home", "Logement", None), ("bills", "Factures", None),
                ("transport", "Transports", None), ("leisure", "Loisirs", None),
                ("revenue", "Revenus", None), ("other", "Divers", None),
            ])
            db.execute("INSERT INTO app_metadata VALUES ('categories_v1', '1')")
            expenses = [
                ("Marché des Halles", "Alimentation · Épicerie"), ("Supermarché du Centre", "Alimentation"),
                ("Électricité fictive", "Factures"), ("Transports urbains", "Transports"),
                ("Librairie imaginaire", "Loisirs"), ("Entretien du logement", "Logement"), ("Achat divers", "Divers"),
            ]
            main_count = count * 5 // 6
            savings_count = count - main_count
            # Reserve regular, predictable income before filling the remaining slots.
            months = []
            month = START.replace(day=1)
            while month <= END:
                months.append(month)
                month = (month.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
            incomes_per_month = min(2, max(0, (main_count - 2) // len(months)))
            rows = []
            for month in months:
                for index, (day, label, amount) in enumerate([
                    (5, "Salaire fictif", 195000),
                    (12, "Pension fictive", 85000),
                ][:incomes_per_month]):
                    date = min(max(month.replace(day=day), START), END)
                    rows.append((f"income-{month:%Y-%m}-{index}", "test-courant", date.isoformat(),
                                 label, "Revenus", None, amount, 1, "Revenu mensuel fictif"))
            regular_count = len(rows)
            other_main_count = main_count - regular_count
            for i in range(count - regular_count):
                main = i < other_main_count
                index, account_count = (i, other_main_count) if main else (i - other_main_count, savings_count)
                date = START + dt.timedelta(days=index * (END - START).days // (account_count - 1))
                if not main and i % 12 == 0:
                    label, category, amount = "Intérêts fictifs", "Revenus", rng.randint(100, 5000)
                else:
                    label, category = rng.choice(expenses)
                    amount = -rng.randint(150, 4500) if main else -rng.randint(100, 2000)
                rows.append((f"test-{i:05}", "test-courant" if main else "test-epargne", date.isoformat(),
                             label, category, None, amount, int(i % 7 != 0), "Donnée fictive de test"))
            db.executemany("INSERT INTO transactions (id, account_id, operation_date, label, category, cheque, amount_cents, reconciled, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
            if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok" or db.execute("PRAGMA foreign_key_check").fetchone():
                raise RuntimeError("La base générée n’a pas passé les contrôles d’intégrité.")
    except Exception:
        # Only remove the new file created by this invocation.
        path.unlink(missing_ok=True)
        raise
    print(f"Base créée : {path.resolve()} ({count} opérations, du {START} au {END})")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Chemin du fichier à créer")
    parser.add_argument("--operations", type=int, default=12000, help="Nombre total d’opérations (par défaut : 12000)")
    args = parser.parse_args()
    if args.operations < 12:
        parser.error("au moins 12 opérations sont nécessaires")
    try:
        generate(args.output, args.operations)
    except FileExistsError:
        parser.error(f"le fichier existe déjà : {args.output}")


if __name__ == "__main__":
    main()
