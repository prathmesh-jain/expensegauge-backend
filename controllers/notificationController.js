import User from '../models/userModel.js';
import { EXPO_TOKEN_PATTERN } from '../utils/pushService.js';

const MAX_DEVICES = 5;

const readToken = (body) =>
  typeof body?.token === 'string' && EXPO_TOKEN_PATTERN.test(body.token) && body.token.length <= 200
    ? body.token
    : null;

// POST /api/v1/notifications/register  { token }
export const registerPushToken = async (req, res) => {
  try {
    const token = readToken(req.body);
    if (!token) return res.status(400).json({ message: 'Invalid push token' });

    // A device belongs to whoever signed in on it last
    await User.updateMany({ _id: { $ne: req.userId } }, { $pull: { pushTokens: { token } } });

    const user = await User.findById(req.userId).select('pushTokens');
    if (!user) return res.status(404).json({ message: 'User not found' });
    const others = (user.pushTokens || []).filter((t) => t.token !== token);
    // Newest first; the oldest device drops off past the limit
    user.pushTokens = [{ token, updatedAt: new Date() }, ...others].slice(0, MAX_DEVICES);
    await user.save();
    return res.status(200).json({ registered: true });
  } catch (error) {
    console.error('Register push token error:', error);
    return res.status(500).json({ message: 'Failed to register for notifications' });
  }
};

// POST /api/v1/notifications/unregister  { token } — called on logout
export const unregisterPushToken = async (req, res) => {
  try {
    const token = readToken(req.body);
    if (!token) return res.status(400).json({ message: 'Invalid push token' });
    await User.updateOne({ _id: req.userId }, { $pull: { pushTokens: { token } } });
    return res.status(200).json({ registered: false });
  } catch (error) {
    console.error('Unregister push token error:', error);
    return res.status(500).json({ message: 'Failed to unregister' });
  }
};

// GET /api/v1/notifications/settings
export const getNotificationSettings = async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('notifyGroups');
    if (!user) return res.status(404).json({ message: 'User not found' });
    return res.status(200).json({ settings: { groups: user.notifyGroups !== false } });
  } catch (error) {
    console.error('Get notification settings error:', error);
    return res.status(500).json({ message: 'Failed to load settings' });
  }
};

// PATCH /api/v1/notifications/settings  { groups: boolean }
export const updateNotificationSettings = async (req, res) => {
  try {
    if (typeof req.body.groups !== 'boolean') {
      return res.status(400).json({ message: 'groups must be true or false' });
    }
    const user = await User.findByIdAndUpdate(req.userId, { notifyGroups: req.body.groups }, { new: true }).select('notifyGroups');
    if (!user) return res.status(404).json({ message: 'User not found' });
    return res.status(200).json({ settings: { groups: user.notifyGroups !== false } });
  } catch (error) {
    console.error('Update notification settings error:', error);
    return res.status(500).json({ message: 'Failed to save settings' });
  }
};
