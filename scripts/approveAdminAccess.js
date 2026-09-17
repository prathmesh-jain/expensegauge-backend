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

const ADMIN_FEATURES = [
  'Register and manage multiple users',
  'Track expenses for all managed users',
  'Assign balances to users',
  'View comprehensive analytics and reports',
  'Remove and edit assigned balance entries',
  'Access admin-specific statistics and insights',
  'Download detailed expense reports'
];

async function approveAdminAccess(userId) {
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
      process.exit(0);
    }

    if (!user.adminRequested) {
      console.log('User has not requested admin access:', user.email);
      console.log('Proceeding with approval anyway...');
    }

    // Update user to admin
    user.role = 'admin';
    user.adminRequested = false;
    user.adminRequestedAt = undefined;
    
    // Invalidate all existing tokens by clearing refreshTokens array
    user.refreshTokens = [];
    await user.save();

    console.log('✅ User upgraded to admin successfully');
    console.log('User:', user.name);
    console.log('Email:', user.email);

    // Send approval email to user
    const featuresList = ADMIN_FEATURES.map(feature => `<li>${feature}</li>`).join('');

    await sendEmail({
      to: user.email,
      subject: 'Admin Access Approved - ExpenseGauge',
      text: `Admin Access Approved

Dear ${user.name},

Congratulations! Your admin access request for ExpenseGauge has been approved.

You can now access the following admin features:
${ADMIN_FEATURES.map(feature => `- ${feature}`).join('\n')}

IMPORTANT: For security reasons, your current session has been invalidated. Please log out and log in again to access admin features.

To get started:
1. Log out of your current session
2. Log in again with your credentials
3. Switch to admin view to access admin features

Best regards,
The ExpenseGauge Team`,
      html: `
      <div style="font-family: Arial, sans-serif; background-color: #f7f9fb; padding: 20px;">
        <div style="max-width: 500px; background: #ffffff; border-radius: 10px; margin: auto; box-shadow: 0 2px 6px rgba(0,0,0,0.1); overflow: hidden;">
          <div style="background-color: #3a6df0; padding: 20px; text-align: center;">
            <img src="https://expensegauge.vercel.app/icon.png" alt="ExpenseGauge Logo" width="80" height="auto" />
            <h2 style="color: white; margin: 10px 0 0;">ExpenseGauge</h2>
          </div>
          <div style="padding: 25px; color: #333;">
            <h3 style="color: #3a6df0;">🎉 Admin Access Approved!</h3>
            <p>Dear <b>${user.name}</b>,</p>
            <p>Congratulations! Your admin access request for ExpenseGauge has been approved.</p>
            
            <p>You can now access the following admin features:</p>
            <ul style="background: #f0f3fa; padding: 15px 20px; border-radius: 5px; margin: 15px 0;">
              ${featuresList}
            </ul>
            
            <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
              <p style="margin: 0; color: #856404;"><strong>⚠️ Important:</strong> For security reasons, your current session has been invalidated. Please log out and log in again to access admin features.</p>
            </div>
            
            <p>To get started:</p>
            <ol style="margin: 15px 0; padding-left: 20px;">
              <li>Log out of your current session</li>
              <li>Log in again with your credentials</li>
              <li>Switch to admin view to access admin features</li>
            </ol>
            <p style="margin-top: 25px;">Best regards,<br><b>The ExpenseGauge Team</b></p>
          </div>
          <div style="background: #f0f3fa; text-align: center; padding: 10px; font-size: 12px; color: #777;">
            © ${new Date().getFullYear()} ExpenseGauge. All rights reserved.
          </div>
        </div>
      </div>
      `
    });

    console.log('✅ Approval email sent to:', user.email);

  } catch (error) {
    console.error('❌ Error approving admin access:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('Database connection closed');
  }
}

// Get user ID from command line argument
const userId = process.argv[2];

if (!userId) {
  console.error('Usage: node approveAdminAccess.js <user_id>');
  console.error('Example: node approveAdminAccess.js 507f1f77bcf86cd799439011');
  process.exit(1);
}

approveAdminAccess(userId);