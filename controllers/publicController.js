import crypto from 'crypto';
import User from '../models/userModel.js';
import Expense from '../models/expenseModel.js';
import AccountSource from '../models/accountModel.js';
import { sendEmail } from '../utils/emailService.js';
import dotenv from 'dotenv';

dotenv.config();

// Store deletion tokens (in production, use Redis or database)
const deletionTokens = new Map();

// Clean up expired tokens periodically
setInterval(() => {
    const now = Date.now();
    for (const [token, data] of deletionTokens.entries()) {
        if (data.expiresAt < now) {
            deletionTokens.delete(token);
        }
    }
}, 60 * 60 * 1000); // Every hour

export const requestAccountDeletion = async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ message: 'Email is required' });
        }

        const user = await User.findOne({ email });

        if (!user) {
            // Don't reveal if email exists for security
            return res.status(200).json({ message: 'If an account exists with this email, a deletion link will be sent.' });
        }

        // Generate secure token
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

        deletionTokens.set(token, {
            userId: user._id,
            email: user.email,
            expiresAt,
        });

        // Send deletion email
        const deletionLink = `${process.env.BASE_URL || 'http://localhost:3000'}/confirm-deletion.html?token=${token}`;

        await sendEmail({
            to: user.email,
            subject: 'Confirm Account Deletion - ExpenseGauge',
            text: `Account Deletion Request

We received a request to delete your ExpenseGauge account associated with ${user.email}.

To confirm the deletion of your account and all associated data, click the link below:

${deletionLink}

This link will expire in 24 hours.

If you did not request this deletion, please ignore this email. Your account will not be deleted.

Best regards,
The ExpenseGauge Team`,
            html: `
            <div style="font-family: Arial, sans-serif; background-color: #f7f9fb; padding: 20px;">
                <div style="max-width: 500px; background: #ffffff; border-radius: 10px; margin: auto; box-shadow: 0 2px 6px rgba(0,0,0,0.1); overflow: hidden;">
                <div style="background-color: #dc3545; padding: 20px; text-align: center;">
                    <h2 style="color: white; margin: 0;">ExpenseGauge</h2>
                </div>
                <div style="padding: 25px; color: #333;">
                    <h3 style="color: #dc3545;">Account Deletion Request</h3>
                    <p>We received a request to delete your ExpenseGauge account associated with <strong>${user.email}</strong>.</p>
                    
                    <p style="margin: 20px 0;">To confirm the deletion of your account and all associated data, click the button below:</p>
                    
                    <div style="text-align: center; margin: 25px 0;">
                        <a href="${deletionLink}" style="background-color: #dc3545; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">Delete My Account</a>
                    </div>
                    
                    <p style="font-size: 13px; color: #666;">This link will expire in 24 hours.</p>
                    
                    <div style="background: #fff3cd; padding: 15px; border-radius: 5px; margin: 20px 0;">
                        <p style="margin: 0; font-size: 13px; color: #856404;">
                            <strong>Warning:</strong> This action cannot be undone. All your data including expenses, accounts, and personal information will be permanently deleted.
                        </p>
                    </div>
                    
                    <p style="margin-top: 25px;">If you did not request this deletion, please ignore this email. Your account will not be deleted.</p>
                    <p style="margin-top: 25px;">Best regards,<br><b>The ExpenseGauge Team</b></p>
                </div>
                <div style="background: #f0f3fa; text-align: center; padding: 10px; font-size: 12px; color: #777;">
                    © ${new Date().getFullYear()} ExpenseGauge. All rights reserved.
                </div>
                </div>
            </div>
            `
        });

        res.status(200).json({ message: 'If an account exists with this email, a deletion link will be sent.' });
    } catch (error) {
        console.error('Request account deletion error:', error);
        res.status(500).json({ message: 'Error processing request' });
    }
};

export const verifyDeletionToken = async (req, res) => {
    try {
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({ message: 'Token is required' });
        }

        const tokenData = deletionTokens.get(token);

        if (!tokenData || tokenData.expiresAt < Date.now()) {
            return res.status(400).json({ message: 'Invalid or expired token' });
        }

        const user = await User.findById(tokenData.userId);

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Check if user has managed users (for admin)
        let hasManagedUsers = false;
        if (user.role === 'admin') {
            const managedUsers = await User.find({ admin: user._id });
            hasManagedUsers = managedUsers.length > 0;
        }

        res.status(200).json({
            email: user.email,
            role: user.role,
            hasManagedUsers
        });
    } catch (error) {
        console.error('Verify deletion token error:', error);
        res.status(500).json({ message: 'Error verifying token' });
    }
};

export const confirmAccountDeletion = async (req, res) => {
    try {
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({ message: 'Token is required' });
        }

        const tokenData = deletionTokens.get(token);

        if (!tokenData || tokenData.expiresAt < Date.now()) {
            return res.status(400).json({ message: 'Invalid or expired token' });
        }

        const userId = tokenData.userId;

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // If user is an admin, delete all managed users and their data
        if (user.role === 'admin') {
            const managedUsers = await User.find({ admin: userId });

            for (const managedUser of managedUsers) {
                await Expense.deleteMany({ userId: managedUser._id });
                await AccountSource.deleteMany({ userId: managedUser._id });
                await User.findByIdAndDelete(managedUser._id);
            }
        }

        // Delete user's expenses and accounts
        await Expense.deleteMany({ userId });
        await AccountSource.deleteMany({ userId });

        // Delete the user
        await User.findByIdAndDelete(userId);

        // Remove the token
        deletionTokens.delete(token);

        res.status(200).json({ message: 'Account deleted successfully' });
    } catch (error) {
        console.error('Confirm account deletion error:', error);
        res.status(500).json({ message: 'Error deleting account' });
    }
};
