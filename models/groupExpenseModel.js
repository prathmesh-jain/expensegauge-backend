import mongoose from 'mongoose';
import { encrypt, decrypt } from '../utils/encryption.js';

export const SPLIT_TYPES = ['equal', 'exact', 'percent', 'shares'];

const serializeOptions = { getters: true, virtuals: false };

// memberId refers to a slot in Group.members (works before the person has joined)
const portionSchema = new mongoose.Schema({
  memberId: { type: mongoose.Schema.Types.ObjectId, required: true },
  amount: { type: Number, required: true },
  // Percent or number of shares, for splits made that way (so they can be edited as entered)
  weight: { type: Number, default: undefined },
}, { _id: false });

// One changed value in an edit. `memberId` is set for a person's share.
// Values are stored as text and encrypted, since `details` can be one of them.
const changeSchema = new mongoose.Schema({
  field: { type: String, enum: ['details', 'amount', 'date', 'category', 'paidBy', 'splitType', 'share'], required: true },
  memberId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
  from: { type: String, set: encrypt, get: decrypt },
  to: { type: String, set: encrypt, get: decrypt },
}, { _id: false, toJSON: serializeOptions, toObject: serializeOptions });

const editSchema = new mongoose.Schema({
  at: { type: Date, required: true },
  byMemberId: { type: mongoose.Schema.Types.ObjectId, required: true },
  changes: { type: [changeSchema], default: [] },
}, { _id: false, toJSON: serializeOptions, toObject: serializeOptions });

const groupExpenseSchema = new mongoose.Schema({
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'groups', required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true },
  createdByMemberId: { type: mongoose.Schema.Types.ObjectId, required: true },
  clientId: { type: String },
  details: { type: String, required: true, set: encrypt, get: decrypt },
  amount: { type: Number, required: true },
  category: { type: String, default: 'Other' },
  date: { type: Date, required: true },
  // A list so several payers can be supported later; one payer for now
  paidBy: { type: [portionSchema], required: true },
  splitType: { type: String, enum: SPLIT_TYPES, default: 'equal' },
  // Always resolved amounts that add up to `amount`
  splits: { type: [portionSchema], required: true },
  // The creator's own personal expense created alongside this one, if any
  personalExpenseId: { type: mongoose.Schema.Types.ObjectId, ref: 'expenses', default: null },
  // What each edit changed, oldest first, so everyone can see how it changed
  edits: { type: [editSchema], default: [] },
  // Soft delete keeps a record; deleted expenses don't count toward balances
  deletedAt: { type: Date, default: null },
}, {
  timestamps: true,
  toJSON: serializeOptions,
  toObject: serializeOptions,
});

groupExpenseSchema.index({ groupId: 1, deletedAt: 1, date: -1, createdAt: -1 });
groupExpenseSchema.index(
  { createdBy: 1, clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } }
);

export default mongoose.model('groupExpenses', groupExpenseSchema);
