/** When a chat was last active, for the chats page: "5 minutes ago", "Yesterday", "Nov 9". */
export function lastActive(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.floor((now.getTime() - d.getTime()) / 60000);
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (mins < 1) return 'Just now';
  if (mins < 60) return plural(mins, 'minute');
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (d >= midnight) return plural(Math.floor(mins / 60), 'hour');
  const days = Math.ceil((midnight.getTime() - d.getTime()) / 86_400_000);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

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
