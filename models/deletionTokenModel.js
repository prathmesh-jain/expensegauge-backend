import mongoose from 'mongoose';

const deletionTokenSchema = new mongoose.Schema({
  token: {
    type: String,
    required: true,
    unique: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'users',
    required: true,
  },
  email: {
    type: String,
    required: true,
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 }, // MongoDB TTL index for automatic deletion
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Index for faster lookups
deletionTokenSchema.index({ token: 1 });
deletionTokenSchema.index({ userId: 1 });

export default mongoose.model('DeletionToken', deletionTokenSchema);
