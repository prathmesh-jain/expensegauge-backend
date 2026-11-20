import mongoose from 'mongoose';
import Group from '../models/groupModel.js';
import GroupExpense from '../models/groupExpenseModel.js';
import Settlement, { PAYMENT_METHODS } from '../models/settlementModel.js';
import { findMyMember, loadLedgers, loadMemberGroup, serializeGroupWithBalances } from './groupController.js';
import { sameId } from '../utils/ids.js';
import { handleError, InputError, serializeGroupExpense, withTransaction } from './groupExpenseController.js';
import {
  createLinkedPersonalExpense,
  deleteLinkedPersonalExpense,
  SETTLEMENT_CATEGORY,
} from '../utils/personalLedger.js';
import { recalculateAfterBalances } from '../utils/expenseBalance.js';
import { invalidateStatsCache } from '../utils/statsCache.js';
import { notifySettlement } from '../utils/groupNotifications.js';
import {
  computeNetBalances, fromPaise, MAX_ROUND_OFF_PAISE, pairwiseDebts, simplifyDebts, toPaise,
} from '../utils/groupMoney.js';
import { AMOUNT_TOO_LARGE_MESSAGE, isAmountTooLarge } from '../utils/expenseLimits.js';

const MAX_NOTE_LENGTH = 100;
const PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

const toTransfer = (t) => ({ from: t.from, to: t.to, amount: fromPaise(t.paise) });

// Current balances and the payments that would settle them
const buildSettlePlan = (group, ledger) => {
  const memberOrder = group.members.map((m) => String(m._id));
  const rank = new Map(memberOrder.map((id, index) => [id, index]));
  const byOrder = (a, b) => (rank.get(a.from) - rank.get(b.from)) || (rank.get(a.to) - rank.get(b.to));

  const nets = computeNetBalances(ledger.expenses, ledger.settlements);
  const before = pairwiseDebts(ledger.expenses, ledger.settlements).sort(byOrder);
  const smart = simplifyDebts(nets, memberOrder);
  return {
    nets,
    before,
    after: group.simplifyDebts ? smart : before,
  };
};

const serializePlan = (group, plan) => ({
  simplifyDebts: group.simplifyDebts,
  transfers: plan.after.map(toTransfer),
  before: plan.before.map(toTransfer),
  nets: group.members
    .filter((m) => (plan.nets.get(String(m._id)) || 0) !== 0)
    .map((m) => ({ memberId: m._id, net: fromPaise(plan.nets.get(String(m._id))) })),
});

const serializeSettlement = (settlement, me) => {
  const isMine = sameId(settlement.createdByMemberId, me?._id);
  return {
    kind: 'settlement',
    _id: settlement._id,
    clientId: settlement.clientId ?? null,
    fromMemberId: settlement.fromMemberId,
    toMemberId: settlement.toMemberId,
    amount: settlement.amount,
    settledAmount: settlement.settledAmount,
    // Positive: the payer rounded up. Negative: the receiver rounded down.
    roundOff: fromPaise(toPaise(settlement.amount) - toPaise(settlement.settledAmount)),
    method: settlement.method,
    note: settlement.note ?? null,
    date: settlement.date,
    source: settlement.source,
    route: settlement.route
      ? {
        before: settlement.route.before.map((t) => ({ from: t.from, to: t.to, amount: t.amount })),
        after: settlement.route.after.map((t) => ({ from: t.from, to: t.to, amount: t.amount })),
        nets: settlement.route.nets.map((n) => ({ memberId: n.memberId, net: n.net })),
        computedAt: settlement.route.computedAt,
      }
      : null,
    createdByMemberId: settlement.createdByMemberId,
    createdAt: settlement.createdAt,
    canDelete: isMine,
    addedToPersonal: isMine && !!settlement.personalExpenseId,
  };
};

const loadPlan = async (group) => buildSettlePlan(group, (await loadLedgers([group._id])).get(String(group._id)));

