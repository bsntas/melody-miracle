// Firebase Cloud Functions — Melody Miracle push notification dispatcher
//
// Deploy with:
//   npm install -g firebase-tools
//   firebase login
//   firebase deploy --only functions
//
// Triggers:
//   1. onCreate melody-miracle/notifications/{emailSlug}/{notifId}
//      → sends FCM push to all devices registered for that email
//   2. onCreate melody-miracle/broadcasts/{broadcastId}
//      → sends FCM push to every stored FCM token (all users)

const functions  = require('firebase-functions');
const admin      = require('firebase-admin');

admin.initializeApp();

const db        = admin.database();
const messaging = admin.messaging();

// Send to all FCM tokens for a given emailSlug, returns count sent.
async function _sendToSlug(slug, notification, data) {
  const snap = await db.ref(`melody-miracle/fcm-tokens/${slug}`).once('value');
  if (!snap.exists()) return 0;

  const tokens = Object.values(snap.val()).filter(Boolean);
  if (!tokens.length) return 0;

  const msg = {
    notification: {
      title: notification.title || 'Melody Miracle',
      body:  notification.body  || '',
    },
    data: data || {},
    tokens,
    webpush: {
      fcmOptions: { link: data?.url || '/' },
    },
    android: {
      notification: { icon: 'ic_notification', clickAction: 'FLUTTER_NOTIFICATION_CLICK' },
    },
  };

  const result = await messaging.sendEachForMulticast(msg);

  // Clean up invalid / unregistered tokens
  const staleTokens = [];
  result.responses.forEach((resp, i) => {
    if (!resp.success) {
      const code = resp.error?.code;
      if (
        code === 'messaging/invalid-registration-token' ||
        code === 'messaging/registration-token-not-registered'
      ) {
        staleTokens.push(tokens[i]);
      }
    }
  });
  if (staleTokens.length) {
    const updates = {};
    Object.entries(snap.val()).forEach(([uid, token]) => {
      if (staleTokens.includes(token)) updates[uid] = null;
    });
    await db.ref(`melody-miracle/fcm-tokens/${slug}`).update(updates);
  }

  return result.successCount;
}

// Trigger: new per-user notification → push to that user's devices
exports.onUserNotification = functions.database
  .ref('melody-miracle/notifications/{emailSlug}/{notifId}')
  .onCreate(async (snap, context) => {
    const { emailSlug } = context.params;
    const notif = snap.val();
    if (!notif) return null;

    await _sendToSlug(emailSlug, {
      title: notif.title || 'Melody Miracle',
      body:  notif.body  || '',
    }, {
      type: notif.type || 'notification',
      url:  notif.url  || '/',
      tag:  notif.type || 'mm-notif',
    });

    return null;
  });

// Trigger: new broadcast → push to ALL users' devices
exports.onBroadcast = functions.database
  .ref('melody-miracle/broadcasts/{broadcastId}')
  .onCreate(async (snap) => {
    const notif = snap.val();
    if (!notif) return null;

    const tokenSnap = await db.ref('melody-miracle/fcm-tokens').once('value');
    if (!tokenSnap.exists()) return null;

    const slugs = Object.keys(tokenSnap.val());
    await Promise.all(slugs.map(slug => _sendToSlug(slug, {
      title: notif.title || 'Melody Miracle',
      body:  notif.body  || '',
    }, {
      type:     notif.type     || 'broadcast',
      url:      notif.url      || '/',
      roomCode: notif.roomCode || '',
      tag:      notif.type     || 'mm-broadcast',
    })));

    return null;
  });
