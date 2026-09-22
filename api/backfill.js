// ─────────────────────────────────────────────────────────────────────────────
// api/backfill.js — GET /api/backfill : 검색 자산 백필 (10분 1회 스로틀, 로그인 불필요)
//
// 코치 화면이 열릴 때마다 부른다. 커밍쏜이 설정 화면을 안 열어도, 승인된 사례·Q&A·
// 문서가 벡터 검색에 잡히게 된다. 결과 JSON 은 상태 확인용.
// ─────────────────────────────────────────────────────────────────────────────
import { backfillThrottled } from './_backfill.js';
import { patternsMergeRetry } from './distill.js';
import { getDb } from './_firestore.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  try {
    const r = await backfillThrottled();
    // 패턴 병합이 실패로 남아 있으면 여기서 1시간 1회 재시도 (배치 재실행 없음)
    let patterns = null;
    try { patterns = await patternsMergeRetry(getDb(), process.env.CLAUDE_API_KEY); }
    catch (e) { patterns = { error: String(e.message).slice(0, 120) }; }
    return res.status(200).json(Object.assign({}, r, { patterns }));
  } catch (e) {
    return res.status(500).json({ error: String(e.message).slice(0, 200) });
  }
}
