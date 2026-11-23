import { createHmac } from 'crypto';

/** Uppercase letters and digits only, so "dl-01 2019/0001" and "DL0120190001" hash the same. */
export const normalizeIdNumber = (raw: string): string => raw.toUpperCase().replace(/[^A-Z0-9]/g, '');

const MIN_ID_LENGTH = 6;
const MAX_ID_LENGTH = 24;

export const isPlausibleIdNumber = (normalized: string): boolean =>
  normalized.length >= MIN_ID_LENGTH && normalized.length <= MAX_ID_LENGTH;

/** A 12-digit run is an Aadhaar number and a 16-digit run an Aadhaar VID. We never accept either. */
export const looksLikeAadhaarNumber = (normalized: string): boolean => /^(\d{12}|\d{16})$/.test(normalized);

/** Letters only, uppercased: "Rohit  Kumar" and "ROHIT KUMAR" match. */
export const normalizeName = (raw: string): string => raw.toUpperCase().replace(/[^\p{L}]/gu, '');

/**
 * A masked Aadhaar exposes only the last 4 digits. Alone that collides constantly, so the hash
 * also covers the name printed on the card. Domain-prefixed so it cannot equal another doc's hash.
 */
export const hashMaskedAadhaar = (last4: string, normalizedName: string, pepper: string): string =>
  createHmac('sha256', pepper).update(`AADHAAR_MASKED|${last4}|${normalizedName}`).digest('hex');

/**
 * HMAC-SHA256 keyed with the server pepper (HMAC, not bare SHA-256(pepper+value), so there is no
 * length-extension or concatenation ambiguity). Deterministic, so the same ID always matches.
 */
export const hashIdNumber = (normalized: string, pepper: string): string =>
  createHmac('sha256', pepper).update(normalized).digest('hex');
