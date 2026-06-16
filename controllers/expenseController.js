import mongoose from "mongoose";
import Expense from "../models/expenseModel.js";
import User from "../models/userModel.js";
import AccountSource from "../models/accountModel.js";
import { invalidateStatsCache } from "../utils/statsCache.js";
import { getRangeFilter, recalculateAfterBalances } from "../utils/expenseBalance.js";

const DEFAULT_ACCOUNT_NAME = 'Primary Account';

const normalizeName = (name) =>
  name.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Resolve sourceId for a user.
 * - If sourceId provided and valid → return it
 * - If sourceId provided but invalid (e.g. account deleted while offline) → fall back to default
 * - If no sourceId provided → use default
 * - If no default exists → create one
 *
 * This function NEVER returns null. It always resolves to a valid sourceId.
 * This is critical for offline sync compatibility — if an account was deleted
 * on the server while the user was offline, we gracefully fall back to the
 * default account instead of rejecting the request (which would cause the
 * sync queue to drop the transaction as a "fatal 400 error").
 */
const resolveAndValidateSourceId = async (userId, sourceId, session = null) => {
    const opts = session ? { session } : {};

    if (sourceId) {
        const account = await AccountSource.findOne({ _id: sourceId, userId }, '_id', opts);
        if (account) return sourceId;
        // sourceId is invalid (account may have been deleted while user was offline)
        // Fall back to default instead of failing — prevents data loss during sync
        console.warn(`[SourceId] Account ${sourceId} not found for user ${userId}, falling back to default`);
    }

    // No sourceId or invalid — use default
    const defAcc = await AccountSource.findOne({ userId, isDefault: true }, '_id', opts);
    if (defAcc) return defAcc._id;

    // No default exists — create one
    const created = new AccountSource({
        userId,
        name: DEFAULT_ACCOUNT_NAME,
        normalizedName: normalizeName(DEFAULT_ACCOUNT_NAME),
        type: 'cash',
        openingBalance: 0,
        currentBalance: 0,
        isDefault: true,
        transactionCount: 0,
        lastUsed: null,
    });
    await created.save(opts);
    return created._id;
};

/**
 * Update account stats (transactionCount, lastUsed) after a transaction is created.
 */
const incrementAccountStats = async (sourceId, date, session = null) => {
    if (!sourceId) return;
    const opts = session ? { session } : {};
    const update = {
        $inc: { transactionCount: 1 },
    };
    // Only update lastUsed if this transaction's date is newer
    const dateObj = date instanceof Date ? date : new Date(date);
    if (!isNaN(dateObj.getTime())) {
        update.$max = { lastUsed: dateObj };
    }
    await AccountSource.findByIdAndUpdate(sourceId, update, opts);
};

/**
 * Decrement account transactionCount after a transaction is deleted.
 */
const decrementAccountStats = async (sourceId, session = null) => {
    if (!sourceId) return;
    const opts = session ? { session } : {};
    await AccountSource.findByIdAndUpdate(sourceId, {
        $inc: { transactionCount: -1 },
    }, opts);
};

export const addExpense = async (req, res) => {
    try {
        const { details, amount, type, category, date, clientId, sourceId } = req.body

        if (!details || !amount || !type || !date) {
            return res.status(403).send("Please provide all the expense details")
        }
        // --- Server-side validation ---
        if (typeof details !== 'string' || !details.trim()) {
            return res.status(400).json({ message: 'Details/description is required and cannot be empty' });
        }
        const trimmedDetails = details.trim();

        if (!amount && amount !== 0) {
            return res.status(400).json({ message: 'Amount is required' });
        }
        const parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
            return res.status(400).json({ message: 'Amount must be a valid positive number' });
        }

        if (!type || !['credit', 'debit'].includes(type.toLowerCase())) {
            return res.status(400).json({ message: 'Type must be either "credit" or "debit"' });
        }
        const normalizedType = type.toLowerCase();

        if (!date) {
            return res.status(400).json({ message: 'Date is required' });
        }
        const expenseDate = new Date(date);
        if (isNaN(expenseDate.getTime())) {
            return res.status(400).json({ message: 'Invalid date format provided' });
        }

        const trimmedCategory = category ? category.trim() : undefined;
        // Calculate signed amount
        const signedAmount = normalizedType === 'credit' ? parsedAmount : -parsedAmount;

        // Start a transaction (optional but safer for consistency)
        const session = await Expense.startSession();
        session.startTransaction();

        try {
            if (clientId) {
                const existing = await Expense.findOne({ userId: req.userId, clientId }).session(session);
                if (existing) {
                    await session.commitTransaction();
                    session.endSession();
                    return res.status(200).send({ "id": existing._id });
                }
            }

            // Resolve & validate account (always returns a valid sourceId)
            const resolvedSourceId = await resolveAndValidateSourceId(req.userId, sourceId, session);

            // Save expense
            const expense = new Expense({
                userId: req.userId,
                clientId,
                details: trimmedDetails,
                amount: parsedAmount,
                type: normalizedType,
                category: normalizedType === 'credit' ? 'Income' : (trimmedCategory || 'Other'),
                date: expenseDate,
                sourceId: resolvedSourceId,
            });

            await expense.save({ session });

            // Update account balance
            await AccountSource.findByIdAndUpdate(
                resolvedSourceId,
                { $inc: { currentBalance: signedAmount } },
                { session }
            );

            // Update user's net balance
            await User.findByIdAndUpdate(
                req.userId,
                { $inc: { netBalance: signedAmount } },
                { session }
            );

            // Update account transactionCount & lastUsed
            await incrementAccountStats(resolvedSourceId, expenseDate, session);

            await recalculateAfterBalances(req.userId, session);

            // Commit transaction
            await session.commitTransaction();
            session.endSession();

            invalidateStatsCache(req.userId);

            return res.status(200).send({ "id": expense._id });
        } catch (innerError) {
            if (innerError?.code === 11000 && clientId) {
                const existing = await Expense.findOne({ userId: req.userId, clientId });
                if (existing) {
                    await session.abortTransaction();
                    session.endSession();
                    return res.status(200).send({ "id": existing._id });
                }
            }
            await session.abortTransaction();
            session.endSession();
            console.error(innerError);
            return res.status(500).send("Failed to save expense and update balance");
        }

    } catch (error) {
        console.log(error);
        return res.send(error)
    }
}

