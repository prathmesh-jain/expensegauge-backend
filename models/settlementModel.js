import mongoose from 'mongoose';
import { encrypt, decrypt } from '../utils/encryption.js';

export const PAYMENT_METHODS = ['cash', 'upi', 'bank', 'other'];

const serializeOptions = { getters: true, virtuals: false };

const transferSchema = new mongoose.Schema({
  from: { type: mongoose.Schema.Types.ObjectId, required: true },
  to: { type: mongoose.Schema.Types.ObjectId, required: true },
  amount: { type: Number, required: true },
}, { _id: false });

const netSchema = new mongoose.Schema({
  memberId: { type: mongoose.Schema.Types.ObjectId, required: true },
  net: { type: Number, required: true },
}, { _id: false });

const settlementSchema = new mongoose.Schema({
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'groups', required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true },
  createdByMemberId: { type: mongoose.Schema.Types.ObjectId, required: true },
  clientId: { type: String },
  // memberIds (slots in Group.members): `from` paid `to`
  fromMemberId: { type: mongoose.Schema.Types.ObjectId, required: true },
  toMemberId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Cash that actually changed hands
  amount: { type: Number, required: true },
  // Debt this payment cleared. Differs from `amount` only when rounded:
  // higher cash = the payer rounded up, lower cash = the receiver rounded down.
  settledAmount: { type: Number, required: true },
  method: { type: String, enum: PAYMENT_METHODS, default: 'cash' },
  note: { type: String, set: encrypt, get: decrypt },
  date: { type: Date, required: true },
  source: { type: String, enum: ['smart', 'manual'], default: 'manual' },
  // How the group stood when a smart-settle payment was recorded, so the
  // explanation stays true even after later expenses change the balances
  route: {
    type: new mongoose.Schema({
      before: { type: [transferSchema], default: [] },
      after: { type: [transferSchema], default: [] },
      nets: { type: [netSchema], default: [] },
      computedAt: { type: Date, required: true },
    }, { _id: false }),
    default: undefined,
  },
  // The creator's own personal entry for this payment, if any
  personalExpenseId: { type: mongoose.Schema.Types.ObjectId, ref: 'expenses', default: null },
  deletedAt: { type: Date, default: null },
}, {
  timestamps: true,
  toJSON: serializeOptions,
  toObject: serializeOptions,
});

settlementSchema.index({ groupId: 1, deletedAt: 1, date: -1, createdAt: -1 });
settlementSchema.index(
  { createdBy: 1, clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } }
);

export default mongoose.model('settlements', settlementSchema);
