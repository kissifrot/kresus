// Amounts crossing the application boundary are integer cents.
export const euro = (cents: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(cents / 100);
export function parseCents(value: string): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error("Saisissez un montant en euros avec au plus deux décimales.");
  const cents = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 100_000_000_000) throw new Error("Montant trop élevé.");
  return match[1] ? -cents : cents;
}
export function centsInput(cents: number): string {
  const absolute = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}
export const dateLabel = (date: string) => new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${date}T12:00:00`));
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
