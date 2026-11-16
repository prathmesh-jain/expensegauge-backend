import mongoose from 'mongoose';
import { encrypt, decrypt } from '../utils/encryption.js';

const expenseSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  clientId: { type: String },
  // Encrypted at rest; getter returns plaintext so controllers are unaffected
  details: { type: String, required: true, set: encrypt, get: decrypt },
  amount: { type: Number, required: true },
  type: {
    type: String,
    required: true,
    enum: ['credit', 'debit', 'assign'],
  },
  category: {
    type: String,
  },
  date: {
    type: Date,
    required: true
  },
  afterBalance: {
    type: Number,
    default: 0,
  },
  sourceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AccountSource',
    default: null,
  },
  // Set when this entry was created from a shared group expense you paid.
  // `amount` is the full cash you paid; `ownShare` is your part of it, which
  // is what Insights counts as your spending.
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'groups', default: undefined },
  groupExpenseId: { type: mongoose.Schema.Types.ObjectId, ref: 'groupExpenses', default: undefined },
  ownShare: { type: Number, default: undefined },
  // Set when this entry records a settle-up payment (category "Settlement",
  // left out of Insights because it's repaying, not spending or earning)
  settlementId: { type: mongoose.Schema.Types.ObjectId, ref: 'settlements', default: undefined },
}, {
  timestamps: true,
  // Apply getters in API responses so clients receive decrypted details.
  // virtuals: false keeps the response shape unchanged (no extra `id` field).
  toJSON: { getters: true, virtuals: false },
  toObject: { getters: true, virtuals: false },
});

expenseSchema.index({ userId: 1, clientId: 1 }, { unique: true, sparse: true });

export default mongoose.model('expenses', expenseSchema);
