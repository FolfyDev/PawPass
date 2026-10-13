/// Optional sections of an event that an admin can switch off on the details
/// page. Off hides the section from the event's admin menu and the public
/// site; its data is kept, so turning it back on picks up where it left off.
/// Event.disabledFeatures lists the ones that are off, so a new feature is
/// on for existing events. Keep in step with web/src/lib/features.js.
///
/// `flags` are the section's own "show it publicly" switches. Turning the
/// feature off forces them off too, which is what keeps the public routes
/// (and the bot) from serving it without each one checking the feature.
export const FEATURES = {
  vouchers: { flags: [] },
  volunteers: { flags: ['volunteersEnabled'] },
  hotels: { flags: ['hotelsEnabled'] },
  schedule: { flags: ['scheduleEnabled', 'submissionsOpen'] },
  vendors: { flags: ['vendorsOpen'] },
  merch: { flags: [] },
  kiosk: { flags: [] },
};

export const featureOn = (event, key) => !(event.disabledFeatures || []).includes(key);

/// Only known keys, once each.
export const cleanDisabledFeatures = (list) =>
  [...new Set((Array.isArray(list) ? list : []).map(String))].filter((k) => k in FEATURES);

/// For an event update: switches off the public flags of every feature that
/// ends up disabled, whether it was just turned off or already was.
export function applyDisabledFeatures(data, disabled) {
  for (const key of disabled) for (const flag of FEATURES[key]?.flags || []) data[flag] = false;
  return data;
}
