import { sendPushToUsers } from './pushService.js';
import { toPaise } from './groupMoney.js';
import { sameId } from './ids.js';

// What group pushes say and who gets them. Callers fire these after the
// change is saved and don't wait for them. Nobody is notified about a group
// unless they turned it on for that group (member.notify), and the account-wide
// switch in Preferences can still mute everything (checked in sendPushToUsers).

const GROUP_ACTIVITY = 'group_activity';

const money = (amount, symbol) => {
  const paise = toPaise(amount);
  const value = paise / 100;
  return `${symbol}${value.toLocaleString('en-IN', paise % 100 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : undefined)}`;
};

const shorten = (text, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const firstName = (name) => (name || 'Someone').trim().split(/\s+/)[0];

// Members among `memberIds` who joined, turned notifications on for this group,
// and didn't make the change themselves
const recipients = (group, memberIds, actorMemberId) => {
  const wanted = new Set(memberIds.map(String));
  return group.members.filter((m) =>
    wanted.has(String(m._id))
    && m.status === 'active'
    && m.userId
    && m.notify === true
    && !sameId(m._id, actorMemberId));
};

const memberNameOf = (group, memberId) => group.members.find((m) => sameId(m._id, memberId))?.name ?? 'Someone';

const activityData = (group, extra) => ({ type: GROUP_ACTIVITY, groupId: String(group._id), ...extra });

/**
 * kind: 'added' | 'edited' | 'deleted'. Only people on the expense are told;
 * for edits, `alsoNotify` adds people who were on it before the change.
 */
export const notifyExpense = (group, expense, actor, kind, alsoNotify = []) => {
  const involved = [...expense.paidBy, ...expense.splits].map((p) => p.memberId).concat(alsoNotify);
  const who = firstName(actor.name);
  const what = `"${shorten(expense.details)}"`;
  const total = money(expense.amount, group.currencySymbol);

  return sendPushToUsers(recipients(group, involved, actor._id).map((member) => {
    let body;
    if (kind === 'added') {
      const share = expense.splits.find((s) => sameId(s.memberId, member._id))?.amount ?? 0;
      const paidByThem = expense.paidBy.some((p) => sameId(p.memberId, member._id));
      body = `${who} added ${what} · ${total}`;
      if (paidByThem) body += ` · paid by you`;
      else if (share > 0) body += ` · your share ${money(share, group.currencySymbol)}`;
    } else if (kind === 'edited') {
      body = `${who} edited ${what} · now ${total}`;
    } else {
      body = `${who} deleted ${what} (${total})`;
    }
    return {
      userId: member.userId,
      title: group.name,
      body,
      data: activityData(group, { kind: 'expense', id: String(expense._id) }),
    };
  }));
};

/** kind: 'recorded' | 'deleted'. Only the payer and receiver are told. */
export const notifySettlement = (group, settlement, actor, kind) => {
  const amount = money(settlement.amount, group.currencySymbol);
  const fromName = firstName(memberNameOf(group, settlement.fromMemberId));
  const toName = firstName(memberNameOf(group, settlement.toMemberId));
  const who = firstName(actor.name);
  const actorIsPayer = sameId(actor._id, settlement.fromMemberId);
  const actorIsReceiver = sameId(actor._id, settlement.toMemberId);

  return sendPushToUsers(
    recipients(group, [settlement.fromMemberId, settlement.toMemberId], actor._id).map((member) => {
      const isReceiver = sameId(member._id, settlement.toMemberId);
      let body;
      if (kind === 'deleted') {
        if (isReceiver) {
          body = actorIsPayer
            ? `${who} deleted their payment of ${amount} to you`
            : `${who} deleted ${fromName}'s payment of ${amount} to you`;
        } else {
          body = actorIsReceiver
            ? `${who} deleted your payment of ${amount} to them`
            : `${who} deleted your payment of ${amount} to ${toName}`;
        }
      } else if (isReceiver) {
        body = actorIsPayer ? `${fromName} paid you ${amount}` : `${who} recorded that ${fromName} paid you ${amount}`;
      } else {
        body = `${who} recorded your payment of ${amount} to ${toName}`;
      }
      return {
        userId: member.userId,
        title: group.name,
        body,
        data: activityData(group, { kind: 'settlement', id: String(settlement._id) }),
      };
    })
  );
};

export const notifyMemberJoined = (group, joined) => {
  const everyone = group.members.map((m) => m._id);
  return sendPushToUsers(recipients(group, everyone, joined._id).map((member) => ({
    userId: member.userId,
    title: group.name,
    body: `${firstName(joined.name)} joined the group`,
    data: activityData(group, { kind: 'member' }),
  })));
};