export const removeExpense = async (req, res) => {
    try {
        const id = req.params.id
        
        // Validate ObjectId format (handles temp IDs from offline sync)
        if (!mongoose.isValidObjectId(id)) {
            return res.status(404).json({ 
                message: 'Expense not found (invalid ID format)' 
            });
        }
        
        const expense = await Expense.findById(id)
        
        // Handle case where expense doesn't exist (was never synced)
        if (!expense) {
            return res.status(404).json({ message: 'Expense not found' });
        }
        
        const parsedAmount = expense.amount
        const signedAmount = expense.type === 'debit' ? parsedAmount : -parsedAmount;
        // Start a transaction (optional but safer for consistency)
        const session = await Expense.startSession();
        session.startTransaction();
        try {

            await Expense.findByIdAndDelete(id, { session })

            await User.findByIdAndUpdate(
                req.userId,
                { $inc: { netBalance: signedAmount } },
                { session }
            );

            // Reverse account balance
            if (expense.sourceId) {
                await AccountSource.findByIdAndUpdate(
                    expense.sourceId,
                    { $inc: { currentBalance: signedAmount } },
                    { session }
                );

                // Decrement account transactionCount
                await decrementAccountStats(expense.sourceId, session);
            }

            await recalculateAfterBalances(req.userId, session);

            // Commit transaction
            await session.commitTransaction();
            session.endSession();

            invalidateStatsCache(req.userId);

            return res.sendStatus(200)
        }
        catch (error) {
            console.log(error);

            await session.abortTransaction();
            session.endSession();
            return res.status(500).send("Could not delete expense")
        }
    } catch (error) {
        console.log(error);

        return res.status(500).send("Could not delete expense")
    }
}

