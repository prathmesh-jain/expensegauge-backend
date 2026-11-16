import crypto from 'crypto';
import mongoose from 'mongoose';
import Group from '../models/groupModel.js';
import GroupExpense from '../models/groupExpenseModel.js';
import Settlement from '../models/settlementModel.js';
import User from '../models/userModel.js';
import { encrypt } from '../utils/encryption.js';
import { sameId } from '../utils/ids.js';
import { computeNetBalances, fromPaise } from '../utils/groupMoney.js';
import {
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  MAX_CURRENCY_SYMBOL_LENGTH,
  MAX_GROUP_MEMBERS,
  MAX_GROUP_NAME_LENGTH,
  MAX_MEMBER_NAME_LENGTH,
  EMAIL_LOOKUPS_PER_HOUR,
  maskEmail,
  normalizeEmail,
  normalizeInviteCode,
} from '../utils/groupLimits.js';
import { createRateLimiter } from '../utils/rateLimit.js';
import { deleteGroupsWithData } from '../utils/groupCleanup.js';
import { notifyMemberJoined } from '../utils/groupNotifications.js';

// Shared by lookups and adds by email, since both reveal whether an email has an account
const emailLookupLimiter = createRateLimiter({ limit: EMAIL_LOOKUPS_PER_HOUR, windowMs: 60 * 60 * 1000 });

class LookupError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Exact, rate-limited lookup of a registered user by email. Throws LookupError. */
const findUserByEmail = async (userId, rawEmail) => {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new LookupError(400, 'Enter a valid email address');
  if (!emailLookupLimiter.take(String(userId))) {
    throw new LookupError(429, 'Too many email lookups. Try again in a while, or share the invite link instead.');
  }
  const user = await User.findOne({ email }).select('name email');
  if (!user) {
    throw new LookupError(404, 'No ExpenseGauge account uses this email. Add them by name and share the invite link.', 'NOT_REGISTERED');
  }
  return user;
};

const sendLookupError = (res, error) =>
  res.status(error.status).json({ message: error.message, ...(error.code ? { code: error.code } : {}) });

// ---------- helpers ----------

const generateInviteCode = () => {
  const bytes = crypto.randomBytes(INVITE_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    code += INVITE_CODE_ALPHABET[bytes[i] % INVITE_CODE_ALPHABET.length];
  }
  return code;
};

const generateUniqueInviteCode = async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode();
    if (!(await Group.exists({ inviteCode: code }))) return code;
  }
  throw new Error('Could not generate a unique invite code');
};


const cleanName = (value) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '');

const validateGroupName = (name) => {
  if (!name) return 'Group name is required';
  if (name.length > MAX_GROUP_NAME_LENGTH) return `Group name cannot be longer than ${MAX_GROUP_NAME_LENGTH} characters`;
  return null;
};

const validateMemberName = (name) => {
  if (!name) return 'Member name is required';
  if (name.length > MAX_MEMBER_NAME_LENGTH) return `Member name cannot be longer than ${MAX_MEMBER_NAME_LENGTH} characters`;
  return null;
};

const cleanCurrencySymbol = (value) => {
  if (typeof value !== 'string') return null;
  const symbol = value.trim();
  return symbol && symbol.length <= MAX_CURRENCY_SYMBOL_LENGTH ? symbol : null;
};

export const findMyMember = (group, userId) =>
  group.members.find((m) => sameId(m.userId, userId) && m.status === 'active');

const groupBy = (items) => {
  const byGroup = new Map();
  for (const item of items) {
    const key = String(item.groupId);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(item);
  }
  return byGroup;
};

// Everything that affects balances, for each group id (deleted entries excluded)
export const loadLedgers = async (groupIds, session = null) => {
  const [expenses, settlements] = await Promise.all([
    GroupExpense.find({ groupId: { $in: groupIds }, deletedAt: null })
      .select('groupId amount paidBy splits deletedAt')
      .session(session)
      .lean(),
    Settlement.find({ groupId: { $in: groupIds }, deletedAt: null })
      .select('groupId fromMemberId toMemberId amount settledAmount deletedAt')
      .session(session)
      .lean(),
  ]);
  const expensesByGroup = groupBy(expenses);
  const settlementsByGroup = groupBy(settlements);
  const result = new Map();
  for (const id of groupIds) {
    result.set(String(id), {
      expenses: expensesByGroup.get(String(id)) || [],
      settlements: settlementsByGroup.get(String(id)) || [],
    });
  }
  return result;
};

