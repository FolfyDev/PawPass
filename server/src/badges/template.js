/// Common Zebra label stock. The ZD500 feeds continuous or die-cut rolls, so
/// what matters is the die size — pick the one loaded in the printer.
export const LABEL_PRESETS = [
  { name: '2.25 × 1.25 in', widthMm: 57.15, heightMm: 31.75 },
  { name: '3 × 1 in',       widthMm: 76.2,  heightMm: 25.4 },
  { name: '3 × 2 in',       widthMm: 76.2,  heightMm: 50.8 },
  { name: '4 × 2 in',       widthMm: 101.6, heightMm: 50.8 },
  { name: '4 × 1 in',       widthMm: 101.6, heightMm: 25.4 },
];

/// The default badge: a landscape card sized to match the schema defaults
/// (85.6 × 54mm — CR80, the standard ID-card size). A tiny QR sits bottom-left
/// for the door scanner, the fursona name is bold and centred, the tier reads
/// top-to-bottom in an accent-coloured strip along the right edge, and the
/// sequential badge number sits top-left.
///
/// The tier strip is a rotated text element — see `rotate` in render.js. Its
/// box is defined as if the text were horizontal and as long as the strip is
/// tall, then rotated 90° around its own centre, which lands it inside the
/// strip regardless of the box extending past the card's top/bottom edges
/// before rotation.
export const STARTER_TEMPLATE = {
  name: 'Default badge',
  widthMm: 85.6,
  heightMm: 54,
  dpi: 300,
  background: '#0E1116',
  elements: [
    { id: 'tier_strip', type: 'rect', x: 73.6, y: 0, w: 12, h: 54, fill: '{{accent}}' },
    { id: 'qr_backing', type: 'rect', x: 3, y: 36, w: 15, h: 15, fill: '#FFFFFF', radius: 1.5 },
    { id: 'qr', type: 'qr', x: 4, y: 37, w: 13, h: 13, value: '{{qr_payload}}',
      ecc: 'M', dark: '#000000', light: '#FFFFFF' },
    { id: 'fursona', type: 'text', x: 4, y: 15, w: 66, h: 24, text: '{{fursona_name}}',
      font: 'DejaVu Sans', size: 8.5, weight: 800, color: '#FFFFFF', align: 'center', fit: true },
    { id: 'badge_number', type: 'text', x: 4, y: 4, w: 34, h: 6, text: 'No. {{badge_number}}',
      font: 'DejaVu Sans Mono', size: 4, weight: 600, color: '#FFFFFF', align: 'left', letterSpacing: 0.05 },
    { id: 'tier', type: 'text', x: 56.6, y: 23, w: 46, h: 8, rotate: 90, text: '{{tier_name}}',
      font: 'DejaVu Sans', size: 4.2, weight: 700, color: '#FFFFFF', align: 'center',
      uppercase: true, letterSpacing: 0.3 },
  ],
};

/// Every placeholder available in a template, with sample values so the
/// designer can preview a layout without a real attendee.
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
};
