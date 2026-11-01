// Read-only prototype: decode MSISAM, then compare Money tables with Jackcess.
// Key derivation follows the Apache-2.0 jackcess-encrypt 4.0.3
// MSISAMCryptCodecHandler, Copyright (c) 2010 Vladimir Berezniker.
import createHash from "create-hash";
import { Buffer } from "buffer";
import MDBReader from "mdb-reader";

type Row = Record<string, any>;
// mdb-reader’s browser build expects the standard Buffer global.
(globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
export function rc4(key: Buffer, input: Buffer): Buffer {
  const state = Uint8Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i]! + key[i % key.length]!) & 255;
    [state[i], state[j]] = [state[j]!, state[i]!];
  }
  const output = Buffer.alloc(input.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < input.length; k++) {
    i = (i + 1) & 255;
    j = (j + state[i]!) & 255;
    [state[i], state[j]] = [state[j]!, state[i]!];
    output[k] = input[k]! ^ state[(state[i]! + state[j]!) & 255]!;
  }
  return output;
}

export function decodeMoney(source: Buffer): Buffer {
  if (
    source.length < 4096 ||
    source.length % 4096 ||
    source.toString("ascii", 4, 19) !== "MSISAM Database" ||
    source[20] !== 1
  )
    throw new Error("Format MSISAM Jet 4 non reconnu.");
  const result = Buffer.from(source),
    header = Buffer.from(source.subarray(0, 4096));
  // Jet masks part of its header with a fixed RC4 stream.
  rc4(Buffer.from([0xc7, 0xda, 0x39, 0x6b]), Buffer.from(header.subarray(0x18, 0x96))).copy(
    header,
    0x18,
  );
  const flags = header[0x298]!;
  if (!(flags & 6)) throw new Error("Ancien schéma MSISAM non pris en charge par cette version.");
  const salt = Buffer.from(header.subarray(0x72, 0x7a));
  const digest = Buffer.from(
    createHash(flags & 0x20 ? "sha1" : "md5")
      .update(Buffer.alloc(40))
      .digest()
      .subarray(0, 16),
  );
  const encryptedCheck = Buffer.from(header.subarray(0x2e9 + salt[0]!, 0x2ed + salt[0]!));
  if (
    !encryptedCheck.every((v) => v === 0) &&
    !rc4(Buffer.concat([digest, salt]), encryptedCheck).equals(Buffer.from(salt.subarray(0, 4)))
  )
    throw new Error("Mot de passe non vide ou fichier invalide.");
  // Only pages 1 through 14 are encoded; the source buffer stays untouched.
  for (let page = 1; page <= 14 && page * 4096 < result.length; page++) {
    const pageSalt = Buffer.from(salt.subarray(0, 4));
    pageSalt.writeUInt32LE((pageSalt.readUInt32LE(0) ^ page) >>> 0, 0);
    rc4(
      Buffer.concat([digest, pageSalt]),
      Buffer.from(source.subarray(page * 4096, (page + 1) * 4096)),
    ).copy(result, page * 4096);
  }
  return result;
}

export function cents(value: unknown): number {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match || /[1-9]/.test((match[3] ?? "").slice(2)))
    throw new Error("Montant non représentable en centimes.");
  const n = BigInt(match[2]!) * 100n + BigInt(((match[3] ?? "") + "00").slice(0, 2));
  const signed = match[1] ? -n : n;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER))
    throw new Error("Montant trop élevé.");
  return Number(signed);
}

