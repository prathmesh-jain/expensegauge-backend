import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Expense from '../models/expenseModel.js';
import { connectDB } from '../config/dbConnection.js';
import { assertEncryptionKey, encrypt, decrypt } from '../utils/encryption.js';
import dns from 'dns'

dns.setServers([
    '1.1.1.1',
    '1.0.0.1'
]);

dotenv.config();

// One-off migration: encrypts `details` on expenses created before encryption was added.
//
// Safe to run while the app is live and safe to re-run:
// - only rows whose details are still plaintext are selected
// - each update is conditional on details being unchanged, so a concurrent edit is never overwritten
// - the app reads both plaintext and encrypted rows, so a partial run leaves nothing broken
//
// Deploy the encryption-aware backend BEFORE running this, otherwise the old code
// would serve ciphertext to the mobile app.
//
// Usage:
//   node scripts/encryptExistingExpenses.js --dry-run
//   node scripts/encryptExistingExpenses.js

const BATCH_SIZE = 500;
const dryRun = process.argv.includes('--dry-run');

// Raw driver queries bypass the schema getters/setters so we see stored values
const PLAINTEXT_FILTER = { details: { $type: 'string', $not: /^enc:v1:/ } };

async function encryptExistingExpenses() {
  try {
    assertEncryptionKey();
    await connectDB();
    if (mongoose.connection.readyState !== 1) {
      throw new Error('Could not connect to database');
    }

    const collection = Expense.collection;
    const total = await collection.countDocuments(PLAINTEXT_FILTER);
    console.log(`Found ${total} expense(s) with plaintext details${dryRun ? ' (dry run, nothing will be written)' : ''}`);

    if (total === 0 || dryRun) return;

    const cursor = collection.find(PLAINTEXT_FILTER, { projection: { _id: 1, details: 1 } }).batchSize(BATCH_SIZE);

    let processed = 0;
    let updated = 0;
    let batch = [];

    const flush = async () => {
      if (!batch.length) return;
      const result = await collection.bulkWrite(batch, { ordered: false });
      updated += result.modifiedCount;
      processed += batch.length;
      console.log(`  ${processed}/${total} processed`);
      batch = [];
    };

    for await (const doc of cursor) {
      const encrypted = encrypt(doc.details);
      // Round-trip check so a bad key/config can never write unreadable data
      if (decrypt(encrypted) !== doc.details) {
        throw new Error(`Round-trip check failed for expense ${doc._id}; aborting`);
      }
      batch.push({
        updateOne: {
          filter: { _id: doc._id, details: doc.details },
          update: { $set: { details: encrypted } },
        },
      });
      if (batch.length >= BATCH_SIZE) await flush();
    }
    await flush();

    const remaining = await collection.countDocuments(PLAINTEXT_FILTER);
    console.log(`\nEncrypted ${updated} expense(s). Plaintext remaining: ${remaining}`);
    if (remaining > 0) {
      console.log('Some rows changed during the run; re-run the script to pick them up.');
    }
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
    console.log('Database connection closed');
  }
}

encryptExistingExpenses();
