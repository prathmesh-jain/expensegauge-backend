import mongoose from 'mongoose';

const accountSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true, trim: true },
  normalizedName: { type: String, required: true, lowercase: true, trim: true },
  type: {
    type: String,
    required: true,
    enum: ['bank', 'cash', 'wallet', 'credit_card', 'business'],
    default: 'bank',
  },
  openingBalance: { type: Number, default: 0 },
  currentBalance: { type: Number, default: 0 },
  isDefault: { type: Boolean, default: false },
  isSystem: { type: Boolean, default: false }, // System accounts cannot be edited/deleted
  transactionCount: { type: Number, default: 0 },
  lastUsed: { type: Date, default: null },
}, { timestamps: true });

// Compound unique index: one user cannot have two accounts with the same normalized name
accountSchema.index({ userId: 1, normalizedName: 1 }, { unique: true });
accountSchema.index({ userId: 1 });

export default mongoose.model('AccountSource', accountSchema);
