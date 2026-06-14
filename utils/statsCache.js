const statsCache = new Map();

export const getStatsFromCache = (cacheKey) => {
    if (statsCache.has(cacheKey)) {
        console.log(`Serving stats from cache: ${cacheKey}`);
        return statsCache.get(cacheKey);
    }
    return null;
};

export const setStatsToCache = (cacheKey, data) => {
    console.log(`Caching stats: ${cacheKey}`);
    statsCache.set(cacheKey, data);
};

export const invalidateStatsCache = (userId) => {
    // Invalidate all cache entries for this user
    for (const key of statsCache.keys()) {
        if (key.startsWith(`${userId}-`)) {
            console.log(`Invalidating stats cache: ${key}`);
            statsCache.delete(key);
        }
    }
};
