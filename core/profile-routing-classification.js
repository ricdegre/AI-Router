export const ROUTING_ELIGIBILITY = Object.freeze(['REAL', 'DEMO', 'TEST', 'MOCK', 'PLACEHOLDER']);

const TOKEN_PATTERNS = [
  ['PLACEHOLDER', /(?:^|[-_.\s])(placeholder|sample|example)(?:$|[-_.\s])/i],
  ['DEMO', /(?:^|[-_.\s])demo(?:$|[-_.\s])/i],
  ['TEST', /(?:^|[-_.\s])(test|testing|fixture)(?:$|[-_.\s])/i],
  ['MOCK', /(?:^|[-_.\s])(mock|synthetic|doctor)(?:$|[-_.\s])/i]
];

export function classifyProfileRouting(profile = {}) {
  const explicit = String(profile.routing_classification ?? '').toUpperCase();
  if (ROUTING_ELIGIBILITY.includes(explicit)) return explicit;
  const legacyType = String(profile.profile_type ?? '').toLowerCase();
  if (legacyType === 'mock') return 'MOCK';
  if (['demo', 'test', 'placeholder'].includes(legacyType)) return legacyType.toUpperCase();
  const identity = `${profile.profile_id ?? ''} ${profile.display_name ?? ''}`;
  return TOKEN_PATTERNS.find(([, pattern]) => pattern.test(identity))?.[0] ?? (legacyType === 'synthetic' ? 'MOCK' : 'REAL');
}

export function isProductionRoutingProfile(profile) { return classifyProfileRouting(profile) === 'REAL'; }
