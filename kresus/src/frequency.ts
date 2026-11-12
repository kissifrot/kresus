// Persisted values are shared with Rust and must remain compatible with existing databases.
export const FREQUENCY = {
  MONTHLY: "Mensuelle",
  TWICE_MONTHLY: "Bimensuelle",
  EVERY_TWO_MONTHS: "Bimestrielle",
  QUARTERLY: "Trimestrielle",
  SEMIANNUAL: "Semestrielle",
  ANNUAL: "Annuelle",
} as const;

export type Frequency = (typeof FREQUENCY)[keyof typeof FREQUENCY];
