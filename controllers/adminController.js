import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import User from '../models/userModel.js'
import mongoose from 'mongoose'
import Expense from '../models/expenseModel.js'
import AccountSource from '../models/accountModel.js'
import { invalidateStatsCache } from '../utils/statsCache.js'
import { recalculateAfterBalances } from '../utils/expenseBalance.js'

const getSignedAmount = (expense) => {
    const normalizedType = expense?.type?.toLowerCase();
    if (normalizedType === 'debit') return -expense.amount;
    return expense.amount;
};

const getManagedUser = async (adminId, userId, session = null) => {
    if (!mongoose.isValidObjectId(userId)) return null;
    const query = User.findOne({ _id: userId, admin: adminId });
    if (session) query.session(session);
    return query;
};

export const registerUser = async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(403).send("Please enter all details")
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    if (!passwordRegex.test(password)) {
        return res.status(400).send({ "message": "Password does not meet policy requirements" })
    }
    if (await User.findOne({ email })) {
        return res.status(400).send({ "message": "Email already exists" })
    }
    const saltrounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltrounds);
    const newuser = new User({
        name,
        email,
        password: hashedPassword,
        admin: req.userId,
        netBalance: 0,
        role: 'user'
    })
    await newuser.save();

    return res.status(200).send({ id: newuser._id, createdAt: newuser.createdAt })

}


export const verifyAdminAccess = (req, res, next) => {

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer '))
        return res.sendStatus(401);

    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.ACCESS_SECRET);

        if (decoded.role !== 'admin') return res.sendStatus(403)
        req.userId = decoded.userId;
        next();
    } catch (err) {
        return res.sendStatus(401); // Token expired/invalid
    }
};

export const deleteUser = async (req, res) => {
    const { userId } = req.params;

    try {
        await Expense.deleteMany({ userId }); // Delete all expenses for the user
        await AccountSource.deleteMany({ userId }); // Delete all accounts for the user
        const deletedUser = await User.findByIdAndDelete(userId); // Then delete the user
        if (!deletedUser) {
            return res.status(404).json({ message: 'User not found' });
        }
        invalidateStatsCache(userId);
        res.status(200).json({ message: 'User deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting user' });
    }
}

export const assignBalance = async (req, res) => {
    const { amount, date, details, clientId } = req.body;
    const userId = req.params.userId;

    if (!userId)
        return res.sendStatus(405)
    if (!amount || !date || !details) {
        return res.status(403).send("Please provide all the details")
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount)) {
        return res.status(400).send("Amount must be a valid number");
    }
    if (parsedAmount <= 0) {
        return res.status(400).send("Amount must be greater than zero");
    }
    if (typeof details !== 'string' || !details.trim()) {
        return res.status(400).send("Please provide valid details");
    }
    const parsedDate = new Date(date);
    if (Number.isNaN(parsedDate.getTime())) {
        return res.status(400).send("Please provide a valid date");
    }

    // Start a transaction (optional but safer for consistency)
    const session = await Expense.startSession();
    session.startTransaction();

    try {
        const managedUser = await getManagedUser(req.userId, userId, session);
        if (!managedUser) {
            await session.abortTransaction();
            session.endSession();
            return res.status(403).json({ message: 'You can only assign balance to your own users' });
        }

        if (clientId) {
            const existing = await Expense.findOne({ userId, clientId }).session(session);
            if (existing) {
                await session.commitTransaction();
                session.endSession();
                return res.status(200).send({ id: existing._id });
            }
        }

        // Save expense
        const expense = new Expense({
            userId,
            clientId,
            details: details.trim(),
            amount: parsedAmount,
            type: 'assign',
            category: 'Added by Admin',
            date: parsedDate,
        });

        await expense.save({ session });

        // Update user's net balance
        await User.findByIdAndUpdate(
            userId,
            { $inc: { netBalance: parsedAmount } },
            { session }
        );

        await recalculateAfterBalances(userId, session);

        // Commit transaction
        await session.commitTransaction();
        session.endSession();
        invalidateStatsCache(userId);
        return res.status(200).send({ "id": expense._id });
    } catch (innerError) {
        await session.abortTransaction();
        session.endSession();
        console.error(innerError);
        return res.status(500).send("Failed to save expense and update balance");
    }

}

