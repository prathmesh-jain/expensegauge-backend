import mongoose from 'mongoose';
import Group from '../models/groupModel.js';
import GroupExpense, { SPLIT_TYPES } from '../models/groupExpenseModel.js';
import { findMyMember, loadMemberGroup, serializeGroupWithBalances } from './groupController.js';
import { sameId } from '../utils/ids.js';
import {
  createLinkedPersonalExpense,
  deleteLinkedPersonalExpense,
  updateLinkedPersonalExpense,
} from '../utils/personalLedger.js';
import { recalculateAfterBalances } from '../utils/expenseBalance.js';
import { invalidateStatsCache } from '../utils/statsCache.js';
import { notifyExpense } from '../utils/groupNotifications.js';
import { fromPaise, splitByWeights, splitEqually, toPaise } from '../utils/groupMoney.js';
import {
  AMOUNT_TOO_LARGE_MESSAGE,
  DETAILS_TOO_LONG_MESSAGE,
  isAmountTooLarge,
  isDetailsTooLong,
} from '../utils/expenseLimits.js';

const MAX_CATEGORY_LENGTH = 40;
const MAX_SHARES = 1000;

export class InputError extends Error {}

const personalDetails = (details, groupName) => `${details} · ${groupName}`;

export const serializeGroupExpense = (expense, me) => {
  const isMine = sameId(expense.createdByMemberId, me?._id);
  const myShare = expense.splits.find((s) => sameId(s.memberId, me?._id))?.amount ?? 0;
  const myPaid = expense.paidBy.find((p) => sameId(p.memberId, me?._id))?.amount ?? 0;
  return {
    _id: expense._id,
    clientId: expense.clientId ?? null,
    details: expense.details,
    amount: expense.amount,
    category: expense.category,
    date: expense.date,
    splitType: expense.splitType,
    paidBy: expense.paidBy.map((p) => ({ memberId: p.memberId, amount: p.amount })),
    // `weight` is the percent or number of shares when split that way
    splits: expense.splits.map((s) => ({
      memberId: s.memberId,
      amount: s.amount,
      ...(typeof s.weight === 'number' ? { weight: s.weight } : {}),
    })),
    createdByMemberId: expense.createdByMemberId,
    createdAt: expense.createdAt,
    updatedAt: expense.updatedAt,
    // Only the person who added an expense can change it
    canEdit: isMine,
    addedToPersonal: isMine && !!expense.personalExpenseId,
    myShare,
    myPaid,
    edits: (expense.edits || []).map((edit) => ({
      at: edit.at,
      byMemberId: edit.byMemberId,
      changes: edit.changes.map((c) => ({
        field: c.field,
        memberId: c.memberId ?? null,
        from: c.from ?? null,
        to: c.to ?? null,
      })),
    })),
  };
};

const MAX_EDITS_KEPT = 30;
const money = (amount) => fromPaise(toPaise(amount)).toFixed(2);
const day = (date) => new Date(date).toISOString().slice(0, 10);

/** What an edit changes, as readable before/after values. Empty when nothing changed. */
const describeChanges = (expense, input) => {
  const changes = [];
  const add = (field, from, to, memberId) => changes.push({ field, from: String(from), to: String(to), ...(memberId ? { memberId } : {}) });

  if (expense.details !== input.details) add('details', expense.details, input.details);
  if (toPaise(expense.amount) !== toPaise(input.amount)) add('amount', money(expense.amount), money(input.amount));
  if (day(expense.date) !== day(input.date)) add('date', day(expense.date), day(input.date));
  if ((expense.category || 'Other') !== input.category) add('category', expense.category || 'Other', input.category);
  const oldPayer = String(expense.paidBy[0]?.memberId);
  const newPayer = String(input.paidBy[0].memberId);
  if (oldPayer !== newPayer) add('paidBy', oldPayer, newPayer);
  if (expense.splitType !== input.splitType) add('splitType', expense.splitType, input.splitType);

  // Each person whose share went up, down, in or out ("0.00" when not on it)
  const before = new Map(expense.splits.map((s) => [String(s.memberId), toPaise(s.amount)]));
  const after = new Map(input.splits.map((s) => [String(s.memberId), toPaise(s.amount)]));
  for (const memberId of new Set([...before.keys(), ...after.keys()])) {
    const from = before.get(memberId) ?? 0;
    const to = after.get(memberId) ?? 0;
    if (from !== to) add('share', fromPaise(from).toFixed(2), fromPaise(to).toFixed(2), memberId);
  }
  return changes;
};