// GET /api/v1/group/:id/settle-plan
export const getSettlePlan = async (req, res) => {
  try {
    const group = await loadMemberGroup(req, res);
    if (!group) return;
    return res.status(200).json({ plan: serializePlan(group, await loadPlan(group)) });
  } catch (error) {
    return handleError(res, error, 'Failed to work out settlements');
  }
};

const parseSettlementInput = (body, group, nets, me) => {
  const memberById = new Map(group.members.map((m) => [String(m._id), m]));
  // People who left can still be paid or pay if they have a balance (e.g. deleted accounts)
  const usable = (id) => {
    if (typeof id !== 'string' || !mongoose.isValidObjectId(id)) return null;
    const member = memberById.get(id);
    if (!member) return null;
    if (member.status === 'left' && !(nets.get(id) || 0)) return null;
    return member;
  };
  const from = usable(body.fromMemberId);
  const to = usable(body.toMemberId);
  if (!from || !to) throw new InputError('Choose who paid and who received from the group');
  if (sameId(from._id, to._id)) throw new InputError('Payer and receiver must be different people');
  // A payment between two other people is theirs to record
  if (!sameId(from._id, me._id) && !sameId(to._id, me._id)) {
    throw new InputError('You can only record payments you made or received');
  }

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new InputError('Amount must be a valid positive number');
  if (isAmountTooLarge(amount)) throw new InputError(AMOUNT_TOO_LARGE_MESSAGE);
  const amountPaise = toPaise(amount);
  if (amountPaise < 1) throw new InputError('Amount must be at least 0.01');

  const settledPaise = body.settledAmount === undefined || body.settledAmount === null
    ? amountPaise
    : toPaise(Number(body.settledAmount));
  if (!Number.isFinite(settledPaise) || settledPaise < 1) throw new InputError('Invalid settled amount');

  const roundOff = amountPaise - settledPaise;
  if (roundOff !== 0) {
    if (Math.abs(roundOff) > MAX_ROUND_OFF_PAISE) {
      throw new InputError(`Rounding can only be less than ${group.currencySymbol}1`);
    }
    if (roundOff > 0 && !sameId(from._id, me._id)) throw new InputError('Only the person paying can round up');
    if (roundOff < 0 && !sameId(to._id, me._id)) throw new InputError('Only the person receiving can round down');
    // Rounding closes a debt; it can't clear more than is actually owed
    const fromOwes = -(nets.get(String(from._id)) || 0);
    const toIsOwed = nets.get(String(to._id)) || 0;
    if (settledPaise > fromOwes || settledPaise > toIsOwed) {
      throw new InputError('Rounding only works when the payment settles what is owed');
    }
  }

  const method = PAYMENT_METHODS.includes(body.method) ? body.method : 'cash';
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, MAX_NOTE_LENGTH) : undefined;
  const date = body.date ? new Date(body.date) : new Date();
  if (Number.isNaN(date.getTime())) throw new InputError('Invalid date');

  return {
    from,
    to,
    amount: fromPaise(amountPaise),
    settledAmount: fromPaise(settledPaise),
    method,
    note,
    date,
  };
};

