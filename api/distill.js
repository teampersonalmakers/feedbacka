// ─────────────────────────────────────────────────────────────────────────────
// api/distill.js — 컨설팅 녹취 → 판단 카드 증류 (커밍쏜 전용)
//
// AI 가 보는 자료의 대부분은 "커밍쏜이 한 말"(녹취)이다. 이 엔드포인트는 녹취를
// "상황 → 진단 → 처방 → 이유" 로 정리한 판단 카드 초안으로 바꾼다. 초안은 cases 에
// status 'draft' 로 들어가고, 설정 › 디렉팅 사례에서 커밍쏜이 승인해야 AI 가 쓴다.
//
// 대상: knowledge/base*.json 의 컨설팅녹취·consulting 문서 140편(약 200만 자).
// 한 번에 batch 편씩 처리하고 distill/{docKey} 에 진행을 남긴다 → 끊겨도 이어서.
// 추출은 claude-sonnet-5 (구조화 추출엔 충분하고 비용이 1/5). 편당 30~60초.
//
//   GET  → 진행 상태 { total, done, failed, drafts }
//   POST { batch: 3 } → 다음 batch 편 증류. { processed:[{name, cards}], remaining }
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { requireOwner } from './_auth.js';
import { getDb, COL, firestoreEnabled } from './_firestore.js';
import { claudeHeaders, claudeBody, pickText } from './_claude.js';

export const config = { maxDuration: 300 };

const DISTILL_MODEL = 'claude-sonnet-5';
const TAGS = ['주제선정', '타겟', '메시지', '콘셉트', '썸네일제목', '대본', '영상퀄리티', '업로드주기', '쇼츠', '수익화', '상품', '광고협업', '멤버십', '채널운영', '멘탈', '기타'];

let _docs = null;
export function loadTargets() {
  if (_docs) return _docs;
  const dir = path.join(process.cwd(), 'knowledge');
  const out = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!/^base\d*\.json$/.test(f)) continue;
    let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); } catch { continue; }
    for (const d of j.documents || []) {
      if (d.type !== '컨설팅녹취' && d.type !== 'consulting') continue;
      const text = (d.chunks || []).map((c) => c.text).join('\n');
      const key = createHash('sha1').update(f + '|' + d.name + '|' + text.slice(0, 200)).digest('hex').slice(0, 16);
      out.push({ key, name: d.name, type: d.type, text, chars: text.length });
    }
  }
  _docs = out;
  return out;
}

const SYSTEM = `당신은 퍼스널메이커스 팀의 컨설팅 녹취를 "판단 카드"로 정리하는 분석가입니다.
커밍쏜(코치)이 수강생과 나눈 대화에서, 커밍쏜이 실제로 내린 판단만 뽑습니다.

판단 카드 하나 = 커밍쏜이 특정 상황에 대해 내린 하나의 판단.
- summary: 한 줄. "상황 — 판단" 형태. 예: "보컬 채널 썸네일에 본인 사진 vs 가수 사진 — 후킹되는 가수 사진 OK, 단 본인 브랜딩은 인트로에서"
- situation: 수강생의 상황과 고민. 2~4문장. 채널 주제·단계·수치가 있으면 포함.
- diagnosis: 커밍쏜이 본 진짜 문제. 수강생이 말한 고민과 다르면 그 차이를 적는다.
- prescription: 커밍쏜이 하라고 한 것. 구체적 행동으로. 순서가 있으면 번호.
- reasoning: 왜 그렇게 판단했는지. 커밍쏜의 원칙·경험·근거.
- quote: 커밍쏜의 결정적 발화 1~2문장. 녹취 원문 그대로(다듬지 말 것). 없으면 빈 문자열.
- tags: 다음 중에서만 1~3개: ${TAGS.join(', ')}
- participants: 수강생 이름/닉네임과 직업·채널 주제. 모르면 빈 문자열.

규칙
1. 녹취에 없는 판단을 만들지 마세요. 커밍쏜이 명확히 말한 것만.
2. 잡담·인사·대시보드 설명 같은 부분은 카드로 만들지 않습니다.
3. 한 녹취에서 보통 3~8장. 판단이 하나뿐이면 1장, 없으면 빈 배열.
4. 수강생의 말과 커밍쏜의 말을 섞지 마세요. 진단·처방·이유는 커밍쏜의 것만.
5. 출력은 JSON 배열 하나만. 설명·머리말 없이.

[{"summary":"","situation":"","diagnosis":"","prescription":"","reasoning":"","quote":"","tags":[],"participants":""}]`;

