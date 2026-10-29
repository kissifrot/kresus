import type { Account, Transaction, Schedule, Category } from "./types";

// Shared state contains the data loaded from the Rust backend.
export let accounts: Account[] = [];
export let transactions: Transaction[] = [];
export let schedules: Schedule[] = [];
export let categories: Category[] = [];
export let selectedAccount: Account;
export function setAccounts(value: Account[]) { accounts = value; }
export function setTransactions(value: Transaction[]) { transactions = value; }
export function setSchedules(value: Schedule[]) { schedules = value; }
export function setCategories(value: Category[]) { categories = value; }
export function setSelectedAccount(value: Account) { selectedAccount = value; }
