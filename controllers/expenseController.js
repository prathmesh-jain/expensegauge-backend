import Expense from "../models/expenseModel.js";
import User from "../models/userModel.js";
import { invalidateStatsCache } from "../utils/statsCache.js";

export const addExpense = async (req, res) => {
    try {
        const { details, amount, type, category, date, clientId } = req.body

        if (!details || !amount || !type || !date) {
            return res.status(403).send("Please provide all the expense details")
        }
        // Sanitize and convert amount to a number
        const parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount)) {
            return res.status(400).send("Amount must be a valid number");
        }
        // Calculate signed amount
        const signedAmount = type === 'credit' ? parsedAmount : -parsedAmount;

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

            // Save expense
            const expense = new Expense({
                userId: req.userId,
                clientId,
                details,
                amount: parsedAmount,
                type,
                category: type === 'credit' ? 'Income' : category,
                date: new Date(date),
            });

            await expense.save({ session });

            // Update user's net balance
            const user = await User.findByIdAndUpdate(
                req.userId,
                { $inc: { netBalance: signedAmount } },
                { session }
            );

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
        const expense = await Expense.findById(id)
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
        const { amount, details, category, date } = req.body
        const expense = await Expense.findById(id)
        const session = await Expense.startSession();
        session.startTransaction();

        try {
            if (parseFloat(amount) !== expense.amount) {
                let signedAmount = 0
                if (expense.type === 'debit') {
                    signedAmount = expense.amount - parseFloat(amount)
                } else {
                    signedAmount = parseFloat(amount) - expense.amount
                }

                const user = await User.findByIdAndUpdate(
                    req.userId,
                    { $inc: { netBalance: signedAmount } },
                    { session }
                );

                // 3. If user has an admin, update their balance too
                if (user?.admin) {
                }
            }
            await Expense.findByIdAndUpdate(id, { amount, details, category, date: new Date(date) }, { session });
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

    if (!userId) {
        return res.status(400).json({ message: 'User ID is required' });
    }
    const user = await User.findById(userId)
    if (!user) {
        return res.status(401).json({ message: 'User not found' });
    }

    const expenses = await Expense.find({ userId })
        .sort({ date: -1, createdAt: -1 })
        .skip(offset)
        .limit(limit);
    const totalCount = await Expense.countDocuments({ userId });
    const hasMore = offset + expenses.length < totalCount;

    return res.status(200).json({
        expenses,
        totalBalance: user.netBalance,
        hasMore,
    });
}