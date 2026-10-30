// Amounts crossing the application boundary are integer cents.
export const euro = (cents: number) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(cents / 100);
// Accept either decimal key and French grouped amounts copied from other applications.
export function parseCents(value: string): number {
  const input = value.trim().replace(/\s*€$/, "").trim();
  const match =
    /^(-?)((?:[0-9]+|[0-9]{1,3}(?:[ \u00a0\u202f][0-9]{3})+))(?:[.,]([0-9]{1,2}))?$/.exec(input);
  if (!match) throw new Error("Saisissez un montant valide avec au plus deux décimales.");
  const cents =
    Number(match[2]!.replace(/[ \u00a0\u202f]/g, "")) * 100 +
    Number((match[3] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 100_000_000_000)
    throw new Error("Le montant ne peut pas dépasser 1 milliard d’euros.");
  return match[1] ? -cents : cents;
}

// Operations, transfers and schedules use a positive amount and a separate type.
export function parsePositiveCents(value: string): number {
  const cents = parseCents(value);
  if (cents <= 0) throw new Error("Le montant doit être supérieur à zéro.");
  return cents;
}
export function centsInput(cents: number): string {
  const absolute = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(absolute / 100)},${String(absolute % 100).padStart(2, "0")}`;
}
export const dateLabel = (date: string) =>
  new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" }).format(
    new Date(`${date}T12:00:00`),
  );
export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

// Format the calendar date in the user's local time zone.
export function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
