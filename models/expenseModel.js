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
  }
}, {
  timestamps: true,
  // Apply getters in API responses so clients receive decrypted details.
  // virtuals: false keeps the response shape unchanged (no extra `id` field).
  toJSON: { getters: true, virtuals: false },
  toObject: { getters: true, virtuals: false },
});

expenseSchema.index({ userId: 1, clientId: 1 }, { unique: true, sparse: true });

export default mongoose.model('expenses', expenseSchema);
