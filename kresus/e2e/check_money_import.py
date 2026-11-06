"""Verify the imported fictitious Money reference database from both Tauri paths."""
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
accounts = connection.execute(
    "SELECT name, opening_balance_cents FROM accounts ORDER BY name"
).fetchall()
assert accounts == [("Compte courant", 100000), ("Livret A", 200000)], accounts
amounts = connection.execute("SELECT amount_cents FROM transactions ORDER BY amount_cents").fetchall()
assert amounts == [(x,) for x in (-364155, -22500, -20000, -20000, -10000, -10000, -10000, -10000, -2500, 10000, 10000, 10000)], amounts
assert connection.execute("SELECT count(*) FROM categories WHERE id LIKE 'money-cat-%'").fetchone() == (138,)
for transfer_id, expected in [
    ("money-transfer-9-10", (-10000, 1, 10000, 0)),
    ("money-transfer-17-16", (-10000, 0, 10000, 1)),
    ("money-transfer-19-20", (-10000, 0, 10000, 1)),
]:
    pair = connection.execute(
        "SELECT d.amount_cents,d.reconciled,r.amount_cents,r.reconciled FROM transfers x "
        "JOIN transactions d ON d.id=x.debit_id JOIN transactions r ON r.id=x.credit_id WHERE x.id=?",
        (transfer_id,),
    ).fetchone()
    assert pair == expected, (transfer_id, pair)
assert connection.execute("SELECT count(*) FROM transactions WHERE id IN ('money-transaction-18','money-transaction-23')").fetchone() == (2,)
assert connection.execute("SELECT anchor_day FROM schedule_anchors WHERE schedule_id='money-schedule-7'").fetchone() == (6,)
assert connection.execute("SELECT payment_method FROM schedules WHERE id='money-schedule-3'").fetchone() == (None,)
limits = connection.execute("SELECT schedule_id,end_date,remaining_count FROM schedule_limits WHERE end_date IS NOT NULL ORDER BY schedule_id").fetchall()
assert limits == [('money-schedule-3','2027-08-04',None),('money-schedule-4','2027-03-19',None),('money-schedule-7','2026-12-06',None)], limits
schedules = connection.execute("SELECT id,next_due,frequency,amount_cents FROM schedules ORDER BY id").fetchall()
assert schedules == [
    ('money-schedule-1','2026-10-31','Mensuelle',-12000),
    ('money-schedule-2','2026-10-15','Bimensuelle',-10000),
    ('money-schedule-3','2026-11-04','Mensuelle',20000),
    ('money-schedule-4','2026-11-19','Mensuelle',30000),
    ('money-schedule-5','2026-11-19','Bimestrielle',-20000),
    ('money-schedule-6','2026-11-06','Trimestrielle',-10000),
    ('money-schedule-7','2026-12-06','Mensuelle',-20000),
    ('money-schedule-8','2026-11-07','Mensuelle',-37400),
    ('money-schedule-9','2026-11-28','Mensuelle',-12300),
], schedules
assert connection.execute("SELECT destination_account_id FROM schedule_transfers WHERE schedule_id='money-schedule-2'").fetchone() == ('money-account-3',)
