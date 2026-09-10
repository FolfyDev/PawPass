/// Common Zebra label stock. The ZD500 feeds continuous or die-cut rolls, so
/// what matters is the die size — pick the one loaded in the printer.
export const LABEL_PRESETS = [
  { name: '2.25 × 1.25 in', widthMm: 57.15, heightMm: 31.75 },
  { name: '3 × 1 in',       widthMm: 76.2,  heightMm: 25.4 },
  { name: '3 × 2 in',       widthMm: 76.2,  heightMm: 50.8 },
  { name: '4 × 2 in',       widthMm: 101.6, heightMm: 50.8 },
  { name: '4 × 1 in',       widthMm: 101.6, heightMm: 25.4 },
];

export const STARTER_TEMPLATE = {
  name: 'Default badge',
  widthMm: 76.2,
  heightMm: 25.4,
  dpi: 300,
  background: '#FFFFFF',
  elements: [
    { id: 'aztec', type: 'aztec', x: 2, y: 2, w: 10, h: 10, value: '{{badge_payload}}',
      dark: '#000000', light: '#FFFFFF' },
    { id: 'qualifier', type: 'text', x: 45, y: 3, w: 29.2, h: 5, text: '{{special_qualifier}}',
      font: 'DejaVu Sans', size: 3.6, weight: 600, color: '#000000', align: 'right', fit: true },
    { id: 'fursona', type: 'text', x: 4, y: 9, w: 68.2, h: 9, text: '{{fursona_name}}',
      font: 'DejaVu Sans', size: 8, weight: 800, color: '#000000', align: 'center', fit: true },
    { id: 'badge_number', type: 'text', x: 2, y: 20.4, w: 20, h: 4, text: '{{badge_number}}',
      font: 'DejaVu Sans Mono', size: 3.2, weight: 600, color: '#000000', align: 'left', letterSpacing: 0.05 },
    { id: 'tier', type: 'text', x: 45, y: 20.4, w: 29.2, h: 4, text: '{{tier_name}}',
      font: 'DejaVu Sans', size: 3.4, weight: 700, color: '#000000', align: 'right',
      uppercase: true, letterSpacing: 0.2, fit: true },
  ],
};

export const BADGE_TOKENS = {
  '{{fursona_name}}': 'Sample Fox',
  '{{legal_name}}': 'Alex Sample',
  '{{code}}': 'K4M2-9XQ7',
  '{{event_title}}': 'Red Line FurRide',
  '{{event_dates}}': 'Sat 12 Sep',
  '{{venue}}': 'Alewife Station',
  '{{badge_line}}': 'Attendee',
  '{{qr_payload}}': 'https://example.com/t/sample',
  '{{accent}}': '#FF5B04',
  '{{tier_name}}': 'Supporter',
  '{{badge_tier}}': 'Organizer',
  '{{badge_number}}': '042',
  '{{special_qualifier}}': 'Photographer',
  '{{badge_payload}}': 'K4M2-9XQ7|Supporter|Folfy',
};