// Net balance per member (paise) for each group id
const loadNetsByGroup = async (groupIds) => {
  const ledgers = await loadLedgers(groupIds);
  const result = new Map();
  for (const [id, ledger] of ledgers) result.set(id, computeNetBalances(ledger.expenses, ledger.settlements));
  return result;
};

const loadGroupNets = async (groupId) => (await loadNetsByGroup([groupId])).get(String(groupId));

// Group plus balances, as every group endpoint returns it
export const serializeGroupWithBalances = async (group, userId) => {
  // Expense and payment handlers update activity in the database, not on this copy
  const [nets, latest] = await Promise.all([
    loadGroupNets(group._id),
    Group.findById(group._id).select('lastActivityAt lastActivityBy').lean(),
  ]);
  if (latest) {
    group.lastActivityAt = latest.lastActivityAt;
    group.lastActivityBy = latest.lastActivityBy;
  }
  return serializeGroup(group, userId, nets);
};

// Marks a change to the group by `memberId`
const touch = (group, memberId) => {
  group.lastActivityAt = new Date();
  group.lastActivityBy = memberId ?? null;
};

// Shape sent to the app. Never exposes other users' ids or emails.
// Amounts in `balances` are in the group's currency: positive = is owed, negative = owes.
const serializeGroup = (group, userId, nets = new Map()) => {
  const me = findMyMember(group, userId);
  const netOf = (memberId) => fromPaise(nets.get(String(memberId)) || 0);
  return {
    myNet: me ? netOf(me._id) : 0,
    balances: group.members
      .filter((m) => (nets.get(String(m._id)) || 0) !== 0)
      .map((m) => ({ memberId: m._id, net: netOf(m._id) })),
    _id: group._id,
    name: group.name,
    currencySymbol: group.currencySymbol,
    simplifyDebts: group.simplifyDebts,
    inviteCode: group.inviteCode,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    lastActivityAt: group.lastActivityAt,
    // Lets the app badge only changes made by someone else
    lastActivityByYou: !!me && sameId(group.lastActivityBy, me._id),
    isCreator: sameId(group.createdBy, userId),
    myMemberId: me?._id ?? null,
    // Your push setting for this group: true, false, or null if you haven't chosen
    myNotify: me?.notify ?? null,
    members: group.members.map((m) => ({
      _id: m._id,
      name: m.name,
      status: m.status,
      isYou: sameId(m.userId, userId),
      isRegistered: !!m.userId,
      addedByYou: sameId(m.addedBy, userId),
      joinedAt: m.joinedAt,
    })),
  };
};

// Loads a group the current user is an active member of, or sends 404
export const loadMemberGroup = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(404).json({ message: 'Group not found' });
    return null;
  }
  const group = await Group.findById(id);
  if (!group || !findMyMember(group, req.userId)) {
    res.status(404).json({ message: 'Group not found' });
    return null;
  }
  return group;
};

const currentMemberNames = (group) =>
  new Set(group.members.filter((m) => m.status !== 'left').map((m) => m.name.toLowerCase()));

// ---------- routes ----------

// POST /api/v1/group/lookup-email  { email }
// Exact match only; returns just the name and a masked email
export const lookupEmail = async (req, res) => {
  try {
    const user = await findUserByEmail(req.userId, req.body.email);
    return res.status(200).json({
      user: {
        name: user.name,
        maskedEmail: maskEmail(user.email),
        isYou: sameId(user._id, req.userId),
      },
    });
  } catch (error) {
    if (error instanceof LookupError) return sendLookupError(res, error);
    console.error('Lookup email error:', error);
    return res.status(500).json({ message: 'Failed to look up email' });
  }
};

