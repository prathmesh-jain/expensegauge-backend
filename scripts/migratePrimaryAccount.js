/**
 * Migration Script: Add Primary Account to Existing Users
 * 
 * This script:
 * 1. Creates a "Primary Account" (system account) for each user who doesn't have one
 * 2. Migrates all expenses without sourceId to the Primary Account
 * 3. Calculates and sets the correct transactionCount and currentBalance
 * 4. Marks the Primary Account as default if no default exists
 * 
 * Safe to run multiple times - checks for existing accounts before creating
 * Backward compatible - doesn't break existing data
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import AccountSource from '../models/accountModel.js';
import Expense from '../models/expenseModel.js';
import User from '../models/userModel.js';

dotenv.config();

const PRIMARY_ACCOUNT_NAME = 'Primary Account';

const normalizeName = (name) =>
  name.trim().toLowerCase().replace(/\s+/g, ' ');

async function migrate() {
  try {
    console.log('🚀 Starting Primary Account migration...\n');
    
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // Get all users
    const users = await User.find({});
    console.log(`📊 Found ${users.length} users to process\n`);

    let usersProcessed = 0;
    let accountsCreated = 0;
    let expensesMigrated = 0;

    for (const user of users) {
      try {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Processing user: ${user.name || user.email} (${user._id})`);
        console.log('='.repeat(60));

        // 1. Check if user already has a Primary Account (system account)
        let primaryAccount = await AccountSource.findOne({ 
          userId: user._id, 
          isSystem: true 
        });

        // 2. If no system account, check for existing "Primary Account" by name
        if (!primaryAccount) {
          primaryAccount = await AccountSource.findOne({
            userId: user._id,
            normalizedName: normalizeName(PRIMARY_ACCOUNT_NAME)
          });

          // Mark existing Primary Account as system account
          if (primaryAccount) {
            console.log(`  ✓ Found existing Primary Account, marking as system account`);
            primaryAccount.isSystem = true;
            await primaryAccount.save();
          }
        }

        // 3. Create Primary Account if it doesn't exist
        if (!primaryAccount) {
          console.log(`  ✓ Creating new Primary Account...`);
          
          // Check if user has any default account
          const hasDefault = await AccountSource.findOne({ 
            userId: user._id, 
            isDefault: true 
          });

          primaryAccount = new AccountSource({
            userId: user._id,
            name: PRIMARY_ACCOUNT_NAME,
            normalizedName: normalizeName(PRIMARY_ACCOUNT_NAME),
            type: 'cash',
            openingBalance: 0,
            currentBalance: 0,
            isDefault: !hasDefault, // Set as default if no default exists
            isSystem: true,
            transactionCount: 0,
            lastUsed: null,
          });
          await primaryAccount.save();
          accountsCreated++;
          console.log(`  ✅ Primary Account created (ID: ${primaryAccount._id})`);
        } else {
          console.log(`  ✓ Primary Account already exists (ID: ${primaryAccount._id})`);
        }

        // 4. Migrate expenses without sourceId to Primary Account
        const expensesWithoutSource = await Expense.find({
          userId: user._id,
          sourceId: null
        });

        if (expensesWithoutSource.length > 0) {
          console.log(`  ✓ Found ${expensesWithoutSource.length} expenses without sourceId`);
          
          // Update all expenses to point to Primary Account
          await Expense.updateMany(
            { userId: user._id, sourceId: null },
            { $set: { sourceId: primaryAccount._id } }
          );
          
          expensesMigrated += expensesWithoutSource.length;
          console.log(`  ✅ Migrated ${expensesWithoutSource.length} expenses to Primary Account`);
        } else {
          console.log(`  ✓ No expenses without sourceId found`);
        }

        // 5. Recalculate Primary Account stats
        const stats = await Expense.aggregate([
          {
            $match: {
              userId: user._id,
              sourceId: primaryAccount._id
            }
          },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              totalCredit: {
                $sum: {
                  $cond: [{ $eq: ['$type', 'credit'] }, '$amount', 0]
                }
              },
              totalDebit: {
                $sum: {
                  $cond: [{ $eq: ['$type', 'debit'] }, '$amount', 0]
                }
              },
              lastDate: { $max: '$date' }
            }
          }
        ]);

        if (stats.length > 0) {
          const { count, totalCredit, totalDebit, lastDate } = stats[0];
          primaryAccount.transactionCount = count;
          primaryAccount.currentBalance = totalCredit - totalDebit;
          primaryAccount.lastUsed = lastDate || null;
          await primaryAccount.save();
          console.log(`  ✅ Updated Primary Account stats:`);
          console.log(`     - Transactions: ${count}`);
          console.log(`     - Balance: ₹${(totalCredit - totalDebit).toFixed(2)}`);
        } else {
          console.log(`  ✓ No expenses found for Primary Account`);
        }

        usersProcessed++;
        console.log(`  ✅ User processing complete`);

      } catch (userError) {
        console.error(`  ❌ Error processing user ${user._id}:`, userError.message);
      }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log('📊 Migration Summary:');
    console.log('='.repeat(60));
    console.log(`✅ Users processed: ${usersProcessed}/${users.length}`);
    console.log(`✅ Primary Accounts created: ${accountsCreated}`);
    console.log(`✅ Expenses migrated: ${expensesMigrated}`);
    console.log('='.repeat(60));
    console.log('\n🎉 Migration completed successfully!\n');

  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 MongoDB connection closed\n');
    process.exit(0);
  }
}

migrate();
