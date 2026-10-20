/** The time zones the calendar can bucket days in. */
interface TimeZoneOption {
  id: string;
  label: string;
}

export const TIME_ZONES: readonly TimeZoneOption[] = [
  { id: 'Asia/Jakarta', label: 'WIB · Asia/Jakarta (UTC+7)' },
  { id: 'Asia/Makassar', label: 'WITA · Asia/Makassar (UTC+8)' },
  { id: 'Asia/Jayapura', label: 'WIT · Asia/Jayapura (UTC+9)' },
  { id: 'UTC', label: 'UTC' },
];

export const DEFAULT_TIME_ZONE = 'Asia/Jakarta';

/** Falls back to WIB for anything unknown. */
export function normalizeTimeZone(value: unknown): string {
  const id = typeof value === 'string' ? value : '';
  return TIME_ZONES.some((zone) => zone.id === id) ? id : DEFAULT_TIME_ZONE;
}
