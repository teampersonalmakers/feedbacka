// ─────────────────────────────────────────────────────────────────────────────
// api/backfill.js — GET /api/backfill : 검색 자산 백필 (10분 1회 스로틀, 로그인 불필요)
//
// 코치 화면이 열릴 때마다 부른다. 커밍쏜이 설정 화면을 안 열어도, 승인된 사례·Q&A·
// 문서가 벡터 검색에 잡히게 된다. 결과 JSON 은 상태 확인용.
// ─────────────────────────────────────────────────────────────────────────────
import { backfillThrottled } from './_backfill.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  try {
    return res.status(200).json(await backfillThrottled());
  } catch (e) {
    return res.status(500).json({ error: String(e.message).slice(0, 200) });
  }
}
