import dotenv from 'dotenv';
import mongoose from 'mongoose';
import User from '../models/userModel.js';
import { connectDB } from '../config/dbConnection.js';
import dns from 'dns'

dns.setServers([
    '1.1.1.1',
    '1.0.0.1'
]);

dotenv.config();

async function listAdminRequests() {
  try {
    // Connect to database
    await connectDB();
    console.log('Connected to database');

    // Find all users with pending admin requests
    const pendingRequests = await User.find({ 
      adminRequested: true, 
      role: { $ne: 'admin' } 
    }).select('name email adminRequestedAt _id').sort({ adminRequestedAt: -1 });

    if (pendingRequests.length === 0) {
      console.log('No pending admin requests found.');
      process.exit(0);
    }

    console.log(`\n📋 Pending Admin Requests (${pendingRequests.length}):\n`);
    console.log('═'.repeat(80));

    pendingRequests.forEach((user, index) => {
      const requestDate = user.adminRequestedAt 
        ? new Date(user.adminRequestedAt).toLocaleString() 
        : 'Unknown';
      
      console.log(`${index + 1}. User ID: ${user._id}`);
      console.log(`   Name: ${user.name}`);
      console.log(`   Email: ${user.email}`);
      console.log(`   Requested At: ${requestDate}`);
      console.log('─'.repeat(80));
    });

    console.log('\nTo approve a request, run:');
    console.log('node scripts/approveAdminAccess.js <user_id>');
    console.log('\nExample:');
    console.log(`node scripts/approveAdminAccess.js ${pendingRequests[0]._id}`);

  } catch (error) {
    console.error('❌ Error listing admin requests:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\nDatabase connection closed');
  }
}

listAdminRequests();