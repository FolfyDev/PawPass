import { customAlphabet } from 'nanoid';

// No I, O, 0, 1 — these get misread off a printed badge.
const HUMAN = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const chunk = customAlphabet(HUMAN, 4);
const secretGen = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 32);

export const ticketCode = () => `${chunk()}-${chunk()}`;
export const loginCode = () => `${chunk()}-${chunk()}`;
export const ticketSecret = () => secretGen();
