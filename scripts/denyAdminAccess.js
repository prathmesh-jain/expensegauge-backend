import dotenv from 'dotenv';
import mongoose from 'mongoose';
import User from '../models/userModel.js';
import { sendEmail } from '../utils/emailService.js';
import { connectDB } from '../config/dbConnection.js';
import dns from 'dns'

dns.setServers([
    '1.1.1.1',
    '1.0.0.1'
]);

dotenv.config();

async function denyAdminAccess(userId, reason = '') {
  try {
    // Connect to database
    await connectDB();
    console.log('Connected to database');

    // Find the user
    const user = await User.findById(userId);
    if (!user) {
      console.error('User not found with ID:', userId);
      process.exit(1);
    }

    if (user.role === 'admin') {
      console.log('User is already an admin:', user.email);
      console.log('Cannot deny admin access to existing admins.');
      process.exit(1);
    }

    if (!user.adminRequested) {
      console.log('User has not requested admin access:', user.email);
      console.log('Proceeding with denial anyway...');
    }

    // Clear admin request flags
    user.adminRequested = false;
    user.adminRequestedAt = undefined;
    await user.save();

    console.log('✅ Admin access request denied for user');
    console.log('User:', user.name);
    console.log('Email:', user.email);

    // Send denial email to user
    const reasonText = reason 
      ? `<p><strong>Reason:</strong> ${reason}</p>`
      : '';

    await sendEmail({
      to: user.email,
      subject: 'Admin Access Request Status - ExpenseGauge',
      text: `Admin Access Request Update

Dear ${user.name},

Thank you for your interest in admin access for ExpenseGauge.

After reviewing your request, we regret to inform you that your admin access request has been denied at this time.
${reason ? `\nReason: ${reason}` : ''}

You can continue using ExpenseGauge with your current user account. If you have any questions, please contact support.

Best regards,
The ExpenseGauge Team`,
      html: `
      <div style="font-family: Arial, sans-serif; background-color: #f7f9fb; padding: 20px;">
        <div style="max-width: 500px; background: #ffffff; border-radius: 10px; margin: auto; box-shadow: 0 2px 6px rgba(0,0,0,0.1); overflow: hidden;">
          <div style="background-color: #dc2626; padding: 20px; text-align: center;">
            <img src="https://expensegauge.vercel.app/icon.png" alt="ExpenseGauge Logo" width="80" height="auto" />
            <h2 style="color: white; margin: 10px 0 0;">ExpenseGauge</h2>
          </div>
          <div style="padding: 25px; color: #333;">
            <h3 style="color: #dc2626;">Admin Access Request Update</h3>
            <p>Dear <b>${user.name}</b>,</p>
            <p>Thank you for your interest in admin access for ExpenseGauge.</p>
            
            <p>After reviewing your request, we regret to inform you that your admin access request has been denied at this time.</p>
            ${reasonText}
            
            <p>You can continue using ExpenseGauge with your current user account. If you have any questions, please contact support.</p>
            <p style="margin-top: 25px;">Best regards,<br><b>The ExpenseGauge Team</b></p>
          </div>
          <div style="background: #f0f3fa; text-align: center; padding: 10px; font-size: 12px; color: #777;">
            © ${new Date().getFullYear()} ExpenseGauge. All rights reserved.
          </div>
        </div>
      </div>
      `
    });

    console.log('✅ Denial email sent to:', user.email);

  } catch (error) {
    console.error('❌ Error denying admin access:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('Database connection closed');
  }
}

// Get user ID from command line argument
const userId = process.argv[2];
const reason = process.argv[3] || '';

if (!userId) {
  console.error('Usage: node denyAdminAccess.js <user_id> [reason]');
  console.error('Example: node denyAdminAccess.js 507f1f77bcf86cd799439011 "Account not eligible"');
  process.exit(1);
}

denyAdminAccess(userId, reason);