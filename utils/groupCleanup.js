import Group from '../models/groupModel.js';
import GroupExpense from '../models/groupExpenseModel.js';
import Settlement from '../models/settlementModel.js';
import { encrypt } from './encryption.js';
import { DELETED_USER_NAME } from './groupLimits.js';

/**
 * Deletes groups along with their expenses and payments. Personal expenses
 * that were linked to them stay: they record real money that moved.
 */
export const deleteGroupsWithData = async (groupIds) => {
  if (!groupIds.length) return;
  await GroupExpense.deleteMany({ groupId: { $in: groupIds } });
  await Settlement.deleteMany({ groupId: { $in: groupIds } });
  await Group.deleteMany({ _id: { $in: groupIds } });
};

/**
 * Called when an account is deleted. The person's slot in every group becomes
 * "Deleted user" so the rest of the group keeps its history, and groups with
 * nobody active left are removed.
 */
export const anonymizeUserInGroups = async (userId) => {
  const groupIds = (await Group.find({ 'members.userId': userId }).select('_id')).map((g) => g._id);
  if (groupIds.length === 0) return;

  await Group.updateMany(
    { _id: { $in: groupIds } },
    {
      $set: {
        'members.$[m].userId': null,
        'members.$[m].name': encrypt(DELETED_USER_NAME),
        'members.$[m].status': 'left',
      },
    },
    { arrayFilters: [{ 'm.userId': userId }] }
  );

  const emptyIds = (await Group.find({
    _id: { $in: groupIds },
    members: { $not: { $elemMatch: { status: 'active' } } },
  }).select('_id')).map((g) => g._id);
  await deleteGroupsWithData(emptyIds);
};
