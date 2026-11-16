import mongoose from 'mongoose';
import { encrypt, decrypt } from '../utils/encryption.js';

const serializeOptions = { getters: true, virtuals: false };

// A member is a slot in the group. Slots added by name stay "pending" with no
// userId until someone joins with the invite and claims them. Slots added by
// email are "invited": linked to that user, who must accept before they can
// see the group (declining turns the slot back into a "pending" placeholder).
const memberSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'users', default: null },
  name: { type: String, required: true, set: encrypt, get: decrypt },
  status: {
    type: String,
    enum: ['active', 'pending', 'invited', 'left'],
    default: 'pending',
  },
  addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users', default: null },
  // Push notifications about this group for this person: null until they choose
  notify: { type: Boolean, default: null },
  joinedAt: { type: Date, default: null },
}, {
  toJSON: serializeOptions,
  toObject: serializeOptions,
});

const groupSchema = new mongoose.Schema({
  name: { type: String, required: true, set: encrypt, get: decrypt },
  currencySymbol: { type: String, default: '₹' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true },
  clientId: { type: String },
  members: { type: [memberSchema], default: [] },
  inviteCode: { type: String, required: true },
  // Smart settle: suggest the fewest payments instead of pairwise debts
  simplifyDebts: { type: Boolean, default: true },
  lastActivityAt: { type: Date, default: Date.now },
  // Member who made the latest change, so the app doesn't flag your own changes as new
  lastActivityBy: { type: mongoose.Schema.Types.ObjectId, default: null },
}, {
  timestamps: true,
  toJSON: serializeOptions,
  toObject: serializeOptions,
});

groupSchema.index({ inviteCode: 1 }, { unique: true });
groupSchema.index({ 'members.userId': 1 });
// Retried offline requests must not create a second group
groupSchema.index(
  { createdBy: 1, clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } }
);

export default mongoose.model('groups', groupSchema);
