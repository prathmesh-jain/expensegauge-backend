import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import User from '../models/userModel.js'
import mongoose from 'mongoose'
import Expense from '../models/expenseModel.js'
import { invalidateStatsCache } from '../utils/statsCache.js'

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
    const { amount, date, details } = req.body;
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

    // Start a transaction (optional but safer for consistency)
    const session = await Expense.startSession();
    session.startTransaction();

    try {
        // Save expense
        const expense = new Expense({
            userId,
            details: details,
            amount: parsedAmount,
            type: 'assign',
            category: 'Added by Admin',
            date: new Date(date),
        });

        await expense.save({ session });

        // Update user's net balance
        await User.findByIdAndUpdate(
            userId,
            { $inc: { netBalance: parsedAmount } },
            { session }
        );

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
        const expense = await Expense.findById(id)
        const parsedAmount = expense.amount
        const signedAmount = -parsedAmount;
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
        const expense = await Expense.findById(id)
        const session = await Expense.startSession();
        session.startTransaction();

        try {
            if (parseFloat(amount) !== expense.amount) {
                const signedAmount = parseFloat(amount) - expense.amount
                await User.findByIdAndUpdate(
                    userId,
                    { $inc: { netBalance: signedAmount } },
                    { session }
                );
            }
            await Expense.findByIdAndUpdate(id, { amount, details, date: new Date(date) }, { session });
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

    const user = await User.findById(userId).select('netBalance name');
    if (!user) {
        return res.status(404).json({ message: 'User not found' });
    }

    const expenses = await Expense.find({ userId })
        .sort({ date: -1 })
        .skip(offset)
        .limit(limit);

    const totalCount = await Expense.countDocuments({ userId });
    const hasMore = offset + expenses.length < totalCount;

    return res.status(200).json({
        expenses,
        user,
        hasMore,
    });
}