/**
 * Validates the form and resolves the split into exact amounts.
 * `existing` is passed when editing: members who have since left can stay on
 * an expense they were already part of, and over-limit values that weren't
 * changed are accepted (same rule as personal expenses).
 */
const parseExpenseInput = (body, group, existing = null) => {
  const memberById = new Map(group.members.map((m) => [String(m._id), m]));
  const wasOnExpense = new Set(existing
    ? [...existing.paidBy, ...existing.splits].map((p) => String(p.memberId))
    : []);
  const usableMember = (id) => {
    if (typeof id !== 'string' || !mongoose.isValidObjectId(id)) return null;
    const member = memberById.get(id);
    if (!member) return null;
    if (member.status === 'left' && !wasOnExpense.has(id)) return null;
    return member;
  };

  // details
  if (typeof body.details !== 'string' || !body.details.trim()) throw new InputError('Details are required');
  const details = body.details.trim();
  if (isDetailsTooLong(details) && details !== existing?.details) throw new InputError(DETAILS_TOO_LONG_MESSAGE);

  // amount
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new InputError('Amount must be a valid positive number');
  if (isAmountTooLarge(amount) && amount !== existing?.amount) throw new InputError(AMOUNT_TOO_LARGE_MESSAGE);
  const totalPaise = toPaise(amount);
  if (totalPaise < 1) throw new InputError('Amount must be at least 0.01');

  // date
  const date = new Date(body.date);
  if (!body.date || Number.isNaN(date.getTime())) throw new InputError('Invalid date');

  // category
  const category = typeof body.category === 'string' && body.category.trim()
    ? body.category.trim().slice(0, MAX_CATEGORY_LENGTH)
    : 'Other';

  // payer
  const payer = usableMember(body.paidByMemberId);
  if (!payer) throw new InputError('Choose who paid from the group members');

  // split
  const splitType = SPLIT_TYPES.includes(body.splitType) ? body.splitType : 'equal';
  let splitPaise;
  if (splitType === 'percent' || splitType === 'shares') {
    // Weights in hundredths so 33.33% or 1.5 shares stay whole numbers
    const rows = Array.isArray(body.splits) ? body.splits : [];
    const seen = new Set();
    const weighted = [];
    for (const row of rows) {
      const id = String(row?.memberId ?? '');
      if (!usableMember(id)) throw new InputError('Someone in the split is not in this group');
      if (seen.has(id)) throw new InputError('Each person can only be included once');
      seen.add(id);
      const value = Number(row.weight);
      if (!Number.isFinite(value) || value < 0) throw new InputError(`${splitType === 'percent' ? 'Percentages' : 'Shares'} cannot be negative`);
      if (splitType === 'shares' && value > MAX_SHARES) throw new InputError(`Shares can be at most ${MAX_SHARES} per person`);
      const weight = Math.round(value * 100);
      if (weight > 0) weighted.push({ memberId: id, weight });
    }
    if (weighted.length === 0) {
      throw new InputError(splitType === 'percent' ? 'Enter each person\'s percentage' : 'Give at least one person a share');
    }
    if (splitType === 'percent') {
      const sum = weighted.reduce((total, row) => total + row.weight, 0);
      if (sum !== 10000) throw new InputError(`Percentages add up to ${(sum / 100).toFixed(2)}%, they need to add up to 100%`);
    }
    // Group order breaks rounding ties, same as equal splits
    const order = new Map(group.members.map((m, index) => [String(m._id), index]));
    weighted.sort((a, b) => order.get(a.memberId) - order.get(b.memberId));
    const weightOf = new Map(weighted.map((row) => [row.memberId, row.weight / 100]));
    splitPaise = splitByWeights(totalPaise, weighted)
      .map((row) => ({ ...row, weight: weightOf.get(row.memberId) }));
  } else if (splitType === 'equal') {
    const ids = Array.isArray(body.participantIds) ? body.participantIds.map(String) : [];
    if (new Set(ids).size !== ids.length) throw new InputError('Each person can only be included once');
    if (ids.length === 0) throw new InputError('Choose at least one person to split with');
    for (const id of ids) {
      if (!usableMember(id)) throw new InputError('Someone in the split is not in this group');
    }
    // Group order, not request order, decides who gets the leftover paise
    const ordered = group.members.map((m) => String(m._id)).filter((id) => ids.includes(id));
    splitPaise = splitEqually(totalPaise, ordered);
  } else {
    const rows = Array.isArray(body.splits) ? body.splits : [];
    const seen = new Set();
    splitPaise = [];
    for (const row of rows) {
      const id = String(row?.memberId ?? '');
      if (!usableMember(id)) throw new InputError('Someone in the split is not in this group');
      if (seen.has(id)) throw new InputError('Each person can only be included once');
      seen.add(id);
      const value = Number(row.amount);
      if (!Number.isFinite(value) || value < 0) throw new InputError('Split amounts cannot be negative');
      const paise = toPaise(value);
      if (paise > 0) splitPaise.push({ memberId: id, paise });
    }
    if (splitPaise.length === 0) throw new InputError('Enter how much each person owes');
    const sum = splitPaise.reduce((total, row) => total + row.paise, 0);
    if (sum !== totalPaise) {
      throw new InputError(`Split amounts add up to ${fromPaise(sum).toFixed(2)}, but the expense is ${fromPaise(totalPaise).toFixed(2)}`);
    }
  }

  return {
    details,
    amount: fromPaise(totalPaise),
    date,
    category,
    paidBy: [{ memberId: payer._id, amount: fromPaise(totalPaise) }],
    splitType,
    splits: splitPaise.map((row) => ({
      memberId: row.memberId,
      amount: fromPaise(row.paise),
      ...(row.weight !== undefined ? { weight: row.weight } : {}),
    })),
  };
};