// POST /api/v1/group
export const createGroup = async (req, res) => {
  try {
    const { clientId } = req.body;
    const name = cleanName(req.body.name);
    const nameError = validateGroupName(name);
    if (nameError) return res.status(400).json({ message: nameError });

    if (clientId) {
      const existing = await Group.findOne({ createdBy: req.userId, clientId });
      if (existing) return res.status(200).json({ group: await serializeGroupWithBalances(existing, req.userId) });
    }

    const user = await User.findById(req.userId).select('name');
    if (!user) return res.status(404).json({ message: 'User not found' });

    const rawMembers = Array.isArray(req.body.memberNames) ? req.body.memberNames : [];
    const memberNames = [];
    const seen = new Set([user.name.trim().toLowerCase()]);
    for (const raw of rawMembers) {
      const memberName = cleanName(raw);
      const memberError = validateMemberName(memberName);
      if (memberError) return res.status(400).json({ message: memberError });
      const key = memberName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      memberNames.push(memberName);
    }
    // People added by email are invited and accept from their Groups tab
    const rawEmails = Array.isArray(req.body.memberEmails) ? req.body.memberEmails : [];
    const invitedUsers = [];
    const seenUsers = new Set([String(req.userId)]);
    for (const rawEmail of rawEmails) {
      let invitee;
      try {
        invitee = await findUserByEmail(req.userId, rawEmail);
      } catch (error) {
        if (error instanceof LookupError) return sendLookupError(res, error);
        throw error;
      }
      if (seenUsers.has(String(invitee._id))) continue;
      seenUsers.add(String(invitee._id));
      invitedUsers.push(invitee);
    }

    if (memberNames.length + invitedUsers.length + 1 > MAX_GROUP_MEMBERS) {
      return res.status(400).json({ message: `A group can have at most ${MAX_GROUP_MEMBERS} members` });
    }

    const now = new Date();
    const group = new Group({
      name,
      currencySymbol: cleanCurrencySymbol(req.body.currencySymbol) ?? '₹',
      createdBy: req.userId,
      clientId: typeof clientId === 'string' ? clientId : undefined,
      inviteCode: await generateUniqueInviteCode(),
      lastActivityAt: now,
      members: [
        { userId: req.userId, name: user.name, status: 'active', addedBy: req.userId, joinedAt: now },
        ...invitedUsers.map((invitee) => ({ userId: invitee._id, name: invitee.name, status: 'invited', addedBy: req.userId })),
        ...memberNames.map((memberName) => ({ name: memberName, status: 'pending', addedBy: req.userId })),
      ],
    });
    group.lastActivityBy = group.members[0]._id;

    try {
      await group.save();
    } catch (err) {
      // A retry raced the first request: return the group that won
      if (err?.code === 11000 && clientId) {
        const existing = await Group.findOne({ createdBy: req.userId, clientId });
        if (existing) return res.status(200).json({ group: await serializeGroupWithBalances(existing, req.userId) });
      }
      throw err;
    }

    return res.status(201).json({ group: await serializeGroupWithBalances(group, req.userId) });
  } catch (error) {
    console.error('Create group error:', error);
    return res.status(500).json({ message: 'Failed to create group' });
  }
};

// GET /api/v1/group
export const listGroups = async (req, res) => {
  try {
    const groups = await Group.find({
      members: { $elemMatch: { userId: req.userId, status: 'active' } },
    }).sort({ lastActivityAt: -1 });
    const netsByGroup = await loadNetsByGroup(groups.map((g) => g._id));
    return res.status(200).json({
      groups: groups.map((g) => serializeGroup(g, req.userId, netsByGroup.get(String(g._id)))),
    });
  } catch (error) {
    console.error('List groups error:', error);
    return res.status(500).json({ message: 'Failed to fetch groups' });
  }
};

// GET /api/v1/group/:id
export const getGroup = async (req, res) => {
  try {
    const group = await loadMemberGroup(req, res);
    if (!group) return;
    return res.status(200).json({ group: await serializeGroupWithBalances(group, req.userId) });
  } catch (error) {
    console.error('Get group error:', error);
    return res.status(500).json({ message: 'Failed to fetch group' });
  }
};

// PATCH /api/v1/group/:id  { name?, currencySymbol?, simplifyDebts? }
export const updateGroup = async (req, res) => {
  try {
    const group = await loadMemberGroup(req, res);
    if (!group) return;

    if (req.body.name !== undefined) {
      const name = cleanName(req.body.name);
      const nameError = validateGroupName(name);
      if (nameError) return res.status(400).json({ message: nameError });
      group.name = name;
    }
    if (req.body.currencySymbol !== undefined) {
      const symbol = cleanCurrencySymbol(req.body.currencySymbol);
      if (!symbol) return res.status(400).json({ message: 'Invalid currency symbol' });
      group.currencySymbol = symbol;
    }
    if (req.body.simplifyDebts !== undefined) {
      if (typeof req.body.simplifyDebts !== 'boolean') {
        return res.status(400).json({ message: 'simplifyDebts must be true or false' });
      }
      group.simplifyDebts = req.body.simplifyDebts;
    }

    await group.save();
    return res.status(200).json({ group: await serializeGroupWithBalances(group, req.userId) });
  } catch (error) {
    console.error('Update group error:', error);
    return res.status(500).json({ message: 'Failed to update group' });
  }
};

