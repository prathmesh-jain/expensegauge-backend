import AccountSource from '../models/accountModel.js';
import Expense from '../models/expenseModel.js';
import User from '../models/userModel.js';
import { invalidateStatsCache } from '../utils/statsCache.js';
import { recalculateAfterBalances } from '../utils/expenseBalance.js';

const DEFAULT_ACCOUNT_NAME = 'Primary Account';

const normalizeName = (name) =>
  name.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Ensures a default "Primary Account" account exists for the user.
 * Returns the default account (existing or newly created).
 */
export const ensureDefaultAccount = async (userId, session = null) => {
  // First try to find existing Primary Account (system account)
  let existing = await AccountSource.findOne({ userId, isSystem: true }, null, session ? { session } : {});
  if (existing) return existing;

  // If no system account, check for any default account
  existing = await AccountSource.findOne({ userId, isDefault: true }, null, session ? { session } : {});
  if (existing) return existing;

  // Create new Primary Account as system account
  const normalizedName = normalizeName(DEFAULT_ACCOUNT_NAME);
  const created = new AccountSource({
    userId,
    name: DEFAULT_ACCOUNT_NAME,
    normalizedName,
    type: 'cash',
    openingBalance: 0,
    currentBalance: 0,
    isDefault: true,
    isSystem: true,
    transactionCount: 0,
    lastUsed: null,
  });
  await created.save(session ? { session } : {});
  return created;
};

// GET /api/v1/account/
export const getAccounts = async (req, res) => {
  try {
    // Ensure Primary Account exists for this user
    await ensureDefaultAccount(req.userId);
    
    // Fetch all accounts sorted: system account first, then by creation date
    const accounts = await AccountSource.find({ userId: req.userId })
      .sort({ isSystem: -1, isDefault: -1, createdAt: 1 });
    
    return res.status(200).json({ accounts });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Failed to fetch accounts' });
  }
};

// POST /api/v1/account/
export const createAccount = async (req, res) => {
  try {
    const { name, type, openingBalance } = req.body;
    if (!name || !type) return res.status(400).json({ message: 'Name and type are required' });

    const trimmedName = name.trim();
    const normalizedName = normalizeName(trimmedName);

    // Unique name check using normalizedName (compound unique index will also catch it)
    const existing = await AccountSource.findOne({ userId: req.userId, normalizedName });
    if (existing) return res.status(409).json({ message: 'An account with this name already exists' });

    const parsed = parseFloat(openingBalance) || 0;
    const account = new AccountSource({
      userId: req.userId,
      name: trimmedName,
      normalizedName,
      type,
      openingBalance: parsed,
      currentBalance: parsed,
      isDefault: false,
      transactionCount: 0,
      lastUsed: null,
    });
    await account.save();

    // Create an "Opening Balance" credit transaction if balance > 0
    if (parsed !== 0) {
      const expense = new Expense({
        userId: req.userId,
        details: `Opening Balance for ${trimmedName}`,
        amount: parsed,
        type: 'credit',
        category: 'Opening Balance',
        date: new Date(),
        sourceId: account._id,
      });
      await expense.save();

      // Update user's netBalance
      await User.findByIdAndUpdate(req.userId, { $inc: { netBalance: parsed } });

      // Update account transactionCount & lastUsed
      account.transactionCount = 1;
      account.lastUsed = new Date();
      await account.save();

      await recalculateAfterBalances(req.userId);
      invalidateStatsCache(req.userId);
    }

    return res.status(201).json({ account });
  } catch (error) {
    // Handle compound unique index violation
    if (error.code === 11000) {
      return res.status(409).json({ message: 'An account with this name already exists' });
    }
    console.error(error);
    return res.status(500).json({ message: 'Failed to create account' });
  }
};

// PATCH /api/v1/account/:id
export const updateAccount = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, type } = req.body;

    const account = await AccountSource.findOne({ _id: id, userId: req.userId });
    if (!account) return res.status(404).json({ message: 'Account not found' });

    // Prevent editing system accounts
    if (account.isSystem) {
      return res.status(403).json({ message: 'System account cannot be edited' });
    }

    if (name) {
      const trimmedName = name.trim();
      const normalizedName = normalizeName(trimmedName);
      // Unique name check (excluding current account) using normalizedName
      const existing = await AccountSource.findOne({
        userId: req.userId,
        normalizedName,
        _id: { $ne: id },
      });
      if (existing) return res.status(409).json({ message: 'An account with this name already exists' });
      account.name = trimmedName;
      account.normalizedName = normalizedName;
    }
    if (type) account.type = type;

    await account.save();
    return res.status(200).json({ account });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: 'An account with this name already exists' });
    }
    console.error(error);
    return res.status(500).json({ message: 'Failed to update account' });
  }
};

// PATCH /api/v1/account/:id/set-default
export const setDefaultAccount = async (req, res) => {
  try {
    const { id } = req.params;

    const account = await AccountSource.findOne({ _id: id, userId: req.userId });
    if (!account) return res.status(404).json({ message: 'Account not found' });

    // Unset all defaults for this user, then set the new one
    await AccountSource.updateMany({ userId: req.userId }, { $set: { isDefault: false } });
    account.isDefault = true;
    await account.save();

    return res.status(200).json({ account });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Failed to set default account' });
  }
};

// DELETE /api/v1/account/:id
// Body: { transferToAccountId } — the account to re-assign expenses to
export const deleteAccount = async (req, res) => {
  try {
    const { id } = req.params;
    const { transferToAccountId } = req.body;

    const account = await AccountSource.findOne({ _id: id, userId: req.userId });
    if (!account) return res.status(404).json({ message: 'Account not found' });

    // Prevent deleting system accounts
    if (account.isSystem) {
      return res.status(403).json({ message: 'System account cannot be deleted' });
    }

    if (account.isDefault) {
      return res.status(400).json({ message: 'Cannot delete the default account. Set another account as default first.' });
    }

    // Validate transferToAccountId
    if (!transferToAccountId) {
      return res.status(400).json({ message: 'Please specify which account to transfer expenses to' });
    }

    const transferAccount = await AccountSource.findOne({ _id: transferToAccountId, userId: req.userId });
    if (!transferAccount) {
      return res.status(400).json({ message: 'Transfer target account not found' });
    }

    if (transferToAccountId === id) {
      return res.status(400).json({ message: 'Cannot transfer expenses to the same account being deleted' });
    }

    // Count expenses being transferred (for updating transactionCount)
    const transferredCount = await Expense.countDocuments({ userId: req.userId, sourceId: id });

    // Transfer the current balance from deleted account to the target account
    await AccountSource.findByIdAndUpdate(
      transferToAccountId,
      {
        $inc: {
          currentBalance: account.currentBalance,
          transactionCount: transferredCount,
        },
        $set: {
          // Use the later of the two lastUsed dates
          lastUsed: account.lastUsed && transferAccount.lastUsed
            ? (account.lastUsed > transferAccount.lastUsed ? account.lastUsed : transferAccount.lastUsed)
            : account.lastUsed || transferAccount.lastUsed || null,
        },
      }
    );

    // Re-assign expenses to the transfer target account
    await Expense.updateMany({ userId: req.userId, sourceId: id }, { $set: { sourceId: transferToAccountId } });

    await AccountSource.findByIdAndDelete(id);

    invalidateStatsCache(req.userId);

    return res.status(200).json({ message: 'Account deleted and expenses transferred' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Failed to delete account' });
  }
};