export const getAllUsers = async (req, res) => {
    try {
        const offset = parseInt(req.query.offset) || 0;
        const limit = parseInt(req.query.limit) || 10;

        const adminObjectId = mongoose.Types.ObjectId.createFromHexString(req.userId);

        const users = await User.aggregate([
            { $match: { admin: adminObjectId } },
            { $sort: { createdAt: -1 } },
            { $skip: offset },
            { $limit: limit },
            {
                $project: {
                    password: 0,
                    refreshTokens: 0,
                    updatedAt: 0,
                    username: 0,
                    __v: 0,
                    admin: 0,
                    role: 0
                }
            }
        ]);
        const totalCount = await User.countDocuments({ admin: req.userId });
        const hasMore = offset + users.length < totalCount;

        const totalAgg = await User.aggregate([
            { $match: { admin: adminObjectId } },
            { $group: { _id: null, total: { $sum: '$netBalance' } } }
        ]);
        const totalUserBalance = totalAgg?.[0]?.total ?? 0;

        return res.status(200).json({
            users,
            totalUserBalance,
            hasMore,
        });
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: 'Error getting all users' });
    }
}

export const removeUserExpense = async (req, res) => {
    try {
        const id = req.params.id
        const userId = req.params.userId

        const managedUser = await getManagedUser(req.userId, userId);
        if (!managedUser) {
            return res.status(403).json({ message: 'You can only modify your own users' });
        }

        const expense = await Expense.findById(id)
        if (!expense || expense.userId.toString() !== userId) {
            return res.status(404).json({ message: 'Expense not found' });
        }
        if (expense.type !== 'assign') {
            return res.status(403).json({ message: 'Admin can only remove assigned balance entries' });
        }
        const parsedAmount = expense.amount
        const signedAmount = -getSignedAmount(expense);
        // Start a transaction (optional but safer for consistency)
        const session = await Expense.startSession();
        session.startTransaction();
        try {

            await Expense.findByIdAndDelete(id, { session })

            await User.findByIdAndUpdate(
                userId,
                { $inc: { netBalance: signedAmount } },
                { session }
            );
            await recalculateAfterBalances(userId, session);
            // Commit transaction
            await session.commitTransaction();
            session.endSession();

            invalidateStatsCache(userId);

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

export const edituserExpense = async (req, res) => {
    try {
        const id = req.params.id
        const userId = req.params.userId
        const { amount, details, date } = req.body

        const managedUser = await getManagedUser(req.userId, userId);
        if (!managedUser) {
            return res.status(403).json({ message: 'You can only modify your own users' });
        }

        const expense = await Expense.findById(id)
        if (!expense || expense.userId.toString() !== userId) {
            return res.status(404).json({ message: 'Expense not found' });
        }
        if (expense.type !== 'assign') {
            return res.status(403).json({ message: 'Admin can only edit assigned balance entries' });
        }
        const session = await Expense.startSession();
        session.startTransaction();

        try {
            const parsedAmount = parseFloat(amount);
            if (Number.isNaN(parsedAmount) || parsedAmount <= 0) {
                await session.abortTransaction();
                session.endSession();
                return res.status(400).json({ message: 'Amount must be a valid positive number' });
            }

            if (!details || !details.trim()) {
                await session.abortTransaction();
                session.endSession();
                return res.status(400).json({ message: 'Details are required' });
            }

            const parsedDate = new Date(date);
            if (Number.isNaN(parsedDate.getTime())) {
                await session.abortTransaction();
                session.endSession();
                return res.status(400).json({ message: 'Invalid date provided' });
            }

            if (parsedAmount !== expense.amount) {
                const multiplier = expense.type === 'debit' ? -1 : 1;
                const signedAmount = (parsedAmount - expense.amount) * multiplier;
                await User.findByIdAndUpdate(
                    userId,
                    { $inc: { netBalance: signedAmount } },
                    { session }
                );
            }
            await Expense.findByIdAndUpdate(id, {
                amount: parsedAmount,
                details: details.trim(),
                date: parsedDate
            }, { session });
            await recalculateAfterBalances(userId, session);
            // Commit transaction
            await session.commitTransaction();
            session.endSession();

            invalidateStatsCache(userId);
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

export const getUserExpenses = async (req, res) => {
    const userId = req.params.userId;
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 10;

    if (!userId) {
        return res.status(400).json({ message: 'User ID is required' });
    }

    const user = await User.findOne({ _id: userId, admin: req.userId }).select('netBalance name');
    if (!user) {
        return res.status(404).json({ message: 'User not found for this admin' });
    }

    const expenses = await Expense.find({ userId })
        .sort({ date: -1, createdAt: -1 })
        .skip(offset)
        .limit(limit);

    if (expenses.some((expense) => typeof expense.afterBalance !== "number")) {
        await recalculateAfterBalances(userId);
    }

    const latestExpenses = await Expense.find({ userId })
        .sort({ date: -1, createdAt: -1 })
        .skip(offset)
        .limit(limit);

    const totalCount = await Expense.countDocuments({ userId });
    const hasMore = offset + latestExpenses.length < totalCount;

    return res.status(200).json({
        expenses: latestExpenses,
        user,
        hasMore,
    });
}



