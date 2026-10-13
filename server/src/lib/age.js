import { dayIn } from './checkins.js';

/// The event's age check: a date of birth asked on registration, and anyone
/// under event.minorAge on the event's first day flagged at check-in. A
/// minor can also be asked for a parent or guardian's name (guardianMode).

export const GUARDIAN_MODES = ['off', 'optional', 'required'];

export class AgeError extends Error {}

/// YYYY-MM-DD (what a date input sends) or DD/MM/YYYY-ish typed into the bot
/// is not accepted: only the unambiguous form, so 03/04 can't mean two days.
export function parseBirthDate(value) {
  const s = String(value || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new AgeError('Enter your date of birth as YYYY-MM-DD, e.g. 2001-04-23.');
  const [y, mo, d] = m.slice(1).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) throw new AgeError("That date doesn't exist.");
  if (date > new Date()) throw new AgeError("A date of birth can't be in the future.");
  if (y < new Date().getUTCFullYear() - 120) throw new AgeError('Check the year of your date of birth.');
  return s;
}

/// Whole years old on `day` (YYYY-MM-DD).
export function ageOn(birthDate, day) {
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [y, m, d] = day.split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/// Age on the event's first day, in its own time zone.
export const ageAtEvent = (birthDate, event) => ageOn(birthDate, dayIn(event.startsAt, event.timezone));

export const isMinor = (birthDate, event) => Boolean(event.ageCheckEnabled && birthDate && ageAtEvent(birthDate, event) < event.minorAge);

/// For createRegistration: the checked birthDate and guardianName to store.
/// Staff adding someone (requireDob false) may leave the date out.
export function checkAge(event, { birthDate, guardianName }, { requireDob = true } = {}) {
  if (!event.ageCheckEnabled) return { birthDate: null, guardianName: null };
  if (!birthDate) {
    if (requireDob) throw new AgeError('Date of birth is required for this event.');
    return { birthDate: null, guardianName: null };
  }
  const dob = parseBirthDate(birthDate);
  const guardian = String(guardianName || '').trim().slice(0, 200);
  if (!isMinor(dob, event) || event.guardianMode === 'off') return { birthDate: dob, guardianName: null };
  if (event.guardianMode === 'required' && !guardian && requireDob) throw new AgeError(`Attendees under ${event.minorAge} need a parent or guardian's name.`);
  return { birthDate: dob, guardianName: guardian || null };
}

/// What the door scanner shows: null for adults or when the check is off.
export function minorFlag(reg, event) {
  if (!isMinor(reg.birthDate, event)) return null;
  return { age: ageAtEvent(reg.birthDate, event), under: event.minorAge, guardianName: reg.guardianName || null };
}
