export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const notionKey = (process.env.NOTION_API_KEY || '').trim();
  if (!notionKey) return res.status(500).json({ error: 'NOTION_API_KEY not configured' });
  const PLAYBOOK_DB_ID = (process.env.PLAYBOOK_DB_ID || '3b9818e3e2c94735b9f1d1c75bf73ff2').trim();

  const { question, answer } = req.body || {};
  if (!question || !answer) return res.status(400).json({ error: 'question과 answer가 필요합니다' });

  const title = String(question).replace(/\s+/g, ' ').trim().slice(0, 120);
  const answerText = String(answer);
  const chunks = [];
  for (let i = 0; i < answerText.length && chunks.length < 90; i += 1900) {
    chunks.push(answerText.slice(i, i + 1900));
  }

  const children = [
    { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: '커밍쏜 피드백' } }] } },
    { object: 'block', type: 'paragraph', paragraph: { rich_text: [] } },
    { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: '답변 (AI 초안 — 검수 필요)' } }] } },
    ...chunks.map(c => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: c } }] } })),
  ];

  try {
    const r = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${notionKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        parent: { database_id: PLAYBOOK_DB_ID },
        properties: {
          '질문': { title: [{ type: 'text', text: { content: title } }] },
          '원본 질문': { rich_text: [{ type: 'text', text: { content: String(question).slice(0, 1900) } }] },
          '상태': { select: { name: '답변작성' } },
          '유형': { select: { name: '수동등록' } },
        },
        children,
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(500).json({ error: '노션 등록 실패: ' + r.status + ' ' + (data.message || '').slice(0, 150) });
    return res.status(200).json({ ok: true, url: data.url || '' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}