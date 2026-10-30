// Monetary values in the frontend and Tauri API are integer cents.
export type AccountKind = "Compte courant" | "Épargne" | "Assurance vie";
export type Category = { id: string; name: string; parentId: string | null };
export type Account = {
  id: string;
  name: string;
  kind: AccountKind;
  openingBalance: number;
  currentBalance: number;
  bank: string;
};
export type Transaction = {
  id: string;
  accountId: string;
  date: string;
  label: string;
  category: string;
  cheque?: string | null;
  amount: number;
  reconciled: boolean;
  note?: string | null;
  transferId?: string | null;
};
export type ScheduleSeries = {
  accountId: string;
  label: string;
  category: string;
  nextDue: string;
  amount: number;
  kind: "debit" | "credit" | "transfer";
  destinationAccountId?: string | null;
  paymentMethod?: "cheque" | "bank_transfer" | "direct_debit" | null;
  cheque?: string | null;
};
export type Schedule = ScheduleSeries & {
  id: string;
  frequency: string;
  remainingCount?: number | null;
  endDate?: string | null;
  series: ScheduleSeries & { anchorDay: number };
  futureOverrides?: (ScheduleSeries & { originalDue: string })[];
};
export type CalendarOccurrence = ScheduleSeries & {
  id: string;
  frequency: string;
  projected: boolean;
  originalDue?: string;
};
