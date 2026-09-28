// ─────────────────────────────────────────────────────────────────────────────
// api/trendlab.js — 트렌드랩(public/trendlab.html) 전용 프록시
//
// 트렌드랩은 원래 브라우저에서 YouTube Data API·Gemini 를 직접 부르는 독립 앱이었다. 퍼메스 AI 안에
// 넣으면서 키를 브라우저에 두지 않도록, 페이지의 fetch 를 가로채 여기로 보낸다. 서버가 키를 붙인다.
//   · YouTube: 서비스 계정 토큰(또는 YOUTUBE_API_KEY) — 레퍼런스 리서치와 같은 쿼터(하루 10,000유닛)
//   · Gemini: GEMINI_API_KEY
// 로그인한 디렉터만(Firebase ID 토큰). 트렌드랩이 쿼터를 다 쓰면 코치 답변의 레퍼런스 리서치가 막히므로
// 트렌드랩 몫은 하루 TRENDLAB_DAILY_UNITS 로 자른다(검색 100유닛, 나머지 1유닛).
// ─────────────────────────────────────────────────────────────────────────────
import { verify } from './_auth.js';
import { getDb } from './_firestore.js';
import { youtubeAuth } from './_channels.js';

export const config = { maxDuration: 60 };
const YT_PREFIX = 'https://www.googleapis.com/youtube/v3/';
const GA_PREFIX = 'https://generativelanguage.googleapis.com/v1beta/models';
export const TRENDLAB_DAILY_UNITS = 6000;

const unitsOf = (path) => (/\/search$/.test(path) ? 100 : 1);
const dayKST = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

// 하루 사용량 카운터 (references/_trendlab_<day>). Firestore 없으면 제한 없이 통과.
async function reserveUnits(units) {
  const db = getDb(); if (!db) return { ok: true, used: 0 };
  const ref = db.collection('references').doc('_trendlab_' + dayKST());
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const used = (snap.exists && snap.data().used) || 0;
      if (used + units > TRENDLAB_DAILY_UNITS) return { ok: false, used };
      tx.set(ref, { used: used + units, day: dayKST(), at: Date.now() }, { merge: true });
      return { ok: true, used: used + units };
    });
  } catch (e) { return { ok: true, used: 0 }; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'POST only' } });
  const user = await verify(req);
  if (!user) return res.status(401).json({ error: { message: '로그인이 필요합니다 — 퍼메스 AI 에 다시 로그인해주세요' } });

  const { url, method = 'GET', body = null } = req.body || {};
  let u;
  try { u = new URL(String(url)); } catch (e) { return res.status(400).json({ error: { message: 'url 이 올바르지 않습니다' } }); }
  const target = u.origin + u.pathname;
  u.searchParams.delete('key');   // 페이지가 넣은 자리표시 키는 버린다

  const headers = { 'Content-Type': 'application/json' };
  if (target.startsWith(YT_PREFIX)) {
    const q = await reserveUnits(unitsOf(u.pathname));
    if (!q.ok) return res.status(200).json({ error: { code: 403, message: `트렌드랩 일일 할당량(${TRENDLAB_DAILY_UNITS.toLocaleString()}유닛) 초과 — quotaExceeded. 내일 다시 시도해주세요.`, errors: [{ reason: 'quotaExceeded' }] } });
    const auth = await youtubeAuth();
    if (!auth) return res.status(200).json({ error: { message: '서버에 YouTube 인증이 없습니다 (서비스 계정 또는 YOUTUBE_API_KEY)' } });
    if (auth.key) u.searchParams.set('key', auth.key); else headers.Authorization = 'Bearer ' + auth.bearer;
  } else if (target.startsWith(GA_PREFIX)) {
    const gk = (process.env.GEMINI_API_KEY || '').trim();
    if (!gk) return res.status(200).json({ error: { message: '서버에 GEMINI_API_KEY 가 없습니다' } });
    u.searchParams.set('key', gk);
  } else {
    return res.status(400).json({ error: { message: '허용되지 않은 주소' } });
  }

  try {
    const r = await fetch(u.toString(), { method: method === 'POST' ? 'POST' : 'GET', headers, body: method === 'POST' && body ? String(body) : undefined, signal: AbortSignal.timeout(50000) });
    const text = await r.text();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // 오류 본문에 서버 키가 섞여 나가지 않게 한다
    return res.status(200).send(text.replace(/key=[A-Za-z0-9_\-]+/g, 'key=***'));
  } catch (e) {
    return res.status(200).json({ error: { message: '업스트림 호출 실패: ' + String(e.message).slice(0, 120) } });
  }
}
