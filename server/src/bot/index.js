import fs from 'fs/promises';
import path from 'path';
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import QRCode from 'qrcode';
import { prisma } from '../lib/db.js';
import { env } from '../lib/env.js';
import { getSettings } from '../lib/settings.js';
import { createRegistration, RegistrationError, registrationWindowState } from '../lib/registrations.js';
import { loginCode as makeLoginCode } from '../lib/codes.js';
import { escapeHtml as esc } from '../lib/html.js';

/// Telegram doesn't reliably auto-link plain URLs (localhost during local
/// dev never gets linked at all), so any message with a link is sent with
/// parse_mode: 'HTML' and an explicit <a> tag instead. Anything interpolated
/// into one of those messages that isn't meant to be a tag — an event title,
/// a configurable welcome message — has to go through esc() first.
const link = (url, text) => `<a href="${esc(url)}">${esc(text ?? url)}</a>`;

/// The web Login Widget hands us `photo_url` directly, but that widget only
/// works over https on a domain registered with BotFather — useless on a
/// plain-http/localhost instance. Everyone who messages the bot, though, is
/// reachable through the Bot API regardless of our own domain, so this pulls
/// their profile photo that way instead and re-hosts it under our own
/// /uploads (never the raw api.telegram.org URL, which would otherwise leak
/// the bot token to the browser via its /file/bot<TOKEN>/... path).
async function cacheTelegramPhoto(bot, telegramId, userId) {
  try {
    const photos = await bot.api.getUserProfilePhotos(Number(telegramId), { limit: 1 });
    if (!photos.total_count) return;
    const fileId = photos.photos[0][0].file_id; // smallest size — plenty for an avatar
    const file = await bot.api.getFile(fileId);
    const res = await fetch(`https://api.telegram.org/file/bot${env.telegram.token}/${file.file_path}`);
    if (!res.ok) return;
    const buf = Buffer.from(await res.arrayBuffer());
    const uploadsDir = path.join(process.cwd(), 'uploads');
    await fs.mkdir(uploadsDir, { recursive: true });
    const filename = `tg-${telegramId}${path.extname(file.file_path) || '.jpg'}`;
    await fs.writeFile(path.join(uploadsDir, filename), buf);
    await prisma.user.update({ where: { id: userId }, data: { telegramPhotoUrl: `${env.publicUrl}/uploads/${filename}` } });
  } catch {
    // Profile photo can be private, missing, or briefly unreachable — never
    // worth failing a bot command over.
  }
}

/// Conversation states, in the order the bot walks through them.
const S = {
  IDLE: 'idle',
  PICK_EVENT: 'pick_event',
  LEGAL_NAME: 'legal_name',
  FURSONA_NAME: 'fursona_name',
  EMAIL: 'email',
  CUSTOM: 'custom',   // draft.fieldIndex tracks position
  TIER: 'tier',
  TOS: 'tos',
  BROADCAST_MESSAGE: 'broadcast_message',
  BROADCAST_CONFIRM: 'broadcast_confirm',
};

const BROADCAST_AUDIENCE = {
  all: { status: { in: ['CONFIRMED', 'WAITLIST'] } },
  confirmed: { status: 'CONFIRMED' },
  waitlist: { status: 'WAITLIST' },
};

/// Created eagerly (rather than inside createBot) so other modules — admin
/// routes sending a broadcast, waitlist promotion — can reach the same
/// instance via notifyUser without importing createBot and calling
/// bot.start() a second time.
export const bot = env.telegram.enabled ? new Bot(env.telegram.token) : null;

/// Best-effort DM. Never throws: a blocked bot or a stale telegramId should
/// not fail the caller's own request (a check-in, a cancellation, ...).
export async function notifyUser(telegramId, text) {
  if (!bot || !telegramId) return;
  try {
    await bot.api.sendMessage(telegramId, text);
  } catch (e) {
    console.error('telegram notify failed', telegramId, e.message);
  }
}