// A transfer between schedule templates must not be mistaken for a posted transfer.
// Resolve posted pairs by Money IDs, keeping each side's own reconciliation status.
export function readPostedTransfers(
  transfers: Row[],
  transactions: Row[],
  bills: Row[],
  accounts: Row[],
) {
  const byId = new Map(transactions.map((transaction) => [transaction.htrn, transaction]));
  const paired = new Set<number>();
  const result: { debitId: number; creditId: number }[] = [];
  for (const link of transfers) {
    const first = byId.get(link.htrnFrom);
    const second = byId.get(link.htrnLink);
    if (
      !first ||
      !second ||
      first.htrn === second.htrn ||
      paired.has(first.htrn) ||
      paired.has(second.htrn) ||
      first.hacctLink !== second.hacct ||
      second.hacctLink !== first.hacct ||
      first.hacct === second.hacct
    )
      throw new Error("Virement Money incomplet ou incohérent.");
    paired.add(first.htrn);
    paired.add(second.htrn);
    if (first.frq !== -1 || second.frq !== -1) {
      if (
        !Number.isInteger(first.frq) ||
        first.frq < 0 ||
        first.frq !== second.frq ||
        !bills.some((bill) => bill.lHtrn === first.htrn || bill.lHtrn === second.htrn)
      )
        throw new Error("Virement Money incomplet ou incohérent.");
      continue;
    }
    if (
      !accounts.some((account) => account.hacct === first.hacct) ||
      !accounts.some((account) => account.hacct === second.hacct)
    )
      throw new Error("Virement Money vers un compte non pris en charge.");
    const firstAmount = cents(first.amt);
    const secondAmount = cents(second.amt);
    if (!firstAmount || firstAmount !== -secondAmount)
      throw new Error("Virement Money incohérent : montants différents.");
    const [debit, credit] = firstAmount < 0 ? [first, second] : [second, first];
    if (debit.grftt !== 2 || credit.grftt !== 6)
      throw new Error("Virement Money non pris en charge.");
    result.push({ debitId: debit.htrn, creditId: credit.htrn });
  }
  // Refuse an unpaired transfer rather than silently importing one side as an ordinary operation.
  if (
    transactions.some(
      (t) =>
        t.frq === -1 &&
        accounts.some((a) => a.hacct === t.hacct) &&
        t.hacctLink != null &&
        !paired.has(t.htrn),
    )
  )
    throw new Error("Virement Money incomplet.");
  return result;
}

// Preserve a Money end date only when its count yields the same last occurrence.
function verifiedScheduleLimit(
  due: unknown,
  maximum: unknown,
  count: unknown,
  interval: number,
): string | null | undefined {
  if (
    !(due instanceof Date) ||
    Number.isNaN(due.getTime()) ||
    !(maximum instanceof Date) ||
    Number.isNaN(maximum.getTime())
  )
    return undefined;
  const end = maximum.toISOString().slice(0, 10);
  if (count === -1 && end === "2200-12-31") return null;
  if (
    !Number.isInteger(count) ||
    (count as number) < 1 ||
    (count as number) > 100_000 ||
    end === "2200-12-31" ||
    !Number.isInteger(interval) ||
    interval < 1
  )
    return undefined;
  // Reuse the original day as the anchor, including after short months and leap years.
  const occurrence = (offset: number) => {
    const monthIndex = due.getUTCFullYear() * 12 + due.getUTCMonth() + offset * interval;
    const year = Math.floor(monthIndex / 12);
    if (year < 1 || year > 9999) return "";
    const month = monthIndex % 12;
    const first = new Date(0);
    first.setUTCHours(0, 0, 0, 0);
    first.setUTCFullYear(year, month + 1, 0);
    const day = Math.min(due.getUTCDate(), first.getUTCDate());
    return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  };
  const last = occurrence((count as number) - 1);
  const next = occurrence(count as number);
  return last && next && last <= end && end < next ? end : undefined;
}

