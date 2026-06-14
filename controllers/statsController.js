import Expense from "../models/expenseModel.js";
import { getStatsFromCache, setStatsToCache } from "../utils/statsCache.js";

export const getMonthlyStats = async (req, res) => {
    try {
        // userId might be in body (for admin POST) or implied in req.userId (for normal users GET)
        const targetUserId = req.body?.userId || req.query?.userId || req.userId;
        const sourceId = req.query?.sourceId || null;
        const range = req.query?.range || 'all_time';

        if (!targetUserId) {
            return res.status(400).json({ message: "User ID is required" });
        }

        // 1. Build cache key with filters (userId-range-sourceId)
        const cacheKey = `${targetUserId}-${range}-${sourceId || 'all'}`;
        
        // 2. Check Cache
        const cachedStats = getStatsFromCache(cacheKey);
        if (cachedStats) {
            return res.status(200).json(cachedStats);
        }

        // 3. Build query filter
        const queryFilter = { userId: targetUserId };
        if (sourceId) {
            queryFilter.sourceId = sourceId;
        }
        
        // Apply date range filter
        if (range !== 'all_time') {
            const today = new Date();
            let startDate;
            
            if (range === 'today') {
                startDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
            } else if (range === 'week') {
                startDate = new Date(today);
                startDate.setDate(today.getDate() - 7);
            } else if (range === 'month') {
                startDate = new Date(today.getFullYear(), today.getMonth(), 1);
            } else if (range === '3months') {
                startDate = new Date(today.getFullYear(), today.getMonth() - 3, 1);
            } else if (range === '6months') {
                startDate = new Date(today.getFullYear(), today.getMonth() - 6, 1);
            } else if (range === 'year') {
                startDate = new Date(today.getFullYear(), 0, 1);
            }
            
            if (startDate) {
                queryFilter.date = { $gte: startDate };
            }
        }

        // 4. Fetch Expenses
        const expenses = await Expense.find(queryFilter).select("amount type date");

        // 3. Process Data
        const last12Months = [];
        const today = new Date();

        for (let i = 11; i >= 0; i--) {
            const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
            const monthName = d.toLocaleString('default', { month: 'short' });
            // For checking/matching logic
            last12Months.push({
                monthLabel: monthName,
                year: d.getFullYear(),
                monthIndex: d.getMonth(),
                credit: 0,
                debit: 0
            });
        }

        expenses.forEach(exp => {
            // exp.date is a string, e.g., "Wed Jan 28 2026..."
            const expDate = new Date(exp.date);
            if (isNaN(expDate)) return; // Skip invalid dates

            // Check if within the last ~12 months window roughly
            // A simpler way matches the exact month/year buckets we created
            const match = last12Months.find(m =>
                m.monthIndex === expDate.getMonth() &&
                m.year === expDate.getFullYear()
            );

            if (match) {
                const type = exp.type.toLowerCase();
                if (type === 'credit' || type === 'assign') {
                    match.credit += exp.amount;
                } else if (type === 'debit') {
                    match.debit += exp.amount;
                }
            }
        });

        // 4. Format for Frontend
        // Filter out months with no data
        const activeMonths = last12Months.filter(m => m.credit > 0 || m.debit > 0);

        const labels = activeMonths.map(m => m.monthLabel);
        const credits = activeMonths.map(m => m.credit);
        const debits = activeMonths.map(m => m.debit);

        const responseData = {
            labels,
            datasets: [
                { data: credits },
                { data: debits } // Note: Graph usually expects structured datasets, we'll send raw arrays for flexibility
            ],
            raw: { credits, debits } // Explicit mapping
        };

        // 5. Cache and Return
        setStatsToCache(cacheKey, responseData);
        res.status(200).json(responseData);

    } catch (error) {
        console.error("Error calculating stats:", error);
        res.status(500).json({ message: "Server error calculating statistics" });
    }
};
