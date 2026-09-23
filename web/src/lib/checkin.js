// Calendar day (YYYY-MM-DD) of an instant, as seen in the event's own
// timezone, so "is it event day" doesn't depend on where the door laptop is.
function dayKey(date, timeZone) {
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit' };
  try {
    return new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: timeZone || undefined }).format(new Date(date));
  } catch {
    return new Intl.DateTimeFormat('en-CA', opts).format(new Date(date));
  }
}

function fmtDay(date, timeZone) {
  const opts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
  try {
    return new Date(date).toLocaleDateString(undefined, { ...opts, timeZone: timeZone || undefined });
  } catch {
    return new Date(date).toLocaleDateString(undefined, opts);
  }
}

export function eventDayState(event, now = new Date()) {
  const today = dayKey(now, event.timezone);
  if (today < dayKey(event.startsAt, event.timezone)) return 'upcoming';
  if (today > dayKey(event.endsAt, event.timezone)) return 'ended';
  return 'today';
}

const cameraAvailable = () => typeof window !== 'undefined' && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;

// level: 'pass' | 'warn' | 'fail'. A fail blocks check-in until someone
// explicitly overrides it; a warn is shown but never blocks.
export function runPreflight(event) {
  const day = eventDayState(event);
  const checks = [];

  checks.push(day === 'today'
    ? { id: 'date', level: 'pass', label: 'Event day', detail: 'Today is within this event’s dates.' }
    : {
      id: 'date', level: 'fail', label: 'Event day',
      detail: day === 'upcoming'
        ? `This event hasn’t started yet. It begins ${fmtDay(event.startsAt, event.timezone)}.`
        : `This event already ended on ${fmtDay(event.endsAt, event.timezone)}.`,
    });

  checks.push(event.published
    ? { id: 'published', level: 'pass', label: 'Published', detail: 'The event is live.' }
    : { id: 'published', level: 'fail', label: 'Published', detail: 'This event is still a draft and has not been published.' });

  checks.push(event.registrationCount > 0
    ? { id: 'registrations', level: 'pass', label: 'Registrations', detail: `${event.registrationCount} registered.` }
    : { id: 'registrations', level: 'warn', label: 'Registrations', detail: 'Nobody has registered for this event yet, so there is nobody to check in.' });

  checks.push(cameraAvailable()
    ? { id: 'camera', level: 'pass', label: 'Camera', detail: 'Camera scanning is available.' }
    : { id: 'camera', level: 'warn', label: 'Camera', detail: 'The camera needs HTTPS (or localhost) on this device. You can still check people in by typing their badge code.' });

  return checks;
}