// Import only series whose Money representation has been verified against the sample.
export function readMoneySchedules(
  bills: Row[],
  transactions: Row[],
  transfers: Row[],
  accounts: Row[],
  payees: Row[],
  categoryLabel: (id: number) => string,
) {
  const schedules: {
    id: number;
    accountId: number;
    destinationAccountId: number | null;
    label: string;
    category: string;
    nextDue: string;
    frequency: string;
    amount: number;
    kind: string;
    paymentMethod: "cheque" | null;
    endDate: string | null;
  }[] = [];
  const warnings: string[] = [];
  const skippedSchedules: string[] = [];
  for (const bill of bills) {
    const source = transactions.find((item) => item.htrn === bill.lHtrn);
    // Keep enough context to locate a skipped series in Money, even if its model is missing.
    const payee = payees.find((p) => p.hpay === (source?.lHpay ?? source?.hpay));
    const account = accounts.find((a) => a.hacct === source?.hacct);
    const date =
      bill.dt instanceof Date && !Number.isNaN(bill.dt.getTime())
        ? new Intl.DateTimeFormat("fr-FR", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            timeZone: "UTC",
          }).format(bill.dt)
        : "date inconnue";
    const description = `Échéance Money ${bill.hbill} · ${String(payee?.szFull ?? "Destinataire inconnu").trim()} · ${String(account?.szFull ?? "Compte inconnu").trim()} · ${date}`;
    const interval = Number(bill.cFrqInst);
    const frequency =
      bill.frq === 3
        ? ({ 1: "Mensuelle", 2: "Bimestrielle" } as Record<number, string>)[interval]
        : undefined;
    // A limited series is accepted only when its two Money limits are consistent.
    const endDate = verifiedScheduleLimit(bill.dt, bill.dtMax, bill.cInstMax, interval);
    if (
      !source ||
      bill.st !== 3 ||
      bill.hbill !== bill.hbillHead ||
      bill.iinst !== 0 ||
      bill.iinstNextUnpaid !== 0 ||
      endDate === undefined ||
      bill.iinstLastSkipped !== -1 ||
      bill.cDaysAutoEnter !== -1 ||
      !frequency ||
      source.frq !== bill.frq ||
      !accounts.some((a) => a.hacct === source.hacct) ||
      !(bill.dt instanceof Date)
    ) {
      const reasons = [];
      if (endDate === undefined) reasons.push("limite de durée absente, invalide ou incohérente");
      if (!frequency) reasons.push("périodicité non prise en charge");
      if (!reasons.length) reasons.push("autres paramètres non pris en charge");
      skippedSchedules.push(`${description} : ${reasons.join(" ; ")}.`);
      continue;
    }
    const amount = cents(source.amt);
    if (
      !amount ||
      source.hsec != null ||
      source.act !== -1 ||
      ![2097152, 2097154].includes(source.grftt)
    ) {
      skippedSchedules.push(`${description} : opération non prise en charge.`);
      continue;
    }
    let destinationAccountId: number | null = null;
    if (source.hacctLink != null) {
      const link = transfers.find(
        (item) => item.htrnFrom === source.htrn || item.htrnLink === source.htrn,
      );
      const other = transactions.find(
        (item) => item.htrn === (link?.htrnFrom === source.htrn ? link?.htrnLink : link?.htrnFrom),
      );
      if (
        amount >= 0 ||
        !other ||
        other.hacct !== source.hacctLink ||
        other.hacctLink !== source.hacct ||
        cents(other.amt) !== -amount ||
        !accounts.some((a) => a.hacct === source.hacctLink)
      ) {
        skippedSchedules.push(`${description} : virement incomplet ou compte indisponible.`);
        continue;
      }
      destinationAccountId = source.hacctLink;
    }
    // The only verified non-transfer signature comes from the supplied cheque example.
    // Unrecognised flags must not be guessed: Money has other payment methods.
    const paymentMethod =
      destinationAccountId == null &&
      source.grfstem === 2050 &&
      source.grfEntryMethods === 1 &&
      source.fPrint === false
        ? "cheque"
        : null;
    if (!paymentMethod)
      warnings.push(
        `Échéance Money ${bill.hbill} : méthode de paiement non reconnue ; à vérifier après import.`,
      );
    schedules.push({
      id: bill.hbill,
      accountId: source.hacct,
      destinationAccountId,
      label: String(payee?.szFull ?? "").trim() || "Échéance sans destinataire",
      category: categoryLabel(source.hcat),
      nextDue: bill.dt.toISOString().slice(0, 10),
      frequency,
      amount,
      kind: destinationAccountId != null ? "transfer" : amount > 0 ? "credit" : "debit",
      paymentMethod,
      endDate,
    });
  }
  if (schedules.length) warnings.push("Les notes des échéances Money ne sont pas importées.");
  return { schedules, warnings, skippedSchedules };
}

