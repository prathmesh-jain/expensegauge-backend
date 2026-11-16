// Keep in sync with frontend/helper/groupLimits.ts
export const MAX_GROUP_NAME_LENGTH = 50;
export const MAX_MEMBER_NAME_LENGTH = 40;
// Counts every slot in the group, including people who left
export const MAX_GROUP_MEMBERS = 50;
export const MAX_CURRENCY_SYMBOL_LENGTH = 5;

// No 0/O or 1/I/L so codes are easy to read out and type
export const INVITE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 8;
const INVITE_CODE_PATTERN = /^[A-Za-z0-9]{4,16}$/;

export const normalizeInviteCode = (code) =>
  typeof code === 'string' && INVITE_CODE_PATTERN.test(code.trim()) ? code.trim().toUpperCase() : null;

export const DELETED_USER_NAME = 'Deleted user';

// Exact-email lookups per user, so nobody can test lists of emails
export const EMAIL_LOOKUPS_PER_HOUR = 30;
const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;

export const normalizeEmail = (value) =>
  typeof value === 'string' && EMAIL_PATTERN.test(value.trim()) && value.trim().length <= 254
    ? value.trim().toLowerCase()
    : null;

// ra***@gmail.com
export const maskEmail = (email) => {
  const [local, domain] = email.split('@');
  return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
};