export function createBot() {
  if (!bot) return null;

  const load = async (ctx) => {
    const telegramId = String(ctx.from.id);
    const session = await prisma.botSession.upsert({
      where: { telegramId }, create: { telegramId }, update: {},
    });
    const user = await prisma.user.upsert({
      where: { telegramId },
      create: {
        telegramId,
        telegramUsername: ctx.from.username,
        displayName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || ctx.from.username || `tg${telegramId}`,
      },
      update: { telegramUsername: ctx.from.username },
    });
    if (!user.telegramPhotoUrl) cacheTelegramPhoto(bot, telegramId, user.id); // fire-and-forget
    return { session, user, telegramId, draft: session.draft || {} };
  };

  const save = (telegramId, state, draft) =>
    prisma.botSession.update({ where: { telegramId }, data: { state, draft } });

  const reset = (telegramId) =>
    prisma.botSession.update({ where: { telegramId }, data: { state: S.IDLE, draft: {} } });

  bot.command('start', async (ctx) => {
    const settings = await getSettings();
    const { user, telegramId } = await load(ctx);
    await reset(telegramId);
    await ctx.reply(
      `${esc(settings.botWelcome)}\n\n` +
      '/register — sign up for an event\n' +
      '/mytickets — show your tickets\n' +
      '/rsvp — say whether you\'re going\n' +
      '/going — see who else is going\n' +
      '/merch — see what is for sale\n' +
      '/login — get a code to sign in on the website\n' +
      '/cancel — stop what we are doing\n' +
      '/help — command list' +
      staffCommands(user),
      { parse_mode: 'HTML' },
    );
  });

  bot.command('help', async (ctx) => {
    const { user } = await load(ctx);
    await ctx.reply(
      'Commands:\n' +
      '/register — sign up for an event\n' +
      '/mytickets — your tickets and codes\n' +
      '/rsvp — say whether you\'re going, any time\n' +
      '/going — see who else is going\n' +
      '/merch — see what is for sale\n' +
      '/login — a one-time code for the website\n' +
      '/accept — accept the terms during registration\n' +
      '/skip — skip an optional question\n' +
      '/cancel — stop what we are doing' +
      staffCommands(user),
      { parse_mode: 'HTML' },
    );
  });

  /// Appended to /start and /help for admins/owners only — kept in one place
  /// so the two stay in sync as staff-only bot commands are added.
  const staffCommands = (user) =>
    isStaff(user) ?
    '\n\nStaff:' +
    `\nWeb access the admin panel: ${link(`${env.webUrl}/staff`)}` +
    '\n/broadcast — message everyone registered for an event'
    : '';

  bot.command('cancel', async (ctx) => {
    await reset(String(ctx.from.id));
    await ctx.reply('Stopped. Send /register whenever you want to start again.');
  });

  bot.command('register', async (ctx) => {
    const { telegramId } = await load(ctx);
    const events = await prisma.event.findMany({
      where: { published: true, endsAt: { gte: new Date() } },
      orderBy: { startsAt: 'asc' },
      take: 20,
    });
    if (!events.length) return ctx.reply('There is nothing open for registration right now.');

    if (events.length === 1) return beginEvent(ctx, telegramId, events[0]);

    const kb = new InlineKeyboard();
    events.forEach((e, i) => {
      kb.text(`${e.title} — ${e.startsAt.toDateString()}`, `pick:${e.id}`);
      if (i < events.length - 1) kb.row();
    });
    await save(telegramId, S.PICK_EVENT, {});
    await ctx.reply('Which event?', { reply_markup: kb });
  });

  bot.callbackQuery(/^pick:(.+)$/, async (ctx) => {
    const event = await prisma.event.findUnique({ where: { id: ctx.match[1] } });
    await ctx.answerCallbackQuery();
    if (!event) return ctx.reply('That event is gone. Send /register to see the current list.');
    await beginEvent(ctx, String(ctx.from.id), event);
  });

  bot.callbackQuery(/^tier:(free|donation)$/, async (ctx) => {
    const telegramId = String(ctx.from.id);
    const { session, draft } = await load(ctx);
    await ctx.answerCallbackQuery();
    if (session.state !== S.TIER) return;
    draft.tier = ctx.match[1] === 'donation' ? 'DONATION' : 'FREE';
    const event = await prisma.event.findUnique({ where: { id: draft.eventId } });
    if (!event) { await reset(telegramId); return ctx.reply('That event is gone. Send /register to see the current list.'); }
    await save(telegramId, S.TOS, draft);
    const body = (event.tosBody || '').slice(0, 3500);
    await ctx.reply(
      `${event.tosTitle}\n\n${body}\n\n` +
      'Send /accept to agree and finish, or /cancel to stop.',
    );
  });

  async function beginEvent(ctx, telegramId, event) {
    const { user } = await load(ctx);
    const existing = await prisma.registration.findUnique({
      where: { eventId_userId: { eventId: event.id, userId: user.id } },
    });
    if (existing && existing.status !== 'CANCELLED') {
      await reset(telegramId);
      return ctx.reply(`You are already registered for ${event.title}. Your code is ${existing.code}.`);
    }
    const confirmed = await prisma.registration.count({ where: { eventId: event.id, status: 'CONFIRMED' } });
    const state = registrationWindowState(event, confirmed);
    if (!state.open) { await reset(telegramId); return ctx.reply(state.reason); }

    const settings = await getSettings();
    await save(telegramId, S.LEGAL_NAME, { eventId: event.id, answers: {} });
    await ctx.reply(
      `Registering for ${event.title}.\n\n` +
      `${settings.legalNameLabel}? ${settings.legalNameHelp}`,
    );
  }

  bot.command('accept', async (ctx) => {
    const { session, user, telegramId, draft } = await load(ctx);
    if (session.state !== S.TOS) return ctx.reply('There is nothing waiting to be accepted. Send /register to start.');
    const event = await prisma.event.findUnique({ where: { id: draft.eventId } });
    try {
      const reg = await createRegistration({
        event, user,
        legalName: draft.legalName,
        fursonaName: draft.fursonaName,
        email: draft.email,
        answers: draft.answers,
        tier: draft.tier,
        source: 'telegram',
      });
      await prisma.user.update({
        where: { id: user.id },
        data: { legalName: reg.legalName, fursonaName: reg.fursonaName, email: reg.email ?? undefined },
      });
      await reset(telegramId);
      await ctx.reply(
        `You are ${reg.status === 'WAITLIST' ? 'on the waitlist' : 'registered'} for ${esc(event.title)}.\n\n` +
        `Badge code: ${reg.code}\n` +
        `Ticket and wallet pass: ${link(`${env.webUrl}/tickets`)}\n\n` +
        'Bring the QR from that page to check-in. Send /rsvp any time to update whether you\'re going.' +
        (reg.tier === 'DONATION' ? `\n\nComplete your ${esc(event.donationTierName.toLowerCase())} contribution: ${link(event.donationPaypalLink)}` : ''),
        { parse_mode: 'HTML' },
      );
    } catch (e) {
      await reset(telegramId);
      await ctx.reply(e instanceof RegistrationError ? e.message : 'Something went wrong. Try /register again.');
    }
  });

  /// Hands out a single-use sign-in code. This is the only sign-in path that
  /// works without an https domain registered via BotFather's /setdomain, so
  /// it is what you use while testing locally.
  bot.command('login', async (ctx) => {
    const { user, telegramId } = await load(ctx);
    const code = makeLoginCode();
    await prisma.loginCode.create({ data: { code, telegramId } });
    // Old codes for this person stop working the moment a new one is issued.
    await prisma.loginCode.updateMany({
      where: { telegramId, usedAt: null, code: { not: code } },
      data: { usedAt: new Date() },
    });
    await ctx.reply(
      `Your sign-in code is:\n\n${code}\n\n` +
      `Enter it at ${link(`${env.webUrl}/login`)} — it works once and expires in ${env.loginCodeTtlMinutes} minutes.`,
      { parse_mode: 'HTML' },
    );
  });

  bot.command('mytickets', async (ctx) => {
    const { user } = await load(ctx);
    const regs = await prisma.registration.findMany({
      where: { userId: user.id, status: { not: 'CANCELLED' } },
      include: { event: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!regs.length) return ctx.reply('You have no tickets yet. Send /register to get one.');
    const kb = new InlineKeyboard();
    regs.forEach((r, i) => {
      kb.text(`Show QR — ${r.event.title}`, `ticketqr:${r.id}`);
      if (i < regs.length - 1) kb.row();
    });
    await ctx.reply(
      regs.map((r) =>
        `${esc(r.event.title)}\n${r.status === 'WAITLIST' ? 'Waitlist' : 'Confirmed'} — code ${r.code}` +
        (r.checkedInAt ? '\nChecked in' : '')).join('\n\n') +
      `\n\nWallet passes: ${link(`${env.webUrl}/tickets`)}`,
      { reply_markup: kb, parse_mode: 'HTML' },
    );
  });

  bot.callbackQuery(/^ticketqr:(.+)$/, async (ctx) => {
    const { user } = await load(ctx);
    await ctx.answerCallbackQuery();
    const reg = await prisma.registration.findUnique({ where: { id: ctx.match[1] }, include: { event: true } });
    if (!reg || reg.userId !== user.id) return ctx.reply('That ticket is not yours.');
    const png = await QRCode.toBuffer(`${env.publicUrl}/t/${reg.secret}`, { width: 640, margin: 1 });
    const caption =
      `${reg.event.title}\n` +
      `Ticket number: ${reg.badgeNumber != null ? reg.badgeNumber : 'not assigned yet'}\n` +
      `Registration code: ${reg.code}`;
    await ctx.replyWithPhoto(new InputFile(png, `${reg.code}.png`), { caption });
  });

  bot.command('rsvp', async (ctx) => {
    const { user } = await load(ctx);
    const regs = await prisma.registration.findMany({
      where: { userId: user.id, status: { not: 'CANCELLED' } },
      include: { event: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!regs.length) return ctx.reply('You have no tickets yet. Send /register to get one.');
    if (regs.length === 1) return askRsvp(ctx, regs[0]);

    const kb = new InlineKeyboard();
    regs.forEach((r, i) => {
      kb.text(r.event.title, `rsvpfor:${r.id}`);
      if (i < regs.length - 1) kb.row();
    });
    await ctx.reply('Which event?', { reply_markup: kb });
  });

  bot.callbackQuery(/^rsvpfor:(.+)$/, async (ctx) => {
    const { user } = await load(ctx);
    await ctx.answerCallbackQuery();
    const reg = await prisma.registration.findUnique({ where: { id: ctx.match[1] }, include: { event: true } });
    if (!reg || reg.userId !== user.id) return ctx.reply('That ticket is not yours.');
    await askRsvp(ctx, reg);
  });

  async function askRsvp(ctx, reg) {
    const mark = (v) => (reg.rsvp === v ? '● ' : '');
    const kb = new InlineKeyboard()
      .text(`${mark('YES')}Yes`, `rsvpset:${reg.id}:YES`)
      .text(`${mark('MAYBE')}Maybe`, `rsvpset:${reg.id}:MAYBE`)
      .text(`${mark('NO')}No`, `rsvpset:${reg.id}:NO`);
    await ctx.reply(`Are you going to ${reg.event.title}?`, { reply_markup: kb });
  }

  bot.callbackQuery(/^rsvpset:(.+):(YES|MAYBE|NO)$/, async (ctx) => {
    const { user } = await load(ctx);
    const reg = await prisma.registration.findUnique({ where: { id: ctx.match[1] } });
    await ctx.answerCallbackQuery();
    if (!reg || reg.userId !== user.id) return ctx.reply('That ticket is not yours.');
    const updated = await prisma.registration.update({ where: { id: reg.id }, data: { rsvp: ctx.match[2] } });
    const label = { YES: 'You are marked as going.', MAYBE: 'You are marked as maybe going.', NO: 'You are marked as not going.' }[updated.rsvp];
    await ctx.reply(`${label} Send /rsvp any time to change it.`);
  });

  bot.command('going', async (ctx) => {
    const { user } = await load(ctx);
    const regs = await prisma.registration.findMany({
      where: { userId: user.id, status: { not: 'CANCELLED' } },
      include: { event: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!regs.length) return ctx.reply('You have no tickets yet. Send /register to get one.');
    if (regs.length === 1) return showGoing(ctx, regs[0].event);

    const kb = new InlineKeyboard();
    regs.forEach((r, i) => {
      kb.text(r.event.title, `goingfor:${r.eventId}`);
      if (i < regs.length - 1) kb.row();
    });
    await ctx.reply('Which event?', { reply_markup: kb });
  });

  bot.callbackQuery(/^goingfor:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const event = await prisma.event.findUnique({ where: { id: ctx.match[1] } });
    if (!event) return ctx.reply('That event is gone.');
    await showGoing(ctx, event);
  });

  /// Mirrors the signed-in-only /events/:slug/rsvps route on the web — same
  /// reasoning applies (surfaces Telegram usernames), but everyone the bot
  /// has ever talked to already clears that bar via load().
  async function showGoing(ctx, event) {
    const regs = await prisma.registration.findMany({
      where: { eventId: event.id, status: 'CONFIRMED', rsvp: { in: ['YES', 'MAYBE'] } },
      include: { user: true },
      orderBy: [{ rsvp: 'asc' }, { fursonaName: 'asc' }],
    });
    if (!regs.length) return ctx.reply(`Nobody has RSVPed yes or maybe to ${event.title} yet.`);
    const lines = regs.map((r) => {
      const name = r.fursonaName || r.user.displayName;
      const tag = r.user.telegramUsername ? ` (@${r.user.telegramUsername})` : '';
      return `${r.rsvp === 'MAYBE' ? '· maybe — ' : '· '}${name}${tag}`;
    });
    await ctx.reply(`Going to ${event.title}:\n\n${lines.join('\n')}`);
  }

  bot.command('merch', async (ctx) => {
    const { user } = await load(ctx);
    const regs = await prisma.registration.findMany({
      where: { userId: user.id, status: { not: 'CANCELLED' } },
      include: { event: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!regs.length) return ctx.reply('You have no tickets yet. Send /register to get one.');
    if (regs.length === 1) return showMerch(ctx, regs[0].event);

    const kb = new InlineKeyboard();
    regs.forEach((r, i) => {
      kb.text(r.event.title, `merchfor:${r.eventId}`);
      if (i < regs.length - 1) kb.row();
    });
    await ctx.reply('Which event?', { reply_markup: kb });
  });

  bot.callbackQuery(/^merchfor:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const event = await prisma.event.findUnique({ where: { id: ctx.match[1] } });
    if (!event) return ctx.reply('That event is gone.');
    await showMerch(ctx, event);
  });

  async function showMerch(ctx, event) {
    const items = await prisma.merchItem.findMany({ where: { eventId: event.id }, orderBy: { createdAt: 'asc' } });
    if (!items.length) return ctx.reply(`Nothing for sale at ${event.title} yet.`);
    const lines = items.map((i) => {
      const remaining = Math.max(i.maxCount - i.soldCount, 0);
      const price = i.price != null ? ` — $${Number(i.price).toFixed(2)}` : '';
      return `· ${i.name}${price} (${remaining > 0 ? `${remaining} left` : 'sold out'})`;
    });
    await ctx.reply(`Merch at ${event.title}:\n\n${lines.join('\n')}`);
  }

  /* ---------------- admin: broadcast ---------------- */

  const isStaff = (user) => user.role === 'ADMIN' || user.role === 'OWNER';

  bot.command('broadcast', async (ctx) => {
    const { user } = await load(ctx);
    if (!isStaff(user)) return;
    const events = await prisma.event.findMany({ orderBy: { startsAt: 'desc' }, take: 20 });
    if (!events.length) return ctx.reply('There are no events yet.');
    const kb = new InlineKeyboard();
    events.forEach((e, i) => {
      kb.text(e.title, `bcastevent:${e.id}`);
      if (i < events.length - 1) kb.row();
    });
    await ctx.reply('Broadcast to attendees of which event?', { reply_markup: kb });
  });

  bot.callbackQuery(/^bcastevent:(.+)$/, async (ctx) => {
    const { user } = await load(ctx);
    await ctx.answerCallbackQuery();
    if (!isStaff(user)) return;
    const event = await prisma.event.findUnique({ where: { id: ctx.match[1] } });
    if (!event) return ctx.reply('That event is gone.');
    const kb = new InlineKeyboard()
      .text('Everyone', `bcastaudience:${event.id}:all`).row()
      .text('Confirmed only', `bcastaudience:${event.id}:confirmed`).row()
      .text('Waitlist only', `bcastaudience:${event.id}:waitlist`);
    await ctx.reply(`Who should receive this for ${event.title}?`, { reply_markup: kb });
  });

  bot.callbackQuery(/^bcastaudience:(.+):(all|confirmed|waitlist)$/, async (ctx) => {
    const { user, telegramId } = await load(ctx);
    await ctx.answerCallbackQuery();
    if (!isStaff(user)) return;
    const event = await prisma.event.findUnique({ where: { id: ctx.match[1] } });
    if (!event) return ctx.reply('That event is gone.');
    const audience = ctx.match[2];
    const count = await prisma.registration.count({
      where: { eventId: event.id, ...BROADCAST_AUDIENCE[audience], user: { telegramId: { not: null } } },
    });
    if (!count) return ctx.reply('Nobody in that group has a Telegram account on file.');
    await save(telegramId, S.BROADCAST_MESSAGE, { eventId: event.id, audience });
    await ctx.reply(
      `This will reach ${count} ${count === 1 ? 'person' : 'people'} for ${event.title}. ` +
      'Send the message now, or /cancel to stop.',
    );
  });

  bot.callbackQuery('bcastsend', async (ctx) => {
    const { session, user, telegramId, draft } = await load(ctx);
    await ctx.answerCallbackQuery();
    if (!isStaff(user)) return;
    if (session.state !== S.BROADCAST_CONFIRM) return ctx.reply('There is nothing queued. Send /broadcast to start.');
    await reset(telegramId);
    const event = await prisma.event.findUnique({ where: { id: draft.eventId } });
    if (!event) return ctx.reply('That event is gone.');
    const recipients = await prisma.registration.findMany({
      where: { eventId: event.id, ...BROADCAST_AUDIENCE[draft.audience], user: { telegramId: { not: null } } },
      include: { user: true },
    });
    let sent = 0;
    for (const reg of recipients) {
      try {
        await bot.api.sendMessage(reg.user.telegramId, `📣 ${event.title}\n\n${draft.message}`);
        sent++;
      } catch (e) {
        console.error('broadcast failed', reg.user.telegramId, e.message);
      }
    }
    await ctx.reply(`Sent to ${sent} of ${recipients.length}.`);
  });

  bot.callbackQuery('bcastcancel', async (ctx) => {
    const { telegramId } = await load(ctx);
    await ctx.answerCallbackQuery();
    await reset(telegramId);
    await ctx.reply('Broadcast cancelled.');
  });

  bot.command('skip', (ctx) => handleText(ctx, ''));
  bot.on('message:text', (ctx) => handleText(ctx, ctx.message.text.trim()));

  async function handleText(ctx, text) {
    if (text.startsWith('/')) return;
    const { session, telegramId, draft } = await load(ctx);
    const settings = await getSettings();

    switch (session.state) {
      case S.LEGAL_NAME: {
        if (text.length < 2) return ctx.reply('Please send your full legal name.');
        draft.legalName = text;
        if (!settings.askFursonaName) { draft.fursonaName = ''; return askEmail(); }
        await save(telegramId, S.FURSONA_NAME, draft);
        return ctx.reply(`${settings.fursonaNameLabel}? This is the big name on your badge. Send /skip to use your legal name.`);
      }
      case S.FURSONA_NAME: {
        draft.fursonaName = text;
        return askEmail();
      }
      case S.EMAIL: {
        if (text && !/^\S+@\S+\.\S+$/.test(text)) return ctx.reply('That does not look like an email. Try again or /skip.');
        draft.email = text || null;
        return askCustom(0);
      }
      case S.CUSTOM: {
        const event = await prisma.event.findUnique({ where: { id: draft.eventId } });
        const fields = event.customFields || [];
        const field = fields[draft.fieldIndex];
        if (field.required && !text) return ctx.reply(`${field.label} is required.`);
        if (text) draft.answers[field.key] = text;
        return askCustom(draft.fieldIndex + 1);
      }
      case S.BROADCAST_MESSAGE: {
        if (!text) return ctx.reply('Send some text to broadcast, or /cancel to stop.');
        const event = await prisma.event.findUnique({ where: { id: draft.eventId } });
        if (!event) { await reset(telegramId); return ctx.reply('That event is gone.'); }
        draft.message = text;
        await save(telegramId, S.BROADCAST_CONFIRM, draft);
        const kb = new InlineKeyboard().text('Send it', 'bcastsend').text('Cancel', 'bcastcancel');
        return ctx.reply(`Preview:\n\n${text}\n\nSend this to ${event.title}?`, { reply_markup: kb });
      }
      default:
        return ctx.reply('Send /register to sign up, or /mytickets to see your codes.');
    }

    async function askEmail() {
      await save(telegramId, S.EMAIL, draft);
      return ctx.reply('Email for updates? Send /skip if you would rather not.');
    }

    async function askCustom(index) {
      const event = await prisma.event.findUnique({ where: { id: draft.eventId } });
      const fields = event.customFields || [];
      if (index >= fields.length) return askTier(event);
      const field = fields[index];
      draft.fieldIndex = index;
      await save(telegramId, S.CUSTOM, draft);
      const opts = field.options?.length ? `\nOptions: ${field.options.join(', ')}` : '';
      return ctx.reply(`${field.label}${field.required ? '' : ' (optional — /skip)'}${opts}`);
    }

    async function askTier(event) {
      if (!event.donationPaypalLink) {
        draft.tier = 'FREE';
        return askTos(event);
      }
      await save(telegramId, S.TIER, draft);
      const kb = new InlineKeyboard().text('Free', 'tier:free').text(event.donationTierName, 'tier:donation');
      return ctx.reply('Choose a tier:', { reply_markup: kb });
    }

    async function askTos(event) {
      await save(telegramId, S.TOS, draft);
      const body = (event.tosBody || '').slice(0, 3500);
      return ctx.reply(
        `${event.tosTitle}\n\n${body}\n\n` +
        'Send /accept to agree and finish, or /cancel to stop.',
      );
    }
  }

  bot.catch((err) => console.error('bot error', err));
  return bot;
}