const shareOf = (input, memberId) => input.splits.find((s) => sameId(s.memberId, memberId))?.amount ?? 0;

export const withTransaction = async (work) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

export const handleError = (res, error, fallback) => {
  if (error instanceof InputError) return res.status(400).json({ message: error.message });
  console.error(fallback, error);
  return res.status(500).json({ message: fallback });
};

// POST /api/v1/group/:id/expenses
export const addGroupExpense = async (req, res) => {
  try {
    const group = await loadMemberGroup(req, res);
    if (!group) return;
    const me = findMyMember(group, req.userId);
    const input = parseExpenseInput(req.body, group);
    const clientId = typeof req.body.clientId === 'string' ? req.body.clientId : undefined;

    const respondExisting = async (existing) => res.status(200).json({
      expense: serializeGroupExpense(existing, me),
      group: await serializeGroupWithBalances(group, req.userId),
    });

    if (clientId) {
      const existing = await GroupExpense.findOne({ createdBy: req.userId, clientId });
      if (existing) return respondExisting(existing);
    }

    const iPaid = sameId(input.paidBy[0].memberId, me._id);
    const linkPersonal = req.body.addToPersonal === true && iPaid;

    let expense;
    try {
      expense = await withTransaction(async (session) => {
        const created = new GroupExpense({
          ...input,
          groupId: group._id,
          createdBy: req.userId,
          createdByMemberId: me._id,
          clientId,
        });
        if (linkPersonal) {
          const personal = await createLinkedPersonalExpense({
            userId: req.userId,
            details: personalDetails(input.details, group.name),
            amount: input.amount,
            ownShare: shareOf(input, me._id),
            category: input.category,
            date: input.date,
            sourceId: req.body.sourceId,
            groupId: group._id,
            groupExpenseId: created._id,
            session,
          });
          created.personalExpenseId = personal._id;
          await recalculateAfterBalances(req.userId, session);
        }
        await created.save({ session });
        await Group.updateOne({ _id: group._id }, { $set: { lastActivityAt: new Date(), lastActivityBy: findMyMember(group, req.userId)?._id ?? null } }, { session });
        return created;
      });
    } catch (error) {
      // An offline retry raced the first request
      if (error?.code === 11000 && clientId) {
        const existing = await GroupExpense.findOne({ createdBy: req.userId, clientId });
        if (existing) return respondExisting(existing);
      }
      throw error;
    }

    if (linkPersonal) invalidateStatsCache(req.userId);
    void notifyExpense(group, expense, me, 'added');
    return res.status(201).json({
      expense: serializeGroupExpense(expense, me),
      group: await serializeGroupWithBalances(group, req.userId),
    });
  } catch (error) {
    return handleError(res, error, 'Failed to add expense');
  }
};

