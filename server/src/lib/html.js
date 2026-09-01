/// Escapes text for interpolation into raw HTML. Needed anywhere a response
/// is built as a template string instead of going through a templating
/// engine or React — see index.js's /t/:secret page and the bot's HTML replies,
/// both of which interpolate attendee-supplied fields (legal/fursona name).
export const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
