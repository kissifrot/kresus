import { expect, vi } from "vitest";
import type { Schedule } from "../src/types";

type Account = { id: string; name: string; kind: string; openingBalance: number; bank: string };
type Transaction = { id: string; accountId: string; date: string; label: string; category: string; amount: number; cheque?: string | null; reconciled: boolean; transferId?: string; note?: string };

export async function openRegister(options: { failAccount?: boolean; accounts?: Account[]; transactions?: Transaction[]; schedules?: Schedule[] } = {}) {
  const accounts: Account[] = (options.accounts ?? [{ id: "one", name: "Compte principal", kind: "Compte courant", openingBalance: 100, bank: "Banque" }]).map((account) => ({ ...account, openingBalance: Math.round(account.openingBalance * 100) }));
  let transactions: Transaction[] = (options.transactions ?? [
    { id: "debit", accountId: "one", date: "2027-01-01", label: "Courses", category: "Alimentation", amount: -20, cheque: null, reconciled: false },
    { id: "credit", accountId: "one", date: "2027-01-02", label: "Salaire", category: "Revenus", amount: 50, cheque: null, reconciled: true },
  ]).map((item) => ({ ...item, amount: Math.round(item.amount * 100) }));
  const schedules = options.schedules?.map((item) => ({ ...item, amount: Math.round(item.amount * 100), series: { ...item.series, amount: Math.round(item.series.amount * 100) } }));
  // Model the commands in memory so the real interface can be exercised safely.
  const invoke = vi.fn(async (command: string, args?: Record<string, any>) => {
    switch (command) {
      case "list_accounts": return accounts.map((account) => ({ ...account, currentBalance: account.openingBalance + transactions.filter((transaction) => transaction.accountId === account.id).reduce((sum, transaction) => sum + transaction.amount, 0) }));
      case "list_schedules": return schedules ?? [];
      case "record_schedule": {
        const item = schedules?.find((schedule) => schedule.id === args?.id);
        if (item) item.nextDue = "2028-01-01";
        return;
      }
      case "list_categories": return ["Alimentation", "Divers", "Revenus"].map((name) => ({ id: name, name, parentId: null }));
      case "list_transactions": return transactions.filter((transaction) => transaction.accountId === args?.accountId);
      case "list_register": {
        const account = accounts.find((item) => item.id === args?.accountId)!;
        const all = transactions.filter((item) => item.accountId === account.id).sort((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        let balance = account.openingBalance;
        const withBalance = all.map((item) => ({ ...item, runningBalance: balance += item.amount })).reverse();
        const filtered = withBalance.filter((item) => args?.filter === "all" || (args?.filter === "credit" && item.amount > 0) || (args?.filter === "debit" && item.amount < 0) || (args?.filter === "reconciled" && item.reconciled) || (args?.filter === "unreconciled" && !item.reconciled) || (args?.filter === "month-credit" && item.amount > 0 && item.date.startsWith(args!.month)) || (args?.filter === "month-debit" && item.amount < 0 && item.date.startsWith(args!.month)));
        const month = all.filter((item) => item.date.startsWith(args!.month));
        const credit = month.filter((item) => item.amount > 0), debit = month.filter((item) => item.amount < 0);
        const pageCount = Math.max(1, Math.ceil(filtered.length / 100)), page = Math.min(args!.page, pageCount);
        return { rows: filtered.slice((page - 1) * 100, page * 100), totalCount: all.length, filteredCount: filtered.length, unreconciledCount: all.filter((item) => !item.reconciled).length, income: credit.reduce((sum, item) => sum + item.amount, 0), expenses: debit.reduce((sum, item) => sum + item.amount, 0), creditCount: credit.length, debitCount: debit.length, page, pageCount };
      }
      case "list_payees": return [...new Set(transactions.filter((transaction) => !transaction.transferId).map((transaction) => transaction.label))];
      case "create_account": if (options.failAccount) throw new Error("Erreur de base"); accounts.push(args!.account); return;
      case "create_transaction": transactions.push({ ...args!.transaction, reconciled: false }); return;
      case "create_transfer": {
        const transfer = args!.transfer;
        const source = accounts.find((account) => account.id === transfer.sourceId)!;
        const destination = accounts.find((account) => account.id === transfer.destinationId)!;
        const shared = { date: transfer.date, category: transfer.category, note: transfer.note, reconciled: false, transferId: transfer.id };
        transactions.push({ ...shared, id: `${transfer.id}-debit`, accountId: source.id, label: `Virement vers ${destination.name}`, amount: -transfer.amount });
        transactions.push({ ...shared, id: `${transfer.id}-credit`, accountId: destination.id, label: `Virement depuis ${source.name}`, amount: transfer.amount });
        return;
      }
      case "get_transfer": {
        const debit = transactions.find((item) => item.transferId === args!.id && item.amount < 0)!;
        const credit = transactions.find((item) => item.transferId === args!.id && item.amount > 0)!;
        return { id: args!.id, sourceId: debit.accountId, destinationId: credit.accountId, date: debit.date, amount: -debit.amount, category: debit.category, note: debit.note ?? "" };
      }
      case "update_transfer": {
        const transfer = args!.transfer;
        const source = accounts.find((account) => account.id === transfer.sourceId)!;
        const destination = accounts.find((account) => account.id === transfer.destinationId)!;
        transactions = transactions.map((item) => item.transferId !== transfer.id ? item : { ...item, accountId: item.amount < 0 ? source.id : destination.id, label: item.amount < 0 ? `Virement vers ${destination.name}` : `Virement depuis ${source.name}`, amount: item.amount < 0 ? -transfer.amount : transfer.amount, date: transfer.date, category: transfer.category, note: transfer.note });
        return;
      }
      case "update_transaction": transactions = transactions.map((item) => item.id === args!.transaction.id ? { ...item, ...args!.transaction } : item); return;
      case "toggle_transaction_reconciliation": transactions = transactions.map((item) => item.id === args!.id ? { ...item, reconciled: !item.reconciled } : item); return;
      case "delete_transaction": { const target = transactions.find((item) => item.id === args!.id); transactions = transactions.filter((item) => item.id !== args!.id && (!target?.transferId || item.transferId !== target.transferId)); return; }
      default: throw new Error(`Unexpected command: ${command}`);
    }
  });
  vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
  await import("../src/main");
  await vi.waitFor(() => expect(document.querySelector("#new-transaction")).not.toBeNull());
  return invoke;
}

export function field(form: HTMLFormElement, name: string) { return form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement; }
export function submit(form: HTMLFormElement) { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }
export function click(selector: string) { (document.querySelector(selector) as HTMLElement).click(); }
