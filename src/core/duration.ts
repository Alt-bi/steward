/**
 * How long something will take, in the words a person would use.
 *
 * Both write loops in the panel ask this question — the market tab before it
 * moves a hundred lots, the inventory tab before it lists two hundred copies —
 * and each had started to answer it its own way. Two formatters for one idea is
 * how «33 мин» and «меньше минуты» end up disagreeing about the same duration,
 * so there is one.
 */
export function humanMinutes(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  /** Under a minute and a half, seconds are what a person is actually feeling. */
  if (total < 90) return `${total} с`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
}
