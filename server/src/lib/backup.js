import { nanoid } from 'nanoid';
import { STAFF_DEFAULTS } from './permissions.js';

/// Version of the data.json inside a backup zip. Bump it alongside any schema
/// migration that changes the shape of a backed-up model, and add a step to
/// UPGRADES below so older backups still restore.
export const BACKUP_VERSION = 10;

/// Each step converts a backup from version N to N + 1. They mirror the SQL
/// migrations in prisma/migrations — a restore of an old backup should end up
/// exactly where migrating the live database would have.
const UPGRADES = {
  /// v1 -> v2: see prisma/migrations/0002_v2_ticket_tiers_stripe for the
  /// reasoning behind each choice; this is the same conversion in JS.
  1(data) {
    const regs = data.registration || [];
    const events = data.event || [];
    const tiers = [];
    const tierFor = {};

    for (const e of events) {
      const regsHere = regs.filter((r) => r.eventId === e.id);
      const now = new Date();
      if (!e.donationRequired || regsHere.some((r) => r.tier === 'FREE' && !r.voucherCodeId)) {
        const t = { id: `tt${nanoid(24)}`, eventId: e.id, name: 'Attendee', description: 'Standard registration', priceCents: 0, sortOrder: 0, active: true, createdAt: now, updatedAt: now };
        tiers.push(t);
        tierFor[`${e.id}:FREE`] = t;
      }
      if (e.donationPaypalLink || regsHere.some((r) => r.tier === 'DONATION')) {
        const t = {
          id: `tt${nanoid(24)}`, eventId: e.id, name: e.donationTierName || 'Supporter',
          description: 'Carried over from the v1 PayPal donation tier. Set a price and mark it active to sell it through Stripe.',
          priceCents: 0, sortOrder: 1, active: false, createdAt: now, updatedAt: now,
        };
        tiers.push(t);
        tierFor[`${e.id}:DONATION`] = t;
      }
      delete e.donationTierName;
      delete e.donationPaypalLink;
      delete e.donationRequired;
    }

    const payments = [];
    for (const r of regs) {
      const t = r.voucherCodeId ? null : tierFor[`${r.eventId}:${r.tier === 'DONATION' ? 'DONATION' : 'FREE'}`];
      r.ticketTierId = t?.id ?? null;
      r.tierName = t?.name ?? null;
      if (r.paymentMethod) {
        payments.push({
          id: `pm${nanoid(24)}`, registrationId: r.id, method: r.paymentMethod, status: 'PAID',
          amountCents: Math.round((r.paymentAmount || 0) * 100), note: r.paymentNote || null,
          paidAt: r.createdAt, createdAt: r.createdAt, updatedAt: new Date(),
        });
      }
      delete r.tier;
      delete r.paymentMethod;
      delete r.paymentAmount;
      delete r.paymentNote;
    }

    return { ...data, ticketTier: tiers, payment: payments };
  },
  /// v2 -> v3 (0003_payments_addons): only new tables and defaulted columns.
  2(data) {
    return { discountCode: [], merchOrder: [], merchOrderItem: [], ...data };
  },
  /// v3 -> v4 (0007_volunteers): only new tables and defaulted columns.
  3(data) {
    return { volunteerShift: [], volunteerSignup: [], ...data };
  },
  /// v4 -> v5 (0008_hotels): only new tables and defaulted columns.
  4(data) {
    return { hotel: [], roomBlock: [], roomBlockNight: [], roomReservation: [], ...data };
  },
  /// v5 -> v6 (0009_checkin_days): every check-in becomes one ENTRY scan on
  /// the day it happened in the event's timezone, same as the migration.
  5(data) {
    const zones = Object.fromEntries((data.event || []).map((e) => [e.id, e.timezone || 'UTC']));
    const checkIn = (data.registration || []).filter((r) => r.checkedInAt).map((r) => ({
      id: `ci${r.id}`, registrationId: r.id, eventId: r.eventId,
      day: new Date(r.checkedInAt).toLocaleDateString('en-CA', { timeZone: zones[r.eventId] || 'UTC' }),
      direction: 'ENTRY', at: r.checkedInAt, scannedById: r.checkedInById || null, createdAt: r.checkedInAt,
    }));
    return { checkIn, ...data };
  },
  /// v6 -> v7 (0010_incidents): only new tables and a nullable column.
  6(data) {
    return { incident: [], incidentPerson: [], incidentNote: [], ...data };
  },
  /// v7 -> v8 (0013_schedule): only new tables and defaulted columns.
  7(data) {
    return { eventRoom: [], scheduleSession: [], sessionStar: [], panelSubmission: [], ...data };
  },
  /// v8 -> v9 (0014_vendors): only new tables and nullable/defaulted columns.
  8(data) {
    return { vendorTableType: [], vendorApplication: [], ...data };
  },
  /// v9 -> v10 (0015_staff_permissions): every admin goes into a "Staff"
  /// group with what admins could do before, same as the migration, so an
  /// older backup doesn't restore its admins with no access at all.
  9(data) {
    if (data.staffGroup) return data;
    const admins = (data.user || []).filter((u) => u.role === 'ADMIN');
    return {
      ...data,
      user: (data.user || []).map((u) => ({ permissions: [], ...u })),
      staffGroup: [{ id: 'staff_default', name: 'Staff', description: 'Everything admins could do before permissions existed.', permissions: STAFF_DEFAULTS }],
      staffGroupMember: admins.map((u) => ({ userId: u.id, groupId: 'staff_default' })),
    };
  },
};

/// Takes a parsed data.json ({ meta, data }) of any supported version and
/// returns it at BACKUP_VERSION. Throws on anything it can't convert.
export function upgradeBackup(parsed) {
  let version = parsed?.meta?.version;
  if (!Number.isInteger(version) || version < 1 || version > BACKUP_VERSION) {
    throw new Error(`Unsupported backup version (${version ?? 'unknown'}). This instance reads versions 1 to ${BACKUP_VERSION}.`);
  }
  let data = parsed.data || {};
  while (version < BACKUP_VERSION) {
    data = UPGRADES[version](data);
    version += 1;
  }
  return { ...parsed, meta: { ...parsed.meta, version }, data };
}
