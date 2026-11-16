// Small in-memory sliding-window limiter. Enough for one backend instance;
// move to Redis or the database if the backend ever runs on several.
export const createRateLimiter = ({ limit, windowMs }) => {
  const hits = new Map(); // key -> timestamps

  return {
    /** Records a hit and returns false when the key is over its limit. */
    take(key) {
      const now = Date.now();
      const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      // Keep memory bounded
      if (hits.size > 10000) {
        for (const [k, times] of hits) {
          if (!times.some((t) => now - t < windowMs)) hits.delete(k);
        }
      }
      return true;
    },
    reset() {
      hits.clear();
    },
  };
};
