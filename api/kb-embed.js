// ─────────────────────────────────────────────────────────────────────────────
// api/kb-embed.js — 내부 인사이트 소스를 AI 검색에 반영
//
// insight.html 에서 자막을 저장하면 곧바로 호출된다. kbSources/{id} 의 자막을
// 청크로 잘라 임베딩하고 chunks 컬렉션에 쓴다 → 다음 질문부터 검색에 잡힌다.
// 삭제하면 그 소스의 청크도 함께 지운다.
//
// 커밍쏜 계정만 호출할 수 있다(ID 토큰 검증). 자막 원문은 서버가 Firestore 에서
// 직접 읽는다 — 클라이언트가 보낸 본문을 믿지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

import { requireOwner } from './_auth.js';
import { upsertKbChunks, deleteKbChunks, upsertPlaybookChunk, deletePlaybookChunks, reembedAllPlaybook } from './_vectors.js';

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!(await requireOwner(req, res))) return;

  const { id, action = 'upsert', kind = 'kb' } = req.body || {};

  // 플레이북 검증 답변(👍·승인) — 커밍쏜이 승인/수정/삭제할 때 호출된다.
  if (kind === 'playbook') {
    const KEY = process.env.GEMINI_API_KEY;
    try {
      if (action === 'all') {
        if (!KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
        return res.status(200).json(Object.assign({ ok: true }, await reembedAllPlaybook(KEY)));
      }
      if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id 가 필요합니다' });
      if (action === 'delete') return res.status(200).json({ ok: true, removed: await deletePlaybookChunks(id) });
      if (!KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
      return res.status(200).json({ ok: true, chunks: await upsertPlaybookChunk(id, KEY) });
    } catch (e) {
      console.error('[kb-embed/playbook]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id 가 필요합니다' });

  try {
    if (action === 'delete') {
      const removed = await deleteKbChunks(id);
      return res.status(200).json({ ok: true, removed });
    }
    const KEY = process.env.GEMINI_API_KEY;
    if (!KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
    const chunks = await upsertKbChunks(id, KEY);
    return res.status(200).json({ ok: true, chunks });
  } catch (e) {
    console.error('[kb-embed]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
