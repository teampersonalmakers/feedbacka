// api/history.js — 대화 자동 기록
// Firestore 가 정본. 서비스 계정이 없을 때만 예전 Notion 경로로 폴백한다.

import { addHistory, firestoreEnabled } from './_firestore.js';

const NOTION_KEY = (process.env.NOTION_API_KEY || '').trim();
const PLAYBOOK_DB_ID = (process.env.PLAYBOOK_DB_ID || '3b9818e3e2c94735b9f1d1c75bf73ff2').trim();

async function writeToNotion({ question, answer, student, missionType, mode, type }) {
  const ans = String(answer);
  const chunks = [];
  for (let i = 0; i < ans.length && chunks.length < 90; i += 1900) chunks.push(ans.slice(i, i + 1900));
  const para = (c) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: c ? [{ type: 'text', text: { content: c } }] : [] } });
  const head = (c) => ({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: c } }] } });
  const children = [head('커밍쏜 피드백'), para(''), head('답변'), ...chunks.map((c) => para(c))];

  const r = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parent: { database_id: PLAYBOOK_DB_ID },
      properties: {
        '질문': { title: [{ type: 'text', text: { content: String(question).replace(/\s+/g, ' ').trim().slice(0, 120) } }] },
        '원본 질문': { rich_text: [{ type: 'text', text: { content: String(question).slice(0, 1900) } }] },
        '상태': { select: { name: '자동기록' } },
        '유형': { select: { name: type === 'followup' ? '재질문' : '피드백' } },
        '말투': { select: { name: mode === 'conv' ? '구어체' : '문어체' } },
        '수강생': { rich_text: [{ type: 'text', text: { content: String(student || '').slice(0, 190) } }] },
        '미션유형': { rich_text: [{ type: 'text', text: { content: String(missionType || '').slice(0, 190) } }] },
      },
      children,
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('노션 기록 실패: ' + r.status + ' ' + (data.message || '').slice(0, 150));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const { question, answer, student, missionType, mode, type } = req.body || {};
    if (!question || !answer) return res.status(400).json({ error: 'question/answer required' });

    if (firestoreEnabled()) {
      const id = await addHistory({ question, answer, student, missionType, mode, type });
      if (id) return res.status(200).json({ ok: true, store: 'firestore', id });
    }

    if (!NOTION_KEY) return res.status(500).json({ error: 'FIREBASE_SERVICE_ACCOUNT / NOTION_API_KEY 둘 다 설정되지 않았습니다' });
    await writeToNotion({ question, answer, student, missionType, mode, type });
    return res.status(200).json({ ok: true, store: 'notion' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
