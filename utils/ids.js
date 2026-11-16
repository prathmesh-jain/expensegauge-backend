// Compares ObjectIds, strings or a mix of both; null never matches
export const sameId = (a, b) => a != null && b != null && String(a) === String(b);
