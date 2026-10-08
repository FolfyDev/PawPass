import { nanoid } from 'nanoid';

/// Version of the data.json inside a backup zip. Bump it alongside any schema
/// migration that changes the shape of a backed-up model, and add a step to
/// UPGRADES below so older backups still restore.
export const BACKUP_VERSION = 3;

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
