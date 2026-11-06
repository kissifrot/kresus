import type { Schedule, CalendarOccurrence } from "./types";

// Clamp to the last day of short months while retaining the intended day.
export function occurrencesForMonth(schedule: Schedule, monthKey: string): CalendarOccurrence[] {
  const result: CalendarOccurrence[] = [];
  if (schedule.nextDue.startsWith(monthKey)) result.push({ ...schedule, projected: false });
  const months: Record<string, number> = {
    Mensuelle: 1,
    Bimestrielle: 2,
    Trimestrielle: 3,
    Semestrielle: 6,
    Annuelle: 12,
  };
  const step = months[schedule.frequency];
  if (!step && schedule.frequency !== "Bimensuelle") return result;
  const current = new Date(`${schedule.series.nextDue}T00:00:00Z`);
  const targetEnd = `${monthKey}-31`;
  let occurrenceIndex = 1;
  while (current.toISOString().slice(0, 10) <= targetEnd) {
    // Money’s observed twice-monthly cadence alternates the 15th and month end.
    if (schedule.frequency === "Bimensuelle") {
      if (current.getUTCDate() === 15) current.setUTCMonth(current.getUTCMonth() + 1, 0);
      else current.setUTCMonth(current.getUTCMonth() + 1, 15);
    } else {
      current.setUTCDate(1);
      current.setUTCMonth(current.getUTCMonth() + step!);
    }
    const lastDay = new Date(
      Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 0),
    ).getUTCDate();
    if (schedule.frequency !== "Bimensuelle")
      current.setUTCDate(Math.min(schedule.series.anchorDay, lastDay));
    const date = current.toISOString().slice(0, 10);
    occurrenceIndex++;
    // Limits refer to the original series dates, even if the pending occurrence was moved.
    if (
      (schedule.remainingCount != null && occurrenceIndex > schedule.remainingCount) ||
      (schedule.endDate && date > schedule.endDate)
    )
      break;
    if (
      date.startsWith(monthKey) &&
      !schedule.futureOverrides?.some((item) => item.originalDue === date)
    )
      result.push({
        ...schedule.series,
        id: schedule.id,
        frequency: schedule.frequency,
        nextDue: date,
        projected: true,
        originalDue: date,
      });
  }
  // An exception can move across months, so display it by its edited date.
  for (const override of schedule.futureOverrides ?? []) {
    if (override.nextDue.startsWith(monthKey))
      result.push({ ...override, id: schedule.id, frequency: schedule.frequency, projected: true });
  }
  return result;
}
