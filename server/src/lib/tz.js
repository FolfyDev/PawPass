/// Converts a naive "YYYY-MM-DDTHH:mm" string — the kind an <input
/// type="datetime-local"> produces, with no timezone attached — into the UTC
/// instant it represents when read as wall-clock time in `timeZone`.
///
/// The server always runs in UTC (containers default to it), so a plain
/// `new Date(naive)` silently treats the string as UTC regardless of which
/// timezone the event is actually in — a 9am Eastern event ends up stored as
/// 9am UTC, i.e. 4-5 hours off. This corrects for that using each event's own
/// IANA timezone rather than hardcoding one, so it stays right across DST.
///
/// Method: read the naive string as if it were UTC to get a reference
/// instant, ask Intl what that instant looks like when displayed in
/// `timeZone`, and the gap between the two is exactly that zone's offset at
/// that date — then subtract it back out.
export function zonedTimeToUtc(naive, timeZone) {
  if (!naive) return null;
  const asUTC = new Date(`${naive}Z`); // "YYYY-MM-DDTHH:mm[:ss]" + Z is valid ISO-8601
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(asUTC).map((p) => [p.type, p.value]));
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const asZoned = Date.UTC(parts.year, parts.month - 1, parts.day, hour, parts.minute, parts.second);
  const offset = asZoned - asUTC.getTime();
  return new Date(asUTC.getTime() - offset);
}
