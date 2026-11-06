// Keep browser forms, imports and APIs on the same owner format.
export const OWNER_EMAIL_MAX_LENGTH = 254;
export function isOwnerEmail(value) {
  if (typeof value !== 'string' || value.length > OWNER_EMAIL_MAX_LENGTH) return false;
  const parts = value.split('@');
  if (parts.length !== 2 || !parts[0] || parts[0].length > 64 || parts[0].startsWith('.') || parts[0].endsWith('.') || parts[0].includes('..')) return false;
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(parts[0]) &&
    parts[1].split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

export function isOwnerIdentifier(value) {
  return value === 'admin' || isOwnerEmail(value);
}