const loadOwnExpense = async (req, res, group) => {
  const { expenseId } = req.params;
  const expense = mongoose.isValidObjectId(expenseId)
    ? await GroupExpense.findOne({ _id: expenseId, groupId: group._id, deletedAt: null })
    : null;
  if (!expense) {
    res.status(404).json({ message: 'Expense not found' });
    return null;
  }
  if (!sameId(expense.createdBy, req.userId)) {
    res.status(403).json({ message: 'Only the person who added this expense can change it' });
    return null;
  }
  return expense;
};

// PATCH /api/v1/group/:id/expenses/:expenseId  (creator only; send the full form)
export const updateGroupExpense = async (req, res) => {
  try {
    const group = await loadMemberGroup(req, res);
    if (!group) return;
    const me = findMyMember(group, req.userId);
    const expense = await loadOwnExpense(req, res, group);
    if (!expense) return;

    // People taken off the expense should hear about it too
    const involvedBefore = [...expense.paidBy, ...expense.splits].map((p) => p.memberId);
    const input = parseExpenseInput(req.body, group, expense);
    const changes = describeChanges(expense, input);
    const iPaid = sameId(input.paidBy[0].memberId, me._id);
    const wantsPersonal = typeof req.body.addToPersonal === 'boolean'
      ? req.body.addToPersonal
      : !!expense.personalExpenseId;
    const linkPersonal = wantsPersonal && iPaid;
    const touchesPersonal = linkPersonal || !!expense.personalExpenseId;

    await withTransaction(async (session) => {
      Object.assign(expense, input);
      if (changes.length) {
        expense.edits = [...expense.edits, { at: new Date(), byMemberId: me._id, changes }].slice(-MAX_EDITS_KEPT);
      }
      const personalFields = {
        details: personalDetails(input.details, group.name),
        amount: input.amount,
        ownShare: shareOf(input, me._id),
        category: input.category,
        date: input.date,
        sourceId: req.body.sourceId,
      };

      if (expense.personalExpenseId && linkPersonal) {
        const updated = await updateLinkedPersonalExpense(expense.personalExpenseId, req.userId, personalFields, session);
        if (!updated) expense.personalExpenseId = null; // they deleted it themselves; respect that
      } else if (expense.personalExpenseId) {
        await deleteLinkedPersonalExpense(expense.personalExpenseId, req.userId, session);
        expense.personalExpenseId = null;
      } else if (linkPersonal && req.body.addToPersonal === true) {
        const personal = await createLinkedPersonalExpense({
          ...personalFields,
          userId: req.userId,
          groupId: group._id,
          groupExpenseId: expense._id,
          session,
        });
        expense.personalExpenseId = personal._id;
      }

      if (touchesPersonal) await recalculateAfterBalances(req.userId, session);
      await expense.save({ session });
      // Saving without changes shouldn't show up as new activity for others
      if (changes.length) await Group.updateOne({ _id: group._id }, { $set: { lastActivityAt: new Date(), lastActivityBy: findMyMember(group, req.userId)?._id ?? null } }, { session });
    });

    if (touchesPersonal) invalidateStatsCache(req.userId);
    if (changes.length) void notifyExpense(group, expense, me, 'edited', involvedBefore);
    return res.status(200).json({
      expense: serializeGroupExpense(expense, me),
      group: await serializeGroupWithBalances(group, req.userId),
    });
  } catch (error) {
    return handleError(res, error, 'Failed to update expense');
  }
};

// DELETE /api/v1/group/:id/expenses/:expenseId  (creator only)
export const deleteGroupExpense = async (req, res) => {
  try {
    const group = await loadMemberGroup(req, res);
    if (!group) return;
    const expense = await loadOwnExpense(req, res, group);
    if (!expense) return;
    const hadPersonal = !!expense.personalExpenseId;

    await withTransaction(async (session) => {
      if (hadPersonal) {
        await deleteLinkedPersonalExpense(expense.personalExpenseId, req.userId, session);
        await recalculateAfterBalances(req.userId, session);
        expense.personalExpenseId = null;
      }
      expense.deletedAt = new Date();
      await expense.save({ session });
      await Group.updateOne({ _id: group._id }, { $set: { lastActivityAt: new Date(), lastActivityBy: findMyMember(group, req.userId)?._id ?? null } }, { session });
    });

    if (hadPersonal) invalidateStatsCache(req.userId);
    void notifyExpense(group, expense, findMyMember(group, req.userId), 'deleted');
    return res.status(200).json({ group: await serializeGroupWithBalances(group, req.userId) });
  } catch (error) {
    return handleError(res, error, 'Failed to delete expense');
  }
};
