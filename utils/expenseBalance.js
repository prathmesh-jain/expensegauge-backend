import Expense from "../models/expenseModel.js";

const getSignedAmount = (expense) => (expense.type === "debit" ? -expense.amount : expense.amount);

export const recalculateAfterBalances = async (userId, session = null) => {
  const query = Expense.find({ userId }).sort({ date: 1, createdAt: 1, _id: 1 });
  if (session) {
    query.session(session);
  }

  const expenses = await query;
  if (!expenses.length) return;

  let runningBalance = 0;
  const operations = expenses.map((expense) => {
    runningBalance += getSignedAmount(expense);
    return {
      updateOne: {
        filter: { _id: expense._id },
        update: { $set: { afterBalance: runningBalance } },
      },
    };
  });

  await Expense.bulkWrite(operations, session ? { session } : {});
};

export const getRangeBounds = (range = "all_time") => {
  const now = new Date();
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  switch (range) {
    case "current_month":
      return { startDate: currentMonthStart, endDate: nextMonthStart };
    case "last_month":
      return {
        startDate: new Date(now.getFullYear(), now.getMonth() - 1, 1),
        endDate: currentMonthStart,
      };
    case "last_3_months":
      return {
        startDate: new Date(now.getFullYear(), now.getMonth() - 2, 1),
        endDate: nextMonthStart,
      };
    case "all_time":
    default:
      return { startDate: null, endDate: null };
  }
};

export const getRangeFilter = (range = "all_time") => {
  const { startDate, endDate } = getRangeBounds(range);
  if (!startDate || !endDate) return {};
  return { date: { $gte: startDate, $lt: endDate } };
};
