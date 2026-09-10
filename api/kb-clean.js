// ─────────────────────────────────────────────────────────────────────────────
// api/kb-clean.js — 자막 원문 교정
//
// 유튜브 자동자막은 문장부호가 없고 고유명사가 자주 깨진다("퍼스널메이커스"가
// "퍼스널 메이 커스"로 나오는 식). Claude 로 다듬어 읽을 수 있는 텍스트로 만든다.
//
// 커밍쏜 계정만 호출할 수 있다(ID 토큰 검증).
// ─────────────────────────────────────────────────────────────────────────────

import { requireOwner } from './_auth.js';
import { claudeHeaders, claudeBody, pickText } from './_claude.js';

export const config = { maxDuration: 300 };

// 한 번에 다 넣으면 출력 토큰 상한에 걸린다. 문장 경계로 잘라 나눠 처리한다.
function split(text, size = 6000) {
  const parts = [];
  let cur = '';
  for (const piece of String(text).split(/(?<=[.!?。？！\n])/)) {
    if (cur.length + piece.length > size && cur) { parts.push(cur); cur = ''; }
    cur += piece;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

const SYSTEM = `당신은 한국어 유튜브 자막을 교정하는 편집자입니다.

규칙:
1. 내용을 요약하거나 생략하지 마세요. 모든 발화를 보존합니다.
2. 띄어쓰기와 문장부호를 바로잡고, 문장 단위로 줄을 나눕니다.
3. 자동자막이 잘못 알아들은 고유명사를 문맥에 맞게 고칩니다.
   자주 나오는 표기: 퍼스널메이커스, 커밍쏜, 유튜브, 브랜딩, 페르소나, 썸네일, 콘텐츠
4. "어", "음", "그" 같은 무의미한 간투사는 덜어냅니다. 단, 말의 뉘앙스가 담긴 것은 남깁니다.
5. [웃음] 같은 대괄호 표기는 그대로 둡니다.
6. 화자가 바뀌는 지점이 뚜렷하면 빈 줄로 구분합니다.
7. 교정한 본문만 출력하세요. 설명이나 머리말을 붙이지 마세요.`;

async function clean(part, key) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: claudeHeaders(key),
    // 기계적인 교정 작업이라 effort 는 low 로 충분하다.
    body: claudeBody(SYSTEM, '다음 자막을 교정해주세요.\n\n' + part, { maxTokens: 8000, effort: 'low' }),
  });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d.error?.message || ('Claude ' + r.status));
  return pickText(d);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!(await requireOwner(req, res))) return;

  const KEY = process.env.CLAUDE_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'CLAUDE_API_KEY not configured' });

  const { text } = req.body || {};
  if (!text || String(text).trim().length < 20) {
    return res.status(400).json({ error: '교정할 자막 내용이 필요합니다' });
  }

  try {
    const parts = split(String(text));
    const out = [];
    for (const p of parts) out.push(await clean(p, KEY));
    const cleaned = out.join('\n\n').trim();
    return res.status(200).json({
      cleaned,
      beforeChars: String(text).length,
      afterChars: cleaned.length,
      parts: parts.length,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