// POST /api/v1/group/:id/members  { name }
export const addMember = async (req, res) => {
  try {
    const group = await loadMemberGroup(req, res);
    if (!group) return;

    if (req.body.email !== undefined) return addMemberByEmail(req, res, group);

    const name = cleanName(req.body.name);
    const nameError = validateMemberName(name);
    if (nameError) return res.status(400).json({ message: nameError });

    if (group.members.length >= MAX_GROUP_MEMBERS) {
      return res.status(400).json({ message: `A group can have at most ${MAX_GROUP_MEMBERS} members` });
    }
    if (currentMemberNames(group).has(name.toLowerCase())) {
      return res.status(400).json({ message: `${name} is already in this group` });
    }

    group.members.push({ name, status: 'pending', addedBy: req.userId });
    touch(group, findMyMember(group, req.userId)?._id);
    await group.save();
    return res.status(201).json({ group: await serializeGroupWithBalances(group, req.userId) });
  } catch (error) {
    console.error('Add member error:', error);
    return res.status(500).json({ message: 'Failed to add member' });
  }
};

// POST /api/v1/group/:id/members  { email } — invites a registered user
const addMemberByEmail = async (req, res, group) => {
  let invitee;
  try {
    invitee = await findUserByEmail(req.userId, req.body.email);
  } catch (error) {
    if (error instanceof LookupError) return sendLookupError(res, error);
    throw error;
  }
  if (sameId(invitee._id, req.userId)) {
    return res.status(400).json({ message: "That's your own email" });
  }

  const existing = group.members.find((m) => sameId(m.userId, invitee._id));
  if (existing?.status === 'active') {
    return res.status(400).json({ message: `${existing.name} is already in this group` });
  }
  if (existing?.status === 'invited') {
    return res.status(400).json({ message: `${existing.name} has already been invited` });
  }

  if (existing) {
    // They left before: invite them back into their old slot so history stays theirs
    existing.status = 'invited';
    existing.name = invitee.name;
    existing.addedBy = req.userId;
  } else {
    if (group.members.length >= MAX_GROUP_MEMBERS) {
      return res.status(400).json({ message: `A group can have at most ${MAX_GROUP_MEMBERS} members` });
    }
    group.members.push({ userId: invitee._id, name: invitee.name, status: 'invited', addedBy: req.userId });
  }
  touch(group, findMyMember(group, req.userId)?._id);
  await group.save();
  return res.status(201).json({ group: await serializeGroupWithBalances(group, req.userId) });
};

// GET /api/v1/group/invitations — groups you've been added to by email
export const listInvitations = async (req, res) => {
  try {
    const groups = await Group.find({
      members: { $elemMatch: { userId: req.userId, status: 'invited' } },
    }).sort({ lastActivityAt: -1 });
    return res.status(200).json({
      invitations: groups.map((group) => {
        const mine = group.members.find((m) => sameId(m.userId, req.userId));
        const inviter = group.members.find((m) => sameId(m.userId, mine.addedBy));
        return {
          groupId: group._id,
          groupName: group.name,
          currencySymbol: group.currencySymbol,
          invitedBy: inviter?.name ?? null,
          memberCount: group.members.filter((m) => m.status !== 'left').length,
        };
      }),
    });
  } catch (error) {
    console.error('List invitations error:', error);
    return res.status(500).json({ message: 'Failed to load invitations' });
  }
};

// POST /api/v1/group/:id/invitation  { accept: boolean }
export const respondToInvitation = async (req, res) => {
  try {
    if (typeof req.body.accept !== 'boolean') {
      return res.status(400).json({ message: 'accept must be true or false' });
    }
    const { id } = req.params;
    const group = mongoose.isValidObjectId(id) ? await Group.findById(id) : null;
    const mine = group?.members.find((m) => sameId(m.userId, req.userId) && m.status === 'invited');
    if (!group || !mine) return res.status(404).json({ message: 'Invitation not found' });

    if (req.body.accept) {
      const user = await User.findById(req.userId).select('name');
      mine.status = 'active';
      mine.joinedAt = new Date();
      if (user) mine.name = user.name;
    } else {
      // Their spot stays as a plain placeholder: expenses that include it keep working,
      // and they can still join later with an invite link and claim it
      mine.userId = null;
      mine.notify = null;
      mine.status = 'pending';
    }
    touch(group, mine._id);
    await group.save();

    if (!req.body.accept) return res.status(200).json({ declined: true });
    void notifyMemberJoined(group, mine);
    return res.status(200).json({ group: await serializeGroupWithBalances(group, req.userId) });
  } catch (error) {
    console.error('Respond to invitation error:', error);
    return res.status(500).json({ message: 'Failed to respond to invitation' });
  }
};