export const editExpense = async (req, res) => {
    try {
        const id = req.params.id
        const { amount, details, category, date, sourceId } = req.body
        
        // Validate ObjectId format (handles temp IDs from offline sync)
        if (!mongoose.isValidObjectId(id)) {
            return res.status(404).json({ 
                message: 'Expense not found (invalid ID format)' 
            });
        }
        
        const expense = await Expense.findById(id)
        
        // Handle case where expense doesn't exist (was never synced)
        if (!expense) {
            return res.status(404).json({ message: 'Expense not found' });
        }
        
        // --- Server-side validation for edited fields ---
        if (details !== undefined) {
            if (typeof details !== 'string' || !details.trim()) {
                return res.status(400).json({ message: 'Details cannot be empty' });
            }
        }
        
        if (amount !== undefined) {
            const parsedAmount = parseFloat(amount);
            if (isNaN(parsedAmount) || parsedAmount <= 0) {
                return res.status(400).json({ message: 'Amount must be a valid positive number' });
            }
        }
        
        if (date !== undefined) {
            const expenseDate = new Date(date);
            if (isNaN(expenseDate.getTime())) {
                return res.status(400).json({ message: 'Invalid date format provided' });
            }
        }
        
        if (category !== undefined && typeof category === 'string') {
            // Trim category if provided
            req.body.category = category.trim();
        }
        
        const session = await Expense.startSession();
        session.startTransaction();

        try {
            // If the source account is being changed, we need to adjust both accounts
            const oldSourceId = expense.sourceId?.toString();

            // Resolve the new sourceId (falls back to default if invalid — offline-safe)
            let newSourceId;
            if (sourceId) {
                const resolved = await resolveAndValidateSourceId(req.userId, sourceId, session);
                newSourceId = resolved;
            } else {
                newSourceId = oldSourceId;
            }

            const isSourceChanged = oldSourceId && newSourceId && oldSourceId !== newSourceId;

            if (parseFloat(amount) !== expense.amount) {
                let signedAmount = 0
                if (expense.type === 'debit') {
                    signedAmount = expense.amount - parseFloat(amount)
                } else {
                    signedAmount = parseFloat(amount) - expense.amount
                }

                await User.findByIdAndUpdate(
                    req.userId,
                    { $inc: { netBalance: signedAmount } },
                    { session }
                );

                // Update account balance for amount change (on the current/new source)
                if (newSourceId) {
                    await AccountSource.findByIdAndUpdate(
                        newSourceId,
                        { $inc: { currentBalance: signedAmount } },
                        { session }
                    );
                }
            }

            // Handle source account change: reverse amount from old, add to new
            if (isSourceChanged) {
                const transactionSignedAmount = expense.type === 'credit' ? expense.amount : -expense.amount;

                // Reverse from old account
                if (oldSourceId) {
                    await AccountSource.findByIdAndUpdate(
                        oldSourceId,
                        { $inc: { currentBalance: -transactionSignedAmount } },
                        { session }
                    );
                    // Decrement old account transactionCount
                    await decrementAccountStats(oldSourceId, session);
                }

                // Add to new account
                await AccountSource.findByIdAndUpdate(
                    newSourceId,
                    { $inc: { currentBalance: transactionSignedAmount } },
                    { session }
                );
                // Increment new account transactionCount & update lastUsed
                await incrementAccountStats(newSourceId, expense.date, session);
            } else if (newSourceId) {
                // Same account, just update lastUsed if the date is newer
                const expenseDate = new Date(date);
                if (!isNaN(expenseDate.getTime())) {
                    await AccountSource.findByIdAndUpdate(
                        newSourceId,
                        { $max: { lastUsed: expenseDate } },
                        { session }
                    );
                }
            }

            const updateFields = {
                amount: amount !== undefined ? parseFloat(amount) : expense.amount,
                details: details !== undefined ? details.trim() : expense.details,
                category: category !== undefined ? category.trim() : expense.category,
                date: date !== undefined ? new Date(date) : expense.date,
            };
            updateFields.sourceId = newSourceId;
            await Expense.findByIdAndUpdate(id, updateFields, { session });
            await recalculateAfterBalances(req.userId, session);
            // Commit transaction
            await session.commitTransaction();
            session.endSession();

            invalidateStatsCache(req.userId);
            return res.sendStatus(200)
        } catch (error) {
            await session.abortTransaction();
            session.endSession();
            return res.status(500).send("Could not edit expense")
        }
    } catch (error) {
        return res.status(500).send("Could not edit expense")
    }
}

export const getExpenses = async (req, res) => {
    const userId = req.userId;
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 10;
    const range = req.query.range || "all_time";
    const sourceId = req.query.sourceId || null;

    if (!userId) {
        return res.status(400).json({ message: 'User ID is required' });
    }
    const user = await User.findById(userId)
    if (!user) {
        return res.status(401).json({ message: 'User not found' });
    }

    const filter = { userId, ...getRangeFilter(range) };
    let accountBalance = null;
    if (sourceId) {
        // Validate sourceId belongs to user
        const validAccount = await AccountSource.findOne({ _id: sourceId, userId }, '_id currentBalance');
        if (validAccount) {
            filter.sourceId = sourceId;
            accountBalance = validAccount.currentBalance;
        }
        // If invalid, ignore the filter rather than returning nothing
    }

    let expenses = await Expense.find(filter)
        .sort({ date: -1, createdAt: -1 })
        .skip(offset)
        .limit(limit);

    if (expenses.some((expense) => typeof expense.afterBalance !== "number")) {
        await recalculateAfterBalances(userId);
        expenses = await Expense.find(filter)
            .sort({ date: -1, createdAt: -1 })
            .skip(offset)
            .limit(limit);
    }

    const totalCount = await Expense.countDocuments(filter);
    const hasMore = offset + expenses.length < totalCount;
    const rangeExpenses = await Expense.find(filter).select("amount type");
    const rangeBalance = rangeExpenses.reduce((sum, expense) => (
        expense.type === "debit" ? sum - expense.amount : sum + expense.amount
    ), 0);

    return res.status(200).json({
        expenses,
        totalBalance: user.netBalance,
        rangeBalance,
        accountBalance,
        range,
        hasMore,
    });
}