export function meta(name) {
  const cohort = (name.match(/(\d)기/) || [])[1];
  const round = (name.match(/(\d\s*-\s*\d|\d차|\d회차|\d주차)/) || [])[1];
  return { cohort: cohort ? cohort + '기' : '', round: round ? round.replace(/\s+/g, '') : '' };
}

export async function distillOne(doc, key) {
  const user = `[녹취 제목] ${doc.name}\n\n[녹취 전문]\n${doc.text.slice(0, 60000)}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: claudeHeaders(key),
    body: claudeBody(SYSTEM, user, { maxTokens: 8000, effort: 'medium', model: DISTILL_MODEL }),
  });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d.error?.message || ('Claude ' + r.status));
  const text = pickText(d);
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('JSON 배열을 찾지 못함: ' + text.slice(0, 120));
  const cards = JSON.parse(m[0]);
  if (!Array.isArray(cards)) throw new Error('배열이 아님');
  return { cards, model: d.model || DISTILL_MODEL, usage: d.usage || {} };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const user = await requireOwner(req, res);
  if (!user) return;
  if (!firestoreEnabled()) return res.status(500).json({ error: 'Firestore 미설정' });
  const db = getDb();

  const targets = loadTargets();
  const progSnap = await db.collection(COL.distill).get();
  const prog = {}; progSnap.docs.forEach((d) => { prog[d.id] = d.data(); });
  const done = targets.filter((t) => prog[t.key]?.status === 'done');
  const failed = targets.filter((t) => prog[t.key]?.status === 'failed');

  if (req.method === 'GET') {
    const drafts = (await db.collection(COL.cases).where('status', '==', 'draft').count().get()).data().count;
    return res.status(200).json({ total: targets.length, done: done.length, failed: failed.length, drafts,
      totalChars: targets.reduce((a, t) => a + t.chars, 0), model: DISTILL_MODEL });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET/POST only' });

  const KEY = process.env.CLAUDE_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'CLAUDE_API_KEY not configured' });
  const batch = Math.max(1, Math.min(5, Number(req.body?.batch) || 3));
  const retryFailed = !!req.body?.retryFailed;
  const todo = targets.filter((t) => !prog[t.key] || (retryFailed && prog[t.key].status === 'failed')).slice(0, batch);

  const processed = [];
  for (const t of todo) {
    const t0 = Date.now();
    try {
      const { cards, model, usage } = await distillOne(t, KEY);
      const m = meta(t.name);
      const wb = db.batch();
      const ids = [];
      cards.forEach((c, i) => {
        const ref = db.collection(COL.cases).doc(`d_${t.key}_${i}`);
        ids.push(ref.id);
        wb.set(ref, {
          summary: String(c.summary || '').slice(0, 300),
          situation: String(c.situation || '').slice(0, 2000), diagnosis: String(c.diagnosis || '').slice(0, 2000),
          prescription: String(c.prescription || '').slice(0, 3000), reasoning: String(c.reasoning || '').slice(0, 2000),
          quote: String(c.quote || '').slice(0, 1000),
          tags: (Array.isArray(c.tags) ? c.tags : []).filter((x) => TAGS.includes(x)).slice(0, 3),
          participants: String(c.participants || '').slice(0, 200),
          body: ['상황: ' + (c.situation || ''), '진단: ' + (c.diagnosis || ''), '처방: ' + (c.prescription || ''), '이유: ' + (c.reasoning || '')].join('\n').slice(0, 8000),
          cohort: m.cohort, round: m.round, director: '커밍쏜',
          status: 'draft', aiApplied: false, confirmed: false,
          source: 'distill', sourceDoc: t.name, sourceKey: t.key, model,
          createdAt: Date.now(),
        });
      });
      wb.set(db.collection(COL.distill).doc(t.key), { name: t.name, status: 'done', cards: cards.length, caseIds: ids, chars: t.chars, ms: Date.now() - t0, model, usage: { input: usage.input_tokens || 0, output: usage.output_tokens || 0 }, at: Date.now(), by: user.email });
      await wb.commit();
      processed.push({ name: t.name, cards: cards.length, ms: Date.now() - t0 });
    } catch (e) {
      await db.collection(COL.distill).doc(t.key).set({ name: t.name, status: 'failed', error: String(e.message).slice(0, 300), at: Date.now() }, { merge: true });
      processed.push({ name: t.name, error: e.message });
    }
  }
  const doneNow = done.length + processed.filter((p) => !p.error).length;
  return res.status(200).json({ processed, done: doneNow, total: targets.length, remaining: targets.length - doneNow - failed.length - processed.filter((p) => p.error).length });
}