// DELETE /api/v1/group/:id/members/:memberId
// Only people who haven't joined (placeholders and pending invitations) can be
// removed, by the group creator or by whoever added them.
export const removeMember = async (req, res) => {
  try {
    const group = await loadMemberGroup(req, res);
    if (!group) return;

    const member = group.members.id(req.params.memberId);
    if (!member || !['pending', 'invited'].includes(member.status)) {
      return res.status(404).json({ message: 'Member not found' });
    }
    if (!sameId(group.createdBy, req.userId) && !sameId(member.addedBy, req.userId)) {
      return res.status(403).json({ message: 'Only the group creator or the person who added them can remove this member' });
    }
    // Their expenses or payments would lose a person
    const [inExpense, inSettlement] = await Promise.all([
      GroupExpense.exists({
        groupId: group._id,
        deletedAt: null,
        $or: [{ 'paidBy.memberId': member._id }, { 'splits.memberId': member._id }],
      }),
      Settlement.exists({
        groupId: group._id,
        deletedAt: null,
        $or: [{ fromMemberId: member._id }, { toMemberId: member._id }],
      }),
    ]);
    if (inExpense || inSettlement) {
      return res.status(400).json({
        message: `${member.name} is part of expenses or payments in this group. Delete those first.`,
      });
    }

    member.deleteOne();
    await group.save();
    return res.status(200).json({ group: await serializeGroupWithBalances(group, req.userId) });
  } catch (error) {
    console.error('Remove member error:', error);
    return res.status(500).json({ message: 'Failed to remove member' });
  }
};

// PATCH /api/v1/group/:id/notifications  { notify: boolean } — your own push setting for this group
export const setGroupNotifications = async (req, res) => {
  try {
    if (typeof req.body.notify !== 'boolean') {
      return res.status(400).json({ message: 'notify must be true or false' });
    }
    const group = await loadMemberGroup(req, res);
    if (!group) return;
    findMyMember(group, req.userId).notify = req.body.notify;
    await group.save();
    return res.status(200).json({ group: await serializeGroupWithBalances(group, req.userId) });
  } catch (error) {
    console.error('Group notification setting error:', error);
    return res.status(500).json({ message: 'Failed to save notification setting' });
  }
};

// POST /api/v1/group/:id/invite/rotate  (creator only)
export const rotateInviteCode = async (req, res) => {
  try {
    const group = await loadMemberGroup(req, res);
    if (!group) return;
    if (!sameId(group.createdBy, req.userId)) {
      return res.status(403).json({ message: 'Only the group creator can reset the invite link' });
    }
    group.inviteCode = await generateUniqueInviteCode();
    await group.save();
    return res.status(200).json({ group: await serializeGroupWithBalances(group, req.userId) });
  } catch (error) {
    console.error('Rotate invite error:', error);
    return res.status(500).json({ message: 'Failed to reset invite link' });
  }
};

// GET /api/v1/group/invite/:code  (signed in) — what the join screen shows
export const previewInvite = async (req, res) => {
  try {
    const code = normalizeInviteCode(req.params.code);
    const group = code ? await Group.findOne({ inviteCode: code }) : null;
    if (!group) return res.status(404).json({ message: 'This invite link is not valid anymore' });

    const me = group.members.find((m) => sameId(m.userId, req.userId));
    const creator = group.members.find((m) => sameId(m.userId, group.createdBy));
    return res.status(200).json({
      invite: {
        groupId: group._id,
        groupName: group.name,
        currencySymbol: group.currencySymbol,
        invitedBy: creator?.status === 'active' ? creator.name : null,
        alreadyMember: me?.status === 'active',
        members: group.members
          .filter((m) => m.status === 'active')
          .map((m) => ({ _id: m._id, name: m.name })),
        // Placeholders the joining person can say are them
        claimable: group.members
          .filter((m) => m.status === 'pending' && !m.userId)
          .map((m) => ({ _id: m._id, name: m.name })),
      },
    });
  } catch (error) {
    console.error('Preview invite error:', error);
    return res.status(500).json({ message: 'Failed to load invite' });
  }
};