export function inspect(buffer: Buffer) {
  const reader = new MDBReader(decodeMoney(buffer));
  const rows = (name: string) => reader.getTable(name).getData() as Row[];
  const accounts = rows("ACCT"),
    tx = rows("TRN"),
    categories = rows("CAT"),
    payees = rows("PAY"),
    currencies = rows("CRNC");
  const bank = accounts.filter(
    (a) =>
      a.at === 0 && !a.fClosed && currencies.find((c) => c.hcrnc === a.hcrnc)?.szIsoCode === "EUR",
  );
  if (rows("TRN_SPLIT").length) throw new Error("Ventilations non prises en charge.");
  const transfers = readPostedTransfers(rows("TRN_XFER"), tx, rows("BILL"), bank);
  const transferIds = new Set(transfers.flatMap((pair) => [pair.debitId, pair.creditId]));
  // Reject category trees that cannot be represented without losing information.
  const seen = new Set<string>();
  for (const category of categories.filter((c) => c.hct === 0 && c.nLevel > 0)) {
    const name = String(category.szFull ?? "").trim();
    const parent = categories.find((c) => c.hcat === category.hcatParent);
    if (
      ![1, 2].includes(category.nLevel) ||
      !name ||
      name.length > 80 ||
      name.includes("·") ||
      (category.nLevel === 2 && (!parent || parent.nLevel !== 1))
    )
      throw new Error("La hiérarchie des catégories Money ne peut pas être importée.");
    const key =
      `${category.nLevel === 2 ? String(parent?.szFull).trim() : ""}\0${name}`.toLowerCase();
    if (seen.has(key))
      throw new Error(
        "Des catégories Money ont le même nom et ne peuvent pas être importées automatiquement.",
      );
    seen.add(key);
  }
  const label = (id: number) => {
    const category = categories.find((c) => c.hcat === id);
    if (!category || category.nLevel === 0) return "Divers";
    const parent = categories.find((c) => c.hcat === category.hcatParent);
    return category.nLevel === 2
      ? `${String(parent?.szFull ?? "").trim()} · ${String(category.szFull ?? "").trim()}`
      : String(category.szFull ?? "").trim();
  };
  const operations = tx
    .filter((t) => bank.some((a) => a.hacct === t.hacct) && t.frq === -1)
    .map((t) => {
      if (
        t.hsec !== null ||
        t.act !== -1 ||
        (transferIds.has(t.htrn)
          ? ![2, 6].includes(t.grftt)
          : t.hacctLink !== null || t.grftt !== 0) ||
        ![0, 1, 2].includes(t.cs)
      )
        throw new Error("Opération non prise en charge.");
      if (!t.amt || cents(t.amt) === 0)
        throw new Error("Une opération de montant nul ne peut pas être importée.");
      const payee = payees.find((p) => p.hpay === (t.lHpay ?? t.hpay));
      let note = String(t.mMemo ?? "").trim();
      const reference = String(t.szId ?? "").trim();
      if (reference) note += `${note ? "\n" : ""}Référence Money : ${reference}`;
      return {
        id: t.htrn,
        accountId: t.hacct,
        date: (t.dt as Date).toISOString().slice(0, 10),
        label: String(payee?.szFull ?? "").trim() || "Opération sans destinataire",
        category: label(t.hcat),
        amount: cents(t.amt),
        reconciled: t.cs !== 0,
        note,
      };
    });
  const scheduleResult = readMoneySchedules(
    rows("BILL"),
    tx,
    rows("TRN_XFER"),
    bank,
    payees,
    label,
  );
  return {
    schedules: scheduleResult.schedules,
    skippedSchedules: scheduleResult.skippedSchedules,
    transfers,
    warnings: [
      ...(accounts.length > bank.length
        ? [
            `${accounts.length - bank.length} compte(s) non pris en charge ou incomplets sont exclus, notamment les placements.`,
          ]
        : []),
      ...scheduleResult.warnings,
    ],
    accounts: bank.map((a) => {
      const entries = operations.filter((t) => t.accountId === a.hacct);
      const openingBalance = cents(a.amtOpen);
      return {
        id: a.hacct,
        name: String(a.szFull).trim(),
        openingBalance,
        balance: entries.reduce((sum, t) => sum + t.amount, openingBalance),
        count: entries.length,
      };
    }),
    categories: categories
      .filter((c) => c.hct === 0 && c.nLevel > 0)
      .map((c) => ({
        id: c.hcat,
        name: String(c.szFull).trim(),
        parentId: c.nLevel === 2 ? c.hcatParent : null,
      })),
    operations,
  };
}
