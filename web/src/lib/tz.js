// Renders a stored UTC instant as the wall-clock string an
// <input type="datetime-local"> expects — in the event's own timezone, not
// the browser's. Editing and re-saving that string goes back through the
// same zone server-side (see zonedTimeToUtc in server/src/lib/tz.js), so the
// round trip is consistent regardless of what timezone the admin is sitting in.
const DT_PARTS = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
export const localInZone = (d, tz) => {
  if (!d) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { ...DT_PARTS, timeZone: tz || 'UTC' }).formatToParts(new Date(d)).map((p) => [p.type, p.value]),
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
};