// POST /api/v1/group/join  { code, claimMemberId? }
export const joinGroup = async (req, res) => {
  try {
    const code = normalizeInviteCode(req.body.code);
    const group = code ? await Group.findOne({ inviteCode: code }) : null;
    if (!group) return res.status(404).json({ message: 'This invite link is not valid anymore' });

    const existing = group.members.find((m) => sameId(m.userId, req.userId));
    if (existing?.status === 'active') {
      return res.status(200).json({ group: await serializeGroupWithBalances(group, req.userId) });
    }

    const user = await User.findById(req.userId).select('name');
    if (!user) return res.status(404).json({ message: 'User not found' });

    const now = new Date();
    const encryptedName = encrypt(user.name);
    let updated = null;

    if (existing) {
      // Rejoining after leaving: reuse the old slot so their history stays theirs
      updated = await Group.findOneAndUpdate(
        { _id: group._id, members: { $elemMatch: { _id: existing._id, userId: req.userId } } },
        { $set: { 'members.$.status': 'active', 'members.$.name': encryptedName, 'members.$.joinedAt': now, lastActivityAt: now, lastActivityBy: existing._id } },
        { new: true }
      );
    } else if (req.body.claimMemberId) {
      if (!mongoose.isValidObjectId(req.body.claimMemberId)) {
        return res.status(400).json({ message: 'That member cannot be claimed' });
      }
      // Atomic: only succeeds while the slot is still unclaimed and the user isn't in the group
      updated = await Group.findOneAndUpdate(
        {
          _id: group._id,
          'members.userId': { $ne: req.userId },
          members: { $elemMatch: { _id: req.body.claimMemberId, userId: null, status: 'pending' } },
        },
        { $set: { 'members.$.userId': req.userId, 'members.$.status': 'active', 'members.$.name': encryptedName, 'members.$.joinedAt': now, lastActivityAt: now, lastActivityBy: req.body.claimMemberId } },
        { new: true }
      );
      if (!updated) {
        return res.status(409).json({ message: 'Someone already joined as that member. Pick another or join as new.' });
      }
    } else {
      if (group.members.length >= MAX_GROUP_MEMBERS) {
        return res.status(400).json({ message: `This group already has ${MAX_GROUP_MEMBERS} members` });
      }
      const newMemberId = new mongoose.Types.ObjectId();
      updated = await Group.findOneAndUpdate(
        { _id: group._id, 'members.userId': { $ne: req.userId } },
        {
          $push: { members: { _id: newMemberId, userId: req.userId, name: encryptedName, status: 'active', addedBy: req.userId, joinedAt: now } },
          $set: { lastActivityAt: now, lastActivityBy: newMemberId },
        },
        { new: true }
      );
    }

    // A parallel request may have added them first
    if (!updated) updated = await Group.findById(group._id);
    if (!updated || !findMyMember(updated, req.userId)) {
      return res.status(409).json({ message: 'Could not join the group. Please try again.' });
    }
    void notifyMemberJoined(updated, findMyMember(updated, req.userId));
    return res.status(200).json({ group: await serializeGroupWithBalances(updated, req.userId) });
  } catch (error) {
    console.error('Join group error:', error);
    return res.status(500).json({ message: 'Failed to join group' });
  }
};

// POST /api/v1/group/:id/leave
export const leaveGroup = async (req, res) => {
  try {
    const group = await loadMemberGroup(req, res);
    if (!group) return;
    const me = findMyMember(group, req.userId);
    const myNetPaise = (await loadGroupNets(group._id)).get(String(me._id)) || 0;
    if (myNetPaise !== 0) {
      const amount = `${group.currencySymbol}${fromPaise(Math.abs(myNetPaise)).toFixed(2)}`;
      return res.status(400).json({
        message: myNetPaise < 0
          ? `You still owe ${amount} in this group. Settle up before leaving.`
          : `You're still owed ${amount} in this group. Settle up before leaving.`,
      });
    }

    me.status = 'left';
    touch(group, me._id);

    if (!group.members.some((m) => m.status === 'active')) {
      await deleteGroupsWithData([group._id]);
      return res.status(200).json({ message: 'You left the group', deleted: true });
    }
    await group.save();
    return res.status(200).json({ message: 'You left the group', deleted: false });
  } catch (error) {
    console.error('Leave group error:', error);
    return res.status(500).json({ message: 'Failed to leave group' });
  }
};
