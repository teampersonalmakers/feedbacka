// api/rate.js — 답변 평가(👍/👎) 기록
// Firestore 가 정본. 서비스 계정이 없을 때만 예전 Notion 경로로 폴백한다.

import { addRating, addPlaybookFromRating, firestoreEnabled } from './_firestore.js';

const NOTION_KEY = (process.env.NOTION_API_KEY || '').trim();
const RATE_DB_ID = (process.env.RATE_DB_ID || '5707368abfea41a2a861d80ba48aa8ac').trim();

async function writeToNotion({ question, answer, rating, student, comment }) {
  const ans = String(answer || '');
  const chunks = [];
  for (let i = 0; i < ans.length && chunks.length < 90; i += 1900) chunks.push(ans.slice(i, i + 1900));
  const para = (c) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: c ? [{ type: 'text', text: { content: c } }] : [] } });
  const head = (c) => ({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: c } }] } });
  const children = [head('질문'), para(String(question).slice(0, 1900)), head('답변'), ...chunks.map((c) => para(c))];

  const r = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parent: { database_id: RATE_DB_ID },
      properties: {
        '질문': { title: [{ type: 'text', text: { content: String(question).replace(/\s+/g, ' ').trim().slice(0, 120) } }] },
        '평가': { select: { name: rating === 'up' ? '좋음' : '아쉬움' } },
        '수강생': { rich_text: [{ type: 'text', text: { content: String(student || '').slice(0, 190) } }] },
        '코멘트': { rich_text: [{ type: 'text', text: { content: String(comment || '').slice(0, 1900) } }] },
      },
      children,
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('평가 기록 실패: ' + r.status + ' ' + (data.message || '').slice(0, 150));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const { question, answer, rating, student, comment, director } = req.body || {};
    if (!question || !rating) return res.status(400).json({ error: 'question/rating required' });

    if (firestoreEnabled()) {
      const id = await addRating({ question, answer, rating, student, comment });
      if (id) {
        // 👎 는 플레이북 '대기' 로 자동 등록 — 커밍쏜이 바로잡아 승인하면 다음부터 반영된다.
        let playbookId = null;
        if (rating === 'down' && answer) {
          try { playbookId = await addPlaybookFromRating({ question, answer, student, comment, director, ratingId: id }); }
          catch (e) { console.warn('[rate] 검수대기 등록 실패:', e.message); }
        }
        return res.status(200).json({ ok: true, store: 'firestore', id, playbookId });
      }
    }

    if (!NOTION_KEY) return res.status(500).json({ error: 'FIREBASE_SERVICE_ACCOUNT / NOTION_API_KEY 둘 다 설정되지 않았습니다' });
    await writeToNotion({ question, answer, rating, student, comment });
    return res.status(200).json({ ok: true, store: 'notion' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
