// Keep in sync with frontend/helper/expenseLimits.ts
export const MAX_DETAILS_LENGTH = 200;
export const MAX_AMOUNT = 999999999;

export const DETAILS_TOO_LONG_MESSAGE = `Details cannot be longer than ${MAX_DETAILS_LENGTH} characters`;
export const AMOUNT_TOO_LARGE_MESSAGE = `Amount cannot be more than ${MAX_AMOUNT}`;

export const isDetailsTooLong = (details) => details.trim().length > MAX_DETAILS_LENGTH;
export const isAmountTooLarge = (amount) => Math.abs(amount) > MAX_AMOUNT;
