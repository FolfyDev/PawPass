// RFC 5545 TEXT escaping — backslash, semicolon, comma, and literal newlines
// all need escaping inside a calendar text value.
const escapeText = (s) => String(s ?? '')
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/// Builds a single-event .ics file client-side and triggers a download —
/// no server round-trip, since everything needed is already on the page.
export function downloadEventIcs({ uid, title, venue, startsAt, endsAt, description }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PawPass//EN',
    'BEGIN:VEVENT',
    `UID:${uid}@pawpass`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(startsAt)}`,
    `DTEND:${stamp(endsAt)}`,
    `SUMMARY:${escapeText(title)}`,
    ...(venue ? [`LOCATION:${escapeText(venue)}`] : []),
    ...(description ? [`DESCRIPTION:${escapeText(description)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(title || 'event').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
