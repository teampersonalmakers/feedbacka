// ─────────────────────────────────────────────────────────────────────────────
// api/eval.js — 승인 Q&A 기반 자동 평가 (커밍쏜 전용)
//
// 플레이북에서 '승인' 된 Q&A 는 "이 질문엔 이렇게 답해야 한다" 는 정답지다.
// 같은 질문을 실제 답변 경로(api/feedback.js)로 다시 물어보고, 나온 답이 승인 답변의
// 기조·핵심을 지키는지 Claude 가 채점한다. 결과는 evals 컬렉션에 쌓이고
// 플레이북 화면(🧪 자동 평가)에서 본다.
//
// 두 가지 모드
//   skipPlaybook=false (기본) — 운영과 같은 조건. 승인 Q&A 가 프롬프트에 있으니
//                                 "정답을 주고도 못 따르는가" 를 본다. 낮으면 지침/프롬프트 문제.
//   skipPlaybook=true          — 승인 Q&A 를 빼고 답하게 한다. 지식베이스·사례·지침만으로
//                                 커밍쏜 기조를 내는지 본다. 낮으면 자료/지침 보강 대상.
//
// feedback.js 를 네트워크가 아니라 같은 프로세스에서 직접 호출한다(URL·보호 설정 무관).
// ─────────────────────────────────────────────────────────────────────────────

import { requireOwner } from './_auth.js';
import { loadPlaybook, loadLikedPlaybook, addEval, listEvals, firestoreEnabled } from './_firestore.js';
import { claudeHeaders, claudeBody, pickText } from './_claude.js';
import feedback from './feedback.js';

export const config = { maxDuration: 300 };

// feedback.js 의 비스트리밍 경로는 setHeader/status/json 만 쓴다.
function fakeRes() {
  const r = { code: 200, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  r.end = () => r;
  r.writeHead = () => r;
  r.write = () => true;
  return r;
}

async function ask(question, category, skipPlaybook) {
  const req = {
    method: 'POST', headers: {},
    body: { question, category: category || '', mode: 'conv', stream: false, isPublic: false },
    __skipPlaybook: !!skipPlaybook, __eval: true,
  };
  const res = fakeRes();
  await feedback(req, res);
  if (res.code !== 200 || !res.body || res.body.error) throw new Error(res.body?.error || ('feedback ' + res.code));
  return res.body.feedback || '';
}

const JUDGE = `당신은 퍼스널메이커스 팀의 답변 품질 심사관입니다.
[승인 답변]은 커밍쏜이 직접 검수한 정답입니다. [AI 답변]이 그 정답의 기조와 핵심을 지키는지 채점하세요.

채점 기준 (1~5점)
5: 핵심 판단과 방향이 같고, 승인 답변에 없는 잘못된 주장도 없다
4: 방향은 같으나 핵심 포인트 하나가 빠졌거나 표현이 약하다
3: 절반쯤 맞다. 중요한 포인트가 빠지거나 다른 방향을 섞었다
2: 방향이 다르다. 일반론이거나 커밍쏜 기조와 어긋난다
1: 정반대이거나 승인 답변과 무관하다

말투·길이·형식은 채점하지 마세요. 판단의 방향과 핵심 포인트만 봅니다.
반드시 아래 JSON 한 줄만 출력하세요.
{"score": 1~5 정수, "verdict": "일치|부분|불일치", "reason": "한두 문장. 무엇이 빠졌거나 어긋났는지 구체적으로"}`;

async function judge(question, expected, actual, key) {
  const user = `[질문]\n${question}\n\n[승인 답변]\n${expected}\n\n[AI 답변]\n${actual}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: claudeHeaders(key),
    body: claudeBody(JUDGE, user, { maxTokens: 2000, effort: 'low' }),
  });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d.error?.message || ('Claude ' + r.status));
  const text = pickText(d);
  const m = text.match(/\{[\s\S]*\}/);
  let parsed = { score: 0, verdict: '?', reason: text.slice(0, 500) };
  if (m) { try { parsed = Object.assign(parsed, JSON.parse(m[0])); } catch (e) { /* 원문 유지 */ } }
  parsed.score = Math.max(0, Math.min(5, Math.round(Number(parsed.score) || 0)));
  return { ...parsed, model: d.model || '' };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireOwner(req, res);
  if (!user) return;
  if (!firestoreEnabled()) return res.status(500).json({ error: 'Firestore 미설정' });

  if (req.method === 'GET') {
    try { return res.status(200).json({ evals: await listEvals(80) }); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET/POST only' });

  const KEY = process.env.CLAUDE_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'CLAUDE_API_KEY not configured' });

  const { limit = 5, skipPlaybook = false, ids = [], source = 'both' } = req.body || {};
  const n = Math.max(1, Math.min(10, Number(limit) || 5));   // 한 번에 10건까지 (300초 한도)

  try {
    // 정답지: 승인 Q&A + 디렉터 👍 세트. source 로 고를 수 있다.
    const approved = source === 'liked' ? [] : ((await loadPlaybook()) || []);
    const liked = source === 'approved' ? [] : await loadLikedPlaybook();
    const all = [...approved, ...liked];
    let picked = Array.isArray(ids) && ids.length ? all.filter((p) => ids.includes(p.id)) : all;
    if (!picked.length) return res.status(400).json({ error: '평가할 승인 Q&A 가 없습니다' });
    // 지정이 없으면 무작위로 뽑는다 — 매번 같은 것만 보지 않도록.
    if (!ids.length) picked = picked.slice().sort(() => Math.random() - 0.5);
    picked = picked.slice(0, n);

    const runId = 'run_' + Date.now().toString(36);
    const results = [];
    for (const p of picked) {
      const t0 = Date.now();
      let row = { runId, playbookId: p.id, question: p.q, expected: p.answer, skipPlaybook: !!skipPlaybook, by: user.email, set: p.liked ? 'liked' : 'approved' };
      try {
        const actual = await ask(p.q, p.category, skipPlaybook);
        const j = await judge(p.q, p.answer, actual, KEY);
        row = { ...row, actual, score: j.score, verdict: j.verdict, reason: j.reason, model: j.model, ms: Date.now() - t0 };
      } catch (e) {
        row = { ...row, actual: '', score: 0, verdict: '오류', reason: e.message, ms: Date.now() - t0 };
      }
      row.id = await addEval(row);
      results.push(row);
    }
    const scored = results.filter((r) => r.score > 0);
    const avg = scored.length ? Math.round((scored.reduce((a, r) => a + r.score, 0) / scored.length) * 100) / 100 : 0;
    return res.status(200).json({ runId, count: results.length, avg, results });
  } catch (e) {
    console.error('[eval]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
