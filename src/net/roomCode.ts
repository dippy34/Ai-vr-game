/** Room code helpers. Pure functions, no browser APIs required. */

import { NET } from '../config';

/** Canonical form of a typed/pasted room code: trimmed, uppercase, no whitespace or dashes. */
export function normalizeRoomCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s\-‐-―_]+/g, '');
}

/** True if `code` (already normalized) has the right length and only uses NET.codeAlphabet. */
export function isValidRoomCode(code: string): boolean {
  if (code.length !== NET.codeLength) return false;
  for (const ch of code) if (!NET.codeAlphabet.includes(ch)) return false;
  return true;
}

/** A fresh random room code, e.g. "K7QXM". */
export function randomRoomCode(): string {
  const alphabet = NET.codeAlphabet;
  const values = new Uint32Array(NET.codeLength);
  try {
    crypto.getRandomValues(values);
  } catch {
    for (let i = 0; i < values.length; i++) values[i] = Math.floor(Math.random() * 0x1_0000_0000);
  }
  let code = '';
  for (let i = 0; i < values.length; i++) code += alphabet[values[i] % alphabet.length];
  return code;
}

/** PeerJS / transport id of the host of room `code`. */
export function hostIdForCode(code: string): string {
  return NET.idPrefix + code;
}
