// Vercel Function: /api/feedback
// Required environment variables in Vercel:
//   FIREBASE_API_KEY   - the Firebase Web API key for this project
//   RESEND_API_KEY     - secret API key from Resend
//   FEEDBACK_TO_EMAIL  - the Gmail address that should receive reports

const ALLOWED_CATEGORIES = new Set(['request', 'bug', 'other']);
const CATEGORY_LABELS = {
  request: '新機能のご要望',
  bug: '不具合の報告',
  other: 'その他・感想'
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Reject cross-origin browser requests. No Origin header may be present in non-browser clients,
  // so Firebase ID-token verification below remains the actual authentication check.
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return res.status(403).json({ error: 'Origin not allowed' });
      }
    } catch {
      return res.status(403).json({ error: 'Invalid origin' });
    }
  }

  const firebaseApiKey = process.env.FIREBASE_API_KEY;
  const resendApiKey = process.env.RESEND_API_KEY;
  const recipient = process.env.FEEDBACK_TO_EMAIL;
  if (!firebaseApiKey || !resendApiKey || !recipient) {
    console.error('Missing required email notification environment variables.');
    return res.status(500).json({ error: 'Email notification is not configured' });
  }

  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: 'Sign-in required' });

  // Verify the Firebase ID token using Firebase Authentication's account lookup endpoint.
  // The browser's Firebase API key is not a secret; the ID token is what proves authentication.
  let verifiedUser;
  try {
    const verifyResponse = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseApiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: match[1] })
      }
    );
    if (!verifyResponse.ok) {
      return res.status(401).json({ error: 'Invalid or expired sign-in token' });
    }
    const verifyData = await verifyResponse.json();
    verifiedUser = verifyData.users && verifyData.users[0];
    if (!verifiedUser) return res.status(401).json({ error: 'Could not verify user' });
  } catch (error) {
    console.error('Firebase token verification failed:', error);
    return res.status(502).json({ error: 'Authentication verification unavailable' });
  }

  const body = req.body || {};
  const category = typeof body.category === 'string' ? body.category : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const createdAt = typeof body.createdAt === 'string' ? body.createdAt : new Date().toISOString();

  if (!ALLOWED_CATEGORIES.has(category) || !content || content.length > 10000) {
    return res.status(400).json({ error: 'Invalid category or content' });
  }

  const safeContent = content;
  const textBody = [
    'My Kakeibo に新しい報告が届きました。',
    '',
    `カテゴリ：${CATEGORY_LABELS[category]}`,
    `送信日時：${createdAt}`,
    `ユーザーID：${verifiedUser.localId || '不明'}`,
    '',
    '【報告内容】',
    safeContent,
    '',
    '※このメールは家計簿アプリからの自動通知です。'
  ].join('\n');

  try {
    const sendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'My Kakeibo <onboarding@resend.dev>',
        to: [recipient],
        subject: `【家計簿アプリ】${CATEGORY_LABELS[category]}`,
        text: textBody
      })
    });

    const result = await sendResponse.json().catch(() => ({}));
    if (!sendResponse.ok) {
      console.error('Resend send failed:', sendResponse.status, result);
      return res.status(502).json({ error: 'Email provider rejected the message' });
    }
    return res.status(200).json({ ok: true, id: result.id || null });
  } catch (error) {
    console.error('Resend request failed:', error);
    return res.status(502).json({ error: 'Could not contact email provider' });
  }
};
