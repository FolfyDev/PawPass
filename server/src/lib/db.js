import { PrismaClient } from '@prisma/client';
import { encryptField, decryptField, encryptJson, decryptJson, blindIndex } from './crypto.js';

const FIELD_CONFIG = {
  user: [
    { field: 'email', indexField: 'emailIndex' },
    { field: 'legalName' },
  ],
  registration: [
    { field: 'legalName', indexField: 'legalNameIndex' },
    { field: 'email', indexField: 'emailIndex' },
    { field: 'fursonaName' },
    { field: 'answers', json: true },
  ],
};

const RELATION_TO_MODEL = {
  user: 'user',
  checkedInBy: 'user',
  createdBy: 'user',
  processedBy: 'user',
  registration: 'registration',
  registrations: 'registration',
  redemptions: 'registration',
};

function encryptData(model, data) {
  const config = FIELD_CONFIG[model];
  if (!config || !data || typeof data !== 'object') return data;
  const out = { ...data };
  for (const spec of config) {
    if (spec.field in out) {
      const raw = out[spec.field];
      out[spec.field] = spec.json ? encryptJson(raw) : encryptField(raw);
      if (spec.indexField) out[spec.indexField] = blindIndex(raw);
    }
  }
  return out;
}

function encryptArgs(model, args) {
  if (!args) return args;
  if (Array.isArray(args.data)) return { ...args, data: args.data.map((d) => encryptData(model, d)) };
  if (args.data) return { ...args, data: encryptData(model, args.data) };
  if (args.create || args.update) {
    return { ...args, create: encryptData(model, args.create), update: encryptData(model, args.update) };
  }
  return args;
}

function decryptRow(model, row) {
  if (!row || typeof row !== 'object') return row;
  const config = FIELD_CONFIG[model];
  if (config) {
    for (const spec of config) {
      if (spec.field in row) row[spec.field] = spec.json ? decryptJson(row[spec.field]) : decryptField(row[spec.field]);
    }
  }
  for (const [key, relModel] of Object.entries(RELATION_TO_MODEL)) {
    if (key in row && row[key]) {
      row[key] = Array.isArray(row[key]) ? row[key].map((r) => decryptRow(relModel, r)) : decryptRow(relModel, row[key]);
    }
  }
  return row;
}

function decryptResult(model, result) {
  if (Array.isArray(result)) return result.map((r) => decryptResult(model, r));
  return decryptRow(model, result);
}

const basePrisma = new PrismaClient();

export const prisma = basePrisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, args, query }) {
        const modelKey = model ? model.charAt(0).toLowerCase() + model.slice(1) : null;
        const preparedArgs = modelKey && FIELD_CONFIG[modelKey] ? encryptArgs(modelKey, args) : args;
        const result = await query(preparedArgs);
        return decryptResult(modelKey, result);
      },
    },
  },
});
