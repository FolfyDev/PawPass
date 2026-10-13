/// What the Telegram bot's long-polling loop is doing, for the settings
/// page's status card. index.js updates it as the bot starts and stops.
const status = { state: 'off', username: null, error: null, since: null };

export const botStatus = () => ({ ...status });

export function setBotStatus(state, extra = {}) {
  Object.assign(status, { state, error: null, since: new Date(), ...extra });
}
