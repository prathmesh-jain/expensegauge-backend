import Expense from "../models/expenseModel.js";
import AccountSource from "../models/accountModel.js";
import { getRangeBounds, getRangeFilter } from "../utils/expenseBalance.js";
import { getStatsFromCache, setStatsToCache } from "../utils/statsCache.js";

const formatCurrencyValue = (value = 0) => Number(value.toFixed(2));

const buildStatsFilter = async ({ userId, sourceId, range }) => {
    const queryFilter = { userId, ...getRangeFilter(range) };

    if (!sourceId) {
        return queryFilter;
    }

    const validAccount = await AccountSource.findOne({ _id: sourceId, userId }, "_id");
    if (validAccount) {
        queryFilter.sourceId = sourceId;
    }

    return queryFilter;
};

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
        const queryFilter = await buildStatsFilter({
            userId: targetUserId,
            sourceId,
            range,
        });

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

export const getExpenseAnalytics = async (req, res) => {
    try {
        console.log("insisde stats")
        const targetUserId = req.body?.userId || req.query?.userId || req.userId;
        const sourceId = req.query?.sourceId || null;
        const range = req.query?.range || "all_time";

        if (!targetUserId) {
            return res.status(400).json({ message: "User ID is required" });
        }

        const cacheKey = `${targetUserId}-analytics-${range}-${sourceId || "all"}`;
        const cachedAnalytics = getStatsFromCache(cacheKey);
        if (cachedAnalytics) {
            return res.status(200).json(cachedAnalytics);
        }

        const queryFilter = await buildStatsFilter({
            userId: targetUserId,
            sourceId,
            range,
        });

        const expenses = await Expense.find(queryFilter)
            .select("amount type date category sourceId details")
            .sort({ date: -1, createdAt: -1 });

        const debitExpenses = expenses.filter((expense) => expense.type?.toLowerCase() === "debit");
        const totalSpend = debitExpenses.reduce((sum, expense) => sum + expense.amount, 0);
        const totalTransactions = debitExpenses.length;

        const categoryTotals = {};
        const accountTotals = {};
        const weekdayTotals = {
            Sunday: 0,
            Monday: 0,
            Tuesday: 0,
            Wednesday: 0,
            Thursday: 0,
            Friday: 0,
            Saturday: 0,
        };
        const activeDates = new Set();

        debitExpenses.forEach((expense) => {
            const categoryName = expense.category || "Other";
            categoryTotals[categoryName] = (categoryTotals[categoryName] || 0) + expense.amount;

            const accountKey = expense.sourceId?.toString() || "unknown";
            accountTotals[accountKey] = (accountTotals[accountKey] || 0) + expense.amount;

            const expenseDate = new Date(expense.date);
            if (!Number.isNaN(expenseDate.getTime())) {
                activeDates.add(expenseDate.toISOString().slice(0, 10));
                const weekday = expenseDate.toLocaleDateString("en-US", { weekday: "long" });
                weekdayTotals[weekday] = (weekdayTotals[weekday] || 0) + expense.amount;
            }
        });

        const accountIds = Object.keys(accountTotals).filter((accountId) => accountId !== "unknown");
        const accounts = accountIds.length
            ? await AccountSource.find({ _id: { $in: accountIds }, userId: targetUserId }).select("name")
            : [];
        const accountNameMap = new Map(accounts.map((account) => [account._id.toString(), account.name]));

        const toBreakdown = (entries, getLabel) =>
            entries
                .sort((a, b) => b[1] - a[1])
                .map(([key, amount]) => ({
                    key,
                    label: getLabel(key),
                    amount: formatCurrencyValue(amount),
                    percentage: totalSpend > 0 ? formatCurrencyValue((amount / totalSpend) * 100) : 0,
                }));

        const categoryBreakdown = toBreakdown(
            Object.entries(categoryTotals),
            (category) => category
        );

        const accountBreakdown = toBreakdown(
            Object.entries(accountTotals),
            (accountId) => accountNameMap.get(accountId) || "Unassigned account"
        );

        const largestExpense = debitExpenses.reduce((largest, expense) => (
            !largest || expense.amount > largest.amount ? expense : largest
        ), null);

        const highestCategory = categoryBreakdown[0] || null;
        const topAccount = accountBreakdown[0] || null;
        const topWeekdayEntry = Object.entries(weekdayTotals)
            .sort((a, b) => b[1] - a[1])[0];

        const { startDate, endDate } = getRangeBounds(range);
        const sortedByDateAsc = [...debitExpenses].sort((a, b) => new Date(a.date) - new Date(b.date));
        const effectiveStart = startDate || (sortedByDateAsc[0] ? new Date(sortedByDateAsc[0].date) : null);
        const effectiveEnd = endDate || (sortedByDateAsc[sortedByDateAsc.length - 1] ? new Date(sortedByDateAsc[sortedByDateAsc.length - 1].date) : null);
        const periodDayCount = effectiveStart && effectiveEnd
            ? Math.max(1, Math.ceil((effectiveEnd.getTime() - effectiveStart.getTime()) / (1000 * 60 * 60 * 24)))
            : 0;
        const averageDailySpend = periodDayCount > 0 ? totalSpend / periodDayCount : 0;

        const responseData = {
            summary: {
                totalSpend: formatCurrencyValue(totalSpend),
                totalTransactions,
                averageDailySpend: formatCurrencyValue(averageDailySpend),
                activeDays: activeDates.size,
            },
            categoryBreakdown,
            accountBreakdown,
            insights: {
                largestExpense: largestExpense
                    ? {
                        amount: formatCurrencyValue(largestExpense.amount),
                        details: largestExpense.details,
                        category: largestExpense.category || "Other",
                        date: largestExpense.date,
                    }
                    : null,
                topWeekday: topWeekdayEntry && topWeekdayEntry[1] > 0
                    ? { day: topWeekdayEntry[0], amount: formatCurrencyValue(topWeekdayEntry[1]) }
                    : null,
                highestCategory: highestCategory
                    ? {
                        label: highestCategory.label,
                        amount: highestCategory.amount,
                        percentage: highestCategory.percentage,
                    }
                    : null,
                topAccount: topAccount
                    ? {
                        label: topAccount.label,
                        amount: topAccount.amount,
                        percentage: topAccount.percentage,
                    }
                    : null,
            },
        };

        setStatsToCache(cacheKey, responseData);
        return res.status(200).json(responseData);
    } catch (error) {
        console.error("Error calculating analytics:", error);
        return res.status(500).json({ message: "Server error calculating analytics" });
    }
};
