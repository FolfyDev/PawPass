export function formatInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: '2-digit', day: '2-digit', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('month')}/${get('day')}/${get('year')} ${get('hour')}:${get('minute')}${get('dayPeriod').toLowerCase()}`;
}

export function zonedTimeToUtc(naive, timeZone) {
  if (!naive) return null;
  const asUTC = new Date(`${naive}Z`);
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
