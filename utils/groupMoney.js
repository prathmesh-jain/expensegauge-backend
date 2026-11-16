// All group maths happens in whole paise (cents) to avoid floating-point drift.

export const toPaise = (amount) => Math.round(Number(amount) * 100);
export const fromPaise = (paise) => paise / 100;

// Rounding a settlement is allowed up to (not including) one whole unit: ₹1, $1, €1
export const MAX_ROUND_OFF_PAISE = 99;

/**
 * Splits `totalPaise` equally between `memberIds` (in the order given).
 * Leftover paise go one each to the first members, so the parts always add up
 * exactly: ₹100 / 3 → 33.34, 33.33, 33.33.
 */
export const splitEqually = (totalPaise, memberIds) => {
  const count = memberIds.length;
  const base = Math.floor(totalPaise / count);
  const remainder = totalPaise - base * count;
  return memberIds.map((memberId, index) => ({
    memberId,
    paise: base + (index < remainder ? 1 : 0),
  }));
};

/**
 * Splits `totalPaise` in proportion to integer `weight`s (percent or shares,
 * already scaled to whole numbers). Each person gets the rounded-down part,
 * and the leftover paise go to whoever lost the most to rounding (ties: the
 * order given), so the parts always add up exactly.
 */
export const splitByWeights = (totalPaise, rows) => {
  // BigInt: amount × weight can pass Number's safe-integer range
  const total = BigInt(totalPaise);
  const totalWeight = BigInt(rows.reduce((sum, row) => sum + row.weight, 0));
  const parts = rows.map((row, index) => {
    const scaled = total * BigInt(row.weight);
    return {
      memberId: row.memberId,
      paise: Number(scaled / totalWeight),
      remainder: scaled % totalWeight,
      index,
    };
  });
  let left = totalPaise - parts.reduce((sum, part) => sum + part.paise, 0);
  const byRemainder = [...parts].sort((a, b) =>
    (b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : 0) || a.index - b.index);
  for (const part of byRemainder) {
    if (left === 0) break;
    part.paise += 1;
    left -= 1;
  }
  return parts.map(({ memberId, paise }) => ({ memberId, paise }));
};

const active = (items) => items.filter((item) => !item.deletedAt);

/**
 * Net position per member in paise.
 * Positive means the group owes them; negative means they owe the group.
 * A settlement moves the payer up and the receiver down by the debt it cleared
 * (`settledAmount`), not by the cash handed over, so rounding never leaves a remainder.
 */
export const computeNetBalances = (expenses, settlements = []) => {
  const nets = new Map();
  const add = (memberId, paise) => {
    const key = String(memberId);
    nets.set(key, (nets.get(key) || 0) + paise);
  };
  for (const expense of active(expenses)) {
    for (const p of expense.paidBy) add(p.memberId, toPaise(p.amount));
    for (const s of expense.splits) add(s.memberId, -toPaise(s.amount));
  }
  for (const settlement of active(settlements)) {
    const cleared = toPaise(settlement.settledAmount ?? settlement.amount);
    add(settlement.fromMemberId, cleared);
    add(settlement.toMemberId, -cleared);
  }
  return nets;
};

/**
 * Who owes whom without simplification: everyone owes the payer of each
 * expense their share, opposite debts between two people cancel out, and
 * settlements between them reduce what's left.
 * Returns [{ from, to, paise }] with from owing to.
 */
