import mongoose from 'mongoose';

const expenseSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  clientId: { type: String },
  details: { type: String, required: true },
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
  }
}, { timestamps: true });

expenseSchema.index({ userId: 1, clientId: 1 }, { unique: true, sparse: true });

export default mongoose.model('expenses', expenseSchema);