// POST /api/v1/group/:id/settlements
export const addSettlement = async (req, res) => {
  try {
    const group = await loadMemberGroup(req, res);
    if (!group) return;
    const me = findMyMember(group, req.userId);
    const clientId = typeof req.body.clientId === 'string' ? req.body.clientId : undefined;

    const respond = async (status, settlement) => res.status(status).json({
      settlement: serializeSettlement(settlement, me),
      group: await serializeGroupWithBalances(group, req.userId),
    });

    if (clientId) {
      const existing = await Settlement.findOne({ createdBy: req.userId, clientId });
      if (existing) return respond(200, existing);
    }

    const plan = await loadPlan(group);
    const input = parseSettlementInput(req.body, group, plan.nets, me);

    // Smart only when it's one of the suggested payments right now
    const fromId = String(input.from._id);
    const toId = String(input.to._id);
    const isSmart = req.body.source === 'smart'
      && group.simplifyDebts
      && plan.after.some((t) => t.from === fromId && t.to === toId);

    const iPaid = sameId(input.from._id, me._id);
    const iReceived = sameId(input.to._id, me._id);
    const linkPersonal = req.body.addToPersonal === true && (iPaid || iReceived);

    let settlement;
    try {
      settlement = await withTransaction(async (session) => {
        const created = new Settlement({
          groupId: group._id,
          createdBy: req.userId,
          createdByMemberId: me._id,
          clientId,
          fromMemberId: input.from._id,
          toMemberId: input.to._id,
          amount: input.amount,
          settledAmount: input.settledAmount,
          method: input.method,
          note: input.note,
          date: input.date,
          source: isSmart ? 'smart' : 'manual',
          route: isSmart
            ? {
              before: plan.before.map(toTransfer),
              after: plan.after.map(toTransfer),
              nets: [...plan.nets].filter(([, paise]) => paise !== 0).map(([memberId, paise]) => ({ memberId, net: fromPaise(paise) })),
              computedAt: new Date(),
            }
            : undefined,
        });

        if (linkPersonal) {
          const personal = await createLinkedPersonalExpense({
            userId: req.userId,
            type: iPaid ? 'debit' : 'credit',
            details: iPaid
              ? `Paid ${input.to.name} · ${group.name}`
              : `Received from ${input.from.name} · ${group.name}`,
            amount: input.amount,
            category: SETTLEMENT_CATEGORY,
            date: input.date,
            sourceId: req.body.sourceId,
            groupId: group._id,
            settlementId: created._id,
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
      if (error?.code === 11000 && clientId) {
        const existing = await Settlement.findOne({ createdBy: req.userId, clientId });
        if (existing) return respond(200, existing);
      }
      throw error;
    }

    if (linkPersonal) invalidateStatsCache(req.userId);
    void notifySettlement(group, settlement, me, 'recorded');
    return respond(201, settlement);
  } catch (error) {
    return handleError(res, error, 'Failed to record payment');
  }
};

// DELETE /api/v1/group/:id/settlements/:settlementId  (only whoever recorded it)
export const deleteSettlement = async (req, res) => {
  try {
    const group = await loadMemberGroup(req, res);
    if (!group) return;
    const { settlementId } = req.params;
    const settlement = mongoose.isValidObjectId(settlementId)
      ? await Settlement.findOne({ _id: settlementId, groupId: group._id, deletedAt: null })
      : null;
    if (!settlement) return res.status(404).json({ message: 'Payment not found' });
    if (!sameId(settlement.createdBy, req.userId)) {
      return res.status(403).json({ message: 'Only the person who recorded this payment can delete it' });
    }
    const hadPersonal = !!settlement.personalExpenseId;

    await withTransaction(async (session) => {
      if (hadPersonal) {
        await deleteLinkedPersonalExpense(settlement.personalExpenseId, req.userId, session);
        await recalculateAfterBalances(req.userId, session);
        settlement.personalExpenseId = null;
      }
      settlement.deletedAt = new Date();
      await settlement.save({ session });
      await Group.updateOne({ _id: group._id }, { $set: { lastActivityAt: new Date(), lastActivityBy: findMyMember(group, req.userId)?._id ?? null } }, { session });
    });

    if (hadPersonal) invalidateStatsCache(req.userId);
    void notifySettlement(group, settlement, findMyMember(group, req.userId), 'deleted');
    return res.status(200).json({ group: await serializeGroupWithBalances(group, req.userId) });
  } catch (error) {
    return handleError(res, error, 'Failed to delete payment');
  }
};

// GET /api/v1/group/:id/summary — totals for the Summary screen, worked out over
// everything in the group (the app only holds the pages it has loaded)
export const getGroupSummary = async (req, res) => {
  try {
    const group = await loadMemberGroup(req, res);
    if (!group) return;
    const ledger = (await loadLedgers([group._id])).get(String(group._id));
    const plan = buildSettlePlan(group, ledger);

    // Per member, in paise: paid for expenses, their share, settle-up cash sent and received
    const totals = new Map();
    const bump = (memberId, field, paise) => {
      const key = String(memberId);
      if (!totals.has(key)) totals.set(key, { paid: 0, share: 0, sent: 0, received: 0 });
      totals.get(key)[field] += paise;
    };
    let totalSpentPaise = 0;
    for (const expense of ledger.expenses) {
      totalSpentPaise += toPaise(expense.amount);
      for (const p of expense.paidBy) bump(p.memberId, 'paid', toPaise(p.amount));
      for (const s of expense.splits) bump(s.memberId, 'share', toPaise(s.amount));
    }
    for (const s of ledger.settlements) {
      bump(s.fromMemberId, 'sent', toPaise(s.amount));
      bump(s.toMemberId, 'received', toPaise(s.amount));
    }

    // Everyone still in the group, plus anyone who left but has figures
    const members = group.members
      .filter((m) => m.status !== 'left' || totals.has(String(m._id)) || plan.nets.get(String(m._id)))
      .map((m) => {
        const t = totals.get(String(m._id)) || { paid: 0, share: 0, sent: 0, received: 0 };
        return {
          memberId: m._id,
          paid: fromPaise(t.paid),
          share: fromPaise(t.share),
          sent: fromPaise(t.sent),
          received: fromPaise(t.received),
          net: fromPaise(plan.nets.get(String(m._id)) || 0),
        };
      });

    return res.status(200).json({
      summary: {
        totalSpent: fromPaise(totalSpentPaise),
        expenseCount: ledger.expenses.length,
        paymentCount: ledger.settlements.length,
        members,
        // What each person still owes whom after payments
        debts: plan.before.map(toTransfer),
        simplifyDebts: group.simplifyDebts,
        // The shorter plan, only when smart settle is on
        smartPlan: group.simplifyDebts ? plan.after.map(toTransfer) : null,
      },
    });
  } catch (error) {
    return handleError(res, error, 'Failed to load summary');
  }
};

// GET /api/v1/group/:id/activity?offset=&limit=  — expenses and payments, newest first
export const getActivity = async (req, res) => {
  try {
    const group = await loadMemberGroup(req, res);
    if (!group) return;
    const me = findMyMember(group, req.userId);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const take = offset + limit + 1;
    const sort = { date: -1, createdAt: -1, _id: -1 };
    const filter = { groupId: group._id, deletedAt: null };

    // Optional filters: ?kind=expense|settlement and ?memberId= (things that person is part of)
    const kind = ['expense', 'settlement'].includes(req.query.kind) ? req.query.kind : null;
    const memberId = typeof req.query.memberId === 'string' && mongoose.isValidObjectId(req.query.memberId)
      ? req.query.memberId
      : null;
    if (req.query.memberId && !memberId) return res.status(400).json({ message: 'Invalid member' });
    const expenseFilter = memberId
      ? { ...filter, $or: [{ 'paidBy.memberId': memberId }, { 'splits.memberId': memberId }] }
      : filter;
    const settlementFilter = memberId
      ? { ...filter, $or: [{ fromMemberId: memberId }, { toMemberId: memberId }] }
      : filter;

    const [expenses, settlements] = await Promise.all([
      kind === 'settlement' ? [] : GroupExpense.find(expenseFilter).sort(sort).limit(take),
      kind === 'expense' ? [] : Settlement.find(settlementFilter).sort(sort).limit(take),
    ]);
    const merged = [
      ...expenses.map((e) => ({ item: { kind: 'expense', ...serializeGroupExpense(e, me) }, date: e.date, createdAt: e.createdAt })),
      ...settlements.map((s) => ({ item: serializeSettlement(s, me), date: s.date, createdAt: s.createdAt })),
    ].sort((a, b) => (b.date - a.date) || (b.createdAt - a.createdAt));

    return res.status(200).json({
      items: merged.slice(offset, offset + limit).map((m) => m.item),
      hasMore: merged.length > offset + limit,
    });
  } catch (error) {
    return handleError(res, error, 'Failed to load activity');
  }
};
