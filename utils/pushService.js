import User from '../models/userModel.js';

// Sends push notifications through Expo's push service, which forwards them
// to Firebase (Android) using the FCM key uploaded to EAS.
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH_SIZE = 100;
const ANDROID_CHANNEL_ID = 'group-activity';
export const EXPO_TOKEN_PATTERN = /^Expo(nent)?PushToken\[[^\]]+\]$/;

const defaultTransport = async (messages) => {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  // Only needed if "enhanced push security" is turned on for the Expo project
  if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(messages),
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Expo push failed: ${res.status} ${JSON.stringify(body)}`);
  return body.data || [];
};

let transport = defaultTransport;
// Lets a test replace the sender so nothing is actually sent
export const setPushTransport = (fn) => {
  transport = fn || defaultTransport;
};

/**
 * notifications: [{ userId, title, body, data }]
 * Never throws: notifications are best effort and must not break the request
 * that triggered them. Tokens Expo reports as no longer registered are removed.
 */
export const sendPushToUsers = async (notifications) => {
  try {
    if (!notifications.length || process.env.PUSH_DISABLED === 'true') return;
    const userIds = [...new Set(notifications.map((n) => String(n.userId)))];
    const users = await User.find({ _id: { $in: userIds }, notifyGroups: { $ne: false } })
      .select('pushTokens')
      .lean();
    const tokensByUser = new Map(users.map((u) => [String(u._id), (u.pushTokens || []).map((t) => t.token)]));

    const messages = [];
    for (const n of notifications) {
      for (const token of tokensByUser.get(String(n.userId)) || []) {
        messages.push({
          to: token,
          title: n.title,
          body: n.body,
          data: n.data,
          sound: 'default',
          channelId: ANDROID_CHANNEL_ID,
          priority: 'high',
        });
      }
    }

    const deadTokens = [];
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      const batch = messages.slice(i, i + BATCH_SIZE);
      const tickets = await transport(batch);
      tickets.forEach((ticket, index) => {
        if (ticket?.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          deadTokens.push(batch[index].to);
        }
      });
    }
    if (deadTokens.length) {
      await User.updateMany({}, { $pull: { pushTokens: { token: { $in: deadTokens } } } });
    }
  } catch (error) {
    console.error('[Push] Failed to send notifications:', error.message);
  }
};
