import Expense from '../models/expenseModel.js';
import User from '../models/userModel.js';
import AccountSource from '../models/accountModel.js';
import {
  decrementAccountStats,
  incrementAccountStats,
  resolveAndValidateSourceId,
} from '../controllers/expenseController.js';

// Personal entries made from group activity. They follow the same balance rules
// as addExpense/removeExpense/editExpense. Callers run them inside a transaction
// and then call recalculateAfterBalances + invalidateStatsCache.

const signed = (expense) => (expense.type === 'debit' ? -expense.amount : expense.amount);

const applyToBalances = async (userId, sourceId, signedAmount, session) => {
  await AccountSource.findByIdAndUpdate(sourceId, { $inc: { currentBalance: signedAmount } }, { session });
  await User.findByIdAndUpdate(userId, { $inc: { netBalance: signedAmount } }, { session });
};

export const SETTLEMENT_CATEGORY = 'Settlement';

export const createLinkedPersonalExpense = async ({
  userId, details, amount, ownShare, category, date, sourceId, groupId, groupExpenseId, settlementId,
  type = 'debit', session,
}) => {
  const resolvedSourceId = await resolveAndValidateSourceId(userId, sourceId, session);
  const [expense] = await Expense.create([{
    userId,
    // The expenses index allows only one entry per user without a clientId,
    // so linked entries get a stable one of their own
    clientId: settlementId ? `settle:${settlementId}` : `group:${groupExpenseId}`,
    details,
    amount,
    type,
    category: category || 'Other',
    date,
    sourceId: resolvedSourceId,
    groupId,
    groupExpenseId,
    settlementId,
    ownShare,
  }], { session });

  await applyToBalances(userId, resolvedSourceId, signed(expense), session);
  await incrementAccountStats(resolvedSourceId, date, session);
  return expense;
};

/** Returns false when the entry no longer exists (e.g. the user deleted it themselves). */
export const deleteLinkedPersonalExpense = async (expenseId, userId, session) => {
  if (!expenseId) return false;
  const expense = await Expense.findOne({ _id: expenseId, userId }).session(session);
  if (!expense) return false;

  if (expense.sourceId) {
    await applyToBalances(userId, expense.sourceId, -signed(expense), session);
    await decrementAccountStats(expense.sourceId, session);
  } else {
    await User.findByIdAndUpdate(userId, { $inc: { netBalance: -signed(expense) } }, { session });
  }
  await Expense.deleteOne({ _id: expense._id }, { session });
  return true;
};

/** Returns null when the entry no longer exists, so the caller can create a new one. */
export const updateLinkedPersonalExpense = async (expenseId, userId, fields, session) => {
  if (!expenseId) return null;
  const expense = await Expense.findOne({ _id: expenseId, userId }).session(session);
  if (!expense) return null;

  // Undo the old amount on the old account, then apply the new one
  if (expense.sourceId) {
    await applyToBalances(userId, expense.sourceId, -signed(expense), session);
    await decrementAccountStats(expense.sourceId, session);
  } else {
    await User.findByIdAndUpdate(userId, { $inc: { netBalance: -signed(expense) } }, { session });
  }

  const resolvedSourceId = await resolveAndValidateSourceId(userId, fields.sourceId || expense.sourceId, session);
  expense.details = fields.details;
  expense.amount = fields.amount;
  expense.ownShare = fields.ownShare;
  expense.category = fields.category || 'Other';
  expense.date = fields.date;
  expense.sourceId = resolvedSourceId;
  await expense.save({ session });

  await applyToBalances(userId, resolvedSourceId, signed(expense), session);
  await incrementAccountStats(resolvedSourceId, fields.date, session);
  return expense;
};
