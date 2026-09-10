// ─────────────────────────────────────────────────────────────────────────────
// api/_auth.js — Firebase ID 토큰 검증
//
// 브라우저가 Authorization: Bearer <idToken> 을 보내면 여기서 검증한다.
// 클라이언트가 보내는 이메일을 그대로 믿지 않는다 — 토큰 서명을 확인해야
// 진짜 그 사람인지 알 수 있다.
//
// firebase-admin/auth 의 verifyIdToken 을 쓰지 않는 이유:
// 그 경로가 끌어오는 jwks-rsa 가 ESM 전용 jose 를 require() 하는데, Vercel 함수
// 런타임이 이를 거부해 함수가 시작조차 못 한다(ERR_REQUIRE_ESM, 2026-09-10 확인).
// 우리 코드는 ESM 이라 jose 를 직접 import 하면 문제가 없다. Firebase ID 토큰은
// 표준 RS256 JWT 이고 공개키는 Google 이 JWKS 로 공개하므로 직접 검증한다.
//   https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library
// ─────────────────────────────────────────────────────────────────────────────

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { readServiceAccount } from './_firestore.js';

// firestore.rules / storage.rules / public/firebase.js 의 소유자와 동일하게 유지
export const OWNER_EMAILS = ['comingssoni@gmail.com'];

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let _jwks = null;
function jwks() {
  // jose 가 키를 캐시하고, 모르는 kid 가 오면 알아서 다시 받아온다.
  return _jwks || (_jwks = createRemoteJWKSet(new URL(JWKS_URL), { cooldownDuration: 30_000, cacheMaxAge: 600_000 }));
}

function projectId() {
  return process.env.FIREBASE_PROJECT_ID || readServiceAccount()?.project_id || '';
}

// 토큰 문자열 → { uid, email } 또는 null. 검증 규칙은 Firebase 문서의 필수 조건과 같다.
export async function verifyIdToken(token, opts = {}) {
  const pid = opts.projectId || projectId();
  if (!token || !pid) return null;
  try {
    const { payload } = await jwtVerify(token, opts.keySet || jwks(), {
      algorithms: ['RS256'],
      issuer: `https://securetoken.google.com/${pid}`,
      audience: pid,
      clockTolerance: 60,
    });
    if (!payload.sub || typeof payload.sub !== 'string') return null;
    if (payload.auth_time == null) return null;
    if (!payload.email || payload.email_verified !== true) return null;
    return { uid: payload.sub, email: String(payload.email).toLowerCase() };
  } catch (e) {
    console.warn('[auth] ID 토큰 검증 실패:', e.code || e.message);
    return null;
  }
}

// 검증 실패 시 null. 호출부가 401 로 응답한다.
export async function verify(req) {
  const raw = req.headers?.authorization || req.headers?.Authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7).trim() : '';
  if (!token) return null;
  return verifyIdToken(token);
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
