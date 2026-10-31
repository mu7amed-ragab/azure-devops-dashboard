/**
 * Text normalisation for the screenshot leak check, so a real name is caught
 * however it is spelled on screen: Latin letter case, Arabic diacritics and
 * tatweel, the common Arabic letter variants, and invisible direction or
 * zero-width marks that a bidirectional page inserts.
 */

const ARABIC_DIACRITICS = /[ً-ْٰـ]/g;
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;
const FOLDS = [
  [/[أإآٱ]/g, 'ا'],
  [/ة/g, 'ه'],
  [/ى/g, 'ي'],
  [/ؤ/g, 'و'],
  [/ئ/g, 'ي'],
];

function normalize(s) {
  let out = String(s == null ? '' : s)
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(ARABIC_DIACRITICS, '')
    .toLowerCase();
  for (const [from, to] of FOLDS) out = out.replace(from, to);
  return out.replace(/\s+/g, ' ').trim();
}

/** normalize() with everything but letters and digits removed — how a
 * required name is matched against a term (a slug `x-y` matches `X Y`). */
function compact(s) {
  return normalize(s).replace(/[^\p{L}\p{N}]/gu, '');
}

function hasArabic(s) {
  return /[؀-ۿ]/.test(String(s || ''));
}

module.exports = { normalize, compact, hasArabic };
