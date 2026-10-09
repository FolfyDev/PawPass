import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/db.js';
import { sendKnowBeforeYouGo, sendThankYous } from '../src/lib/reminders.js';
import { resetDb, closeDb, createEvent, createStaff, nextEmail } from './helpers/db.js';

const hour = 3600_000;

describe('account data, per-tier questions, event messages', () => {
  beforeEach(async () => { await resetDb(); });
  after(async () => { await closeDb(); });

  /// Registers as a guest; the response's session cookie signs the agent in.
  async function guest(event, body = {}) {
    const agent = request.agent(app);
    const res = await agent.post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'Jane Doe', email: nextEmail(), acceptedTos: true, ticketTierId: event.ticketTiers[0].id, ...body });
    return { agent, res };
  }

  test('download my data includes the account and its registrations', async () => {
    const event = await createEvent();
    const { agent, res } = await guest(event, { fursonaName: 'Jay' });
    const data = await agent.get('/api/my/data');
    assert.equal(data.status, 200);
    const body = JSON.parse(data.text);
    assert.equal(body.registrations[0].code, res.body.code);
    assert.equal(body.registrations[0].fursonaName, 'Jay');
    assert.ok(body.account.email.includes('@'));
  });

  test('delete my account needs upcoming tickets cancelled first, then anonymises and signs out', async () => {
    const event = await createEvent();
    const { agent, res } = await guest(event);

    const blocked = await agent.post('/api/my/account/delete').send({ confirm: 'DELETE' });
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error, /Cancel your ticket/);

    await agent.post(`/api/my/tickets/${res.body.code}/cancel`).send({});
    assert.equal((await agent.post('/api/my/account/delete').send({ confirm: 'nope' })).status, 400);
    const ok = await agent.post('/api/my/account/delete').send({ confirm: 'DELETE' });
    assert.equal(ok.status, 200);

    const reg = await prisma.registration.findUnique({ where: { code: res.body.code }, include: { user: true } });
    assert.equal(reg.legalName, 'Deleted user');
    assert.equal(reg.email, null);
    assert.equal(reg.user.email, null);
    assert.equal(reg.user.displayName, 'Deleted user');
    assert.equal((await agent.get('/api/my/tickets')).status, 401, 'old session no longer works');
  });

  test('staff accounts cannot delete themselves', async () => {
    const { user, password } = await createStaff({ role: 'OWNER' });
    const agent = request.agent(app);
    await agent.post('/api/auth/password').send({ email: user.email, password });
    assert.equal((await agent.post('/api/my/account/delete').send({ confirm: 'DELETE' })).status, 400);
  });

  test('a question limited to one tier is only required on that tier', async () => {
    const event = await createEvent({}, { tiers: [{ name: 'Attendee' }, { name: 'Sponsor' }] });
    const [attendee, sponsor] = event.ticketTiers;
    await prisma.event.update({
      where: { id: event.id },
      data: { customFields: [{ key: 'shirt', label: 'Shirt size', type: 'text', required: true, tierIds: [sponsor.id] }] },
    });
    const free = await request(app).post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'Free Person', email: nextEmail(), acceptedTos: true, ticketTierId: attendee.id });
    assert.equal(free.status, 200);
    const sponsorNoAnswer = await request(app).post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'Sponsor Person', email: nextEmail(), acceptedTos: true, ticketTierId: sponsor.id });
    assert.equal(sponsorNoAnswer.status, 400);
    const sponsorOk = await request(app).post(`/api/events/${event.slug}/register`)
      .send({ legalName: 'Sponsor Person', email: nextEmail(), acceptedTos: true, ticketTierId: sponsor.id, answers: { shirt: 'L' } });
    assert.equal(sponsorOk.status, 200);
  });

  test('"know before you go" goes out once, inside its window', async () => {
    const event = await createEvent({ kbygEnabled: true, kbygDaysBefore: 3, startsAt: new Date(Date.now() + 48 * hour), endsAt: new Date(Date.now() + 50 * hour) });
    const { res } = await guest(event);
    await sendKnowBeforeYouGo();
    const first = (await prisma.registration.findUnique({ where: { code: res.body.code } })).kbygSentAt;
    assert.ok(first);
    await sendKnowBeforeYouGo();
    assert.equal((await prisma.registration.findUnique({ where: { code: res.body.code } })).kbygSentAt.getTime(), first.getTime());

    const later = await createEvent({ kbygEnabled: true, kbygDaysBefore: 1, startsAt: new Date(Date.now() + 72 * hour), endsAt: new Date(Date.now() + 74 * hour) });
    const { res: early } = await guest(later, { legalName: 'Too Early' });
    await sendKnowBeforeYouGo();
    assert.equal((await prisma.registration.findUnique({ where: { code: early.body.code } })).kbygSentAt, null);
  });

  test('the thank-you goes to people who checked in', async () => {
    const event = await createEvent({ thanksEnabled: true, feedbackUrl: 'https://example.com/survey', startsAt: new Date(Date.now() - 5 * hour), endsAt: new Date(Date.now() - hour) });
    const { res: came } = await guest(event);
    const { res: noShow } = await guest(event, { legalName: 'No Show' });
    await prisma.registration.update({ where: { code: came.body.code }, data: { checkedInAt: new Date() } });
    await sendThankYous();
    assert.ok((await prisma.registration.findUnique({ where: { code: came.body.code } })).thanksSentAt);
    assert.equal((await prisma.registration.findUnique({ where: { code: noShow.body.code } })).thanksSentAt, null);
  });
});
