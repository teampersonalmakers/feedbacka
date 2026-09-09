// ─────────────────────────────────────────────────────────────────────────────
// api/_auth.js — Firebase ID 토큰 검증
//
// 브라우저가 Authorization: Bearer <idToken> 을 보내면 여기서 검증한다.
// 클라이언트가 보내는 이메일을 그대로 믿지 않는다 — 토큰 서명을 확인해야
// 진짜 그 사람인지 알 수 있다.
// ─────────────────────────────────────────────────────────────────────────────

import { getAuth } from 'firebase-admin/auth';
import { getDb } from './_firestore.js';

// firestore.rules / storage.rules / public/firebase.js 의 소유자와 동일하게 유지
export const OWNER_EMAILS = ['comingssoni@gmail.com'];

// 검증 실패 시 null. 호출부가 401 로 응답한다.
export async function verify(req) {
  const raw = req.headers?.authorization || req.headers?.Authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7).trim() : '';
  if (!token) return null;
  if (!getDb()) return null;   // Admin SDK 초기화 (getAuth 가 앱을 필요로 한다)
  try {
    const decoded = await getAuth().verifyIdToken(token);
    if (!decoded.email || decoded.email_verified !== true) return null;
    return { uid: decoded.uid, email: String(decoded.email).toLowerCase() };
  } catch (e) {
    console.warn('[auth] ID 토큰 검증 실패:', e.message);
    return null;
  }
}

export async function requireOwner(req, res) {
  const user = await verify(req);
  if (!user) { res.status(401).json({ error: '로그인이 필요합니다' }); return null; }
  if (!OWNER_EMAILS.includes(user.email)) {
    res.status(403).json({ error: '커밍쏜 계정만 사용할 수 있습니다' });
    return null;
  }
  return user;
}
