import type { Schedule, CalendarOccurrence } from "./types";
import { FREQUENCY, type Frequency } from "./frequency";

// Clamp to the last day of short months while retaining the intended day.
export function occurrencesForMonth(schedule: Schedule, monthKey: string): CalendarOccurrence[] {
  const result: CalendarOccurrence[] = [];
  if (schedule.nextDue.startsWith(monthKey)) result.push({ ...schedule, projected: false });
  const months: Partial<Record<Frequency, number>> = {
    [FREQUENCY.MONTHLY]: 1,
    [FREQUENCY.EVERY_TWO_MONTHS]: 2,
    [FREQUENCY.QUARTERLY]: 3,
    [FREQUENCY.SEMIANNUAL]: 6,
    [FREQUENCY.ANNUAL]: 12,
  };
  const step = months[schedule.frequency];
  if (!step && schedule.frequency !== FREQUENCY.TWICE_MONTHLY) return result;
  const current = new Date(`${schedule.series.nextDue}T00:00:00Z`);
  const targetEnd = `${monthKey}-31`;
  let occurrenceIndex = 1;
  while (current.toISOString().slice(0, 10) <= targetEnd) {
    // Money’s observed twice-monthly cadence alternates the 15th and month end.
    if (schedule.frequency === FREQUENCY.TWICE_MONTHLY) {
      if (current.getUTCDate() === 15) current.setUTCMonth(current.getUTCMonth() + 1, 0);
      else current.setUTCMonth(current.getUTCMonth() + 1, 15);
    } else {
      current.setUTCDate(1);
      current.setUTCMonth(current.getUTCMonth() + step!);
    }
    const lastDay = new Date(
      Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 0),
    ).getUTCDate();
    if (schedule.frequency !== FREQUENCY.TWICE_MONTHLY)
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
