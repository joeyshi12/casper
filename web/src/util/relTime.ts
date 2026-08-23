/** An age like "5m". `long` spells it out for prose: "5m ago". */
export function relTime(iso: string, long = false): string {
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return '';
  const mins = Math.round((Date.now() - d) / 60000);
  const ago = (v: string) => (long ? `${v} ago` : v);
  if (mins < 1) return long ? 'just now' : 'now';
  if (mins < 60) return ago(`${mins}m`);
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return ago(`${hrs}h`);
  return ago(`${Math.round(hrs / 24)}d`);
}
