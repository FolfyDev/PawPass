import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { upgradeBackup, BACKUP_VERSION } from '../src/lib/backup.js';

describe('backup upgrades', () => {
  test('converts a v1 backup the same way the v2 migration converts a live database', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const v1 = {
      meta: { version: 1 },
      data: {
        event: [
          { id: 'plain', donationTierName: 'Supporter', donationPaypalLink: null, donationRequired: false },
          { id: 'don', donationTierName: 'Patron', donationPaypalLink: 'https://paypal.me/x', donationRequired: false },
          { id: 'req', donationTierName: 'Supporter', donationPaypalLink: 'https://paypal.me/y', donationRequired: true },
        ],
        registration: [
          { id: 'r1', eventId: 'plain', tier: 'FREE', createdAt: at },
          { id: 'r2', eventId: 'don', tier: 'DONATION', paymentMethod: 'CASH', paymentAmount: 12.5, paymentNote: 'tip', createdAt: at },
          { id: 'r3', eventId: 'don', tier: 'FREE', voucherCodeId: 'v1', createdAt: at },
          { id: 'r4', eventId: 'req', tier: 'DONATION', createdAt: at },
        ],
      },
    };

    const { meta, data } = upgradeBackup(v1);
    assert.equal(meta.version, BACKUP_VERSION);

    const tiers = (eventId) => data.ticketTier.filter((t) => t.eventId === eventId).map((t) => [t.name, t.active]);
    assert.deepEqual(tiers('plain'), [['Attendee', true]]);
    assert.deepEqual(tiers('don'), [['Attendee', true], ['Patron', false]]);
    assert.deepEqual(tiers('req'), [['Supporter', false]]);

    const reg = (id) => data.registration.find((r) => r.id === id);
    assert.equal(reg('r1').tierName, 'Attendee');
    assert.equal(reg('r2').tierName, 'Patron');
    assert.equal(reg('r3').ticketTierId, null, 'voucher redemptions get no tier');
    assert.equal(reg('r4').tierName, 'Supporter');
    for (const r of data.registration) {
      assert.ok(!('tier' in r) && !('paymentMethod' in r) && !('paymentAmount' in r));
    }
    for (const e of data.event) assert.ok(!('donationPaypalLink' in e));

    assert.deepEqual(data.payment.map((p) => [p.registrationId, p.method, p.status, p.amountCents, p.note]), [['r2', 'CASH', 'PAID', 1250, 'tip']]);
  });

  test('passes a current backup through untouched and rejects unknown versions', () => {
    const current = { meta: { version: BACKUP_VERSION }, data: { event: [] } };
    assert.deepEqual(upgradeBackup(current), current);
    assert.throws(() => upgradeBackup({ meta: { version: 99 }, data: {} }));
    assert.throws(() => upgradeBackup({ data: {} }));
  });
});
