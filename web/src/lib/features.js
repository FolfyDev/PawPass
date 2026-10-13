/// Optional event sections an admin can switch off on the details page.
/// Keep the keys in step with server/src/lib/features.js.
export const FEATURES = [
  ['vouchers', 'Vouchers', 'Free-entry codes for staff, guests and organizers.'],
  ['volunteers', 'Volunteers', 'Shifts and volunteer sign-up.'],
  ['hotels', 'Hotels', 'Where to stay, room blocks and room requests.'],
  ['schedule', 'Schedule & panels', 'The public schedule and panel submissions.'],
  ['vendors', 'Vendors', "Dealers' den and artist alley applications."],
  ['merch', 'Merch', 'Merch sales and online pre-orders.'],
  ['kiosk', 'Kiosk', 'Registering walk-ups at the door.'],
];

export const featureOn = (event, key) => !(event?.disabledFeatures || []).includes(key);