export const pairwiseDebts = (expenses, settlements = []) => {
  // Keyed by "a|b" with a < b; positive means a owes b
  const pairs = new Map();
  const owe = (debtor, creditor, paise) => {
    const d = String(debtor);
    const c = String(creditor);
    if (d === c || paise === 0) return;
    const [a, b, sign] = d < c ? [d, c, 1] : [c, d, -1];
    const key = `${a}|${b}`;
    pairs.set(key, (pairs.get(key) || 0) + sign * paise);
  };

  for (const expense of active(expenses)) {
    const total = toPaise(expense.amount);
    for (const payer of expense.paidBy) {
      const paidPaise = toPaise(payer.amount);
      for (const split of expense.splits) {
        // One payer today; with several, each would be owed in proportion to what they paid
        const portion = expense.paidBy.length === 1
          ? toPaise(split.amount)
          : Math.round((toPaise(split.amount) * paidPaise) / total);
        owe(split.memberId, payer.memberId, portion);
      }
    }
  }
  for (const settlement of active(settlements)) {
    // Paying someone means they now owe you that much back (or you owe them less)
    owe(settlement.toMemberId, settlement.fromMemberId, toPaise(settlement.settledAmount ?? settlement.amount));
  }

  const edges = new Map(); // from -> Map(to -> paise)
  for (const [key, paise] of pairs) {
    if (paise === 0) continue;
    const [a, b] = key.split('|');
    const [from, to, amount] = paise > 0 ? [a, b, paise] : [b, a, -paise];
    if (!edges.has(from)) edges.set(from, new Map());
    edges.get(from).set(to, amount);
  }
  cancelCycles(edges);

  const result = [];
  for (const [from, targets] of edges) {
    for (const [to, paise] of targets) result.push({ from, to, paise });
  }
  return result;
};

/**
 * Removes loops like A→B→C→A. After smart-settle payments, people can pay
 * someone they didn't directly owe, which leaves loops of debt that cancel
 * out. Taking the smallest amount off every step of a loop changes nobody's
 * balance and removes at least one debt, so this always finishes.
 */
const cancelCycles = (edges) => {
  const findCycle = () => {
    const state = new Map(); // 1 = on current path, 2 = done
    const path = [];
    const visit = (node) => {
      state.set(node, 1);
      path.push(node);
      for (const next of (edges.get(node) || new Map()).keys()) {
        if (state.get(next) === 1) return path.slice(path.indexOf(next));
        if (!state.has(next)) {
          const found = visit(next);
          if (found) return found;
        }
      }
      state.set(node, 2);
      path.pop();
      return null;
    };
    for (const node of edges.keys()) {
      if (!state.has(node)) {
        const found = visit(node);
        if (found) return found;
      }
    }
    return null;
  };

  for (let cycle = findCycle(); cycle; cycle = findCycle()) {
    const steps = cycle.map((from, i) => [from, cycle[(i + 1) % cycle.length]]);
    const smallest = Math.min(...steps.map(([from, to]) => edges.get(from).get(to)));
    for (const [from, to] of steps) {
      const left = edges.get(from).get(to) - smallest;
      if (left === 0) edges.get(from).delete(to);
      else edges.get(from).set(to, left);
    }
  }
};

/**
 * Smart settle: the fewest payments that bring everyone to zero.
 * Repeatedly matches whoever owes the most with whoever is owed the most,
 * which needs at most (people with a balance - 1) payments.
 * `memberOrder` breaks ties so the same balances always give the same plan.
 */
export const simplifyDebts = (nets, memberOrder = []) => {
  const rank = new Map(memberOrder.map((id, index) => [String(id), index]));
  const byAmountThenOrder = (x, y) => y.paise - x.paise || (rank.get(x.id) ?? 1e9) - (rank.get(y.id) ?? 1e9);

  const creditors = [];
  const debtors = [];
  for (const [id, paise] of nets) {
    if (paise > 0) creditors.push({ id, paise });
    else if (paise < 0) debtors.push({ id, paise: -paise });
  }
  creditors.sort(byAmountThenOrder);
  debtors.sort(byAmountThenOrder);

  const transfers = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const paise = Math.min(debtors[i].paise, creditors[j].paise);
    transfers.push({ from: debtors[i].id, to: creditors[j].id, paise });
    debtors[i].paise -= paise;
    creditors[j].paise -= paise;
    if (debtors[i].paise === 0) i++;
    if (creditors[j].paise === 0) j++;
  }
  return transfers;
};
