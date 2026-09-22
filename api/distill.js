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
import { backfillEmbeddings } from './_backfill.js';

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
5. 출력은 JSON 배열 하나만. 설명·머리말 없이. 문자열 안의 줄바꿈은 \\n 으로 쓰고, 따옴표는 \\" 로 이스케이프합니다.

[{"summary":"","situation":"","diagnosis":"","prescription":"","reasoning":"","quote":"","tags":[],"participants":""}]`;

// 모델이 낸 JSON 은 문자열 안에 생 줄바꿈·탭이 섞이거나 끝에 쉼표가 남을 때가 있다.
// (140편 중 3편이 이걸로 실패했다) 그대로 파싱 → 실패하면 고쳐서 다시.
// 모델이 낸 JSON 을 고쳐 읽는다. 문자열 안의 줄바꿈·제어문자, 끝의 쉼표, 그리고 문자열 안의 이스케이프 안 된 큰따옴표
// (예: "고객이 "좋아요"로 끝나면") — 따옴표 뒤에 , } ] : 가 오지 않으면 문자열이 닫힌 게 아니라고 보고 \" 로 바꾼다.
// 그래도 안 읽히면 객체를 하나씩 잘라 읽히는 것만 살린다(배열 입력일 때) — 한 항목의 오류로 전체를 버리지 않게.
export function parseCards(raw) {
  try { return JSON.parse(raw); } catch {}
  const repair = (src) => {
    let fixed = '';
    let inStr = false, esc = false;
    const chars = [...src];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (inStr) {
        if (esc) { fixed += ch; esc = false; continue; }
        if (ch === '\\') { fixed += ch; esc = true; continue; }
        if (ch === '"') {
          let j = i + 1; while (j < chars.length && /\s/.test(chars[j])) j++;
          const next = j < chars.length ? chars[j] : '';
          if (next === '' || ',}]:'.includes(next)) { inStr = false; fixed += ch; }
          else fixed += '\\"';
          continue;
        }
        if (ch === '\n') { fixed += '\\n'; continue; }
        if (ch === '\r') continue;
        if (ch === '\t') { fixed += '\\t'; continue; }
        if (ch.charCodeAt(0) < 32) continue;
        fixed += ch; continue;
      }
      if (ch === '"') inStr = true;
      fixed += ch;
    }
    return fixed.replace(/,\s*([}\]])/g, '$1');
  };
  const fixed = repair(raw);
  try { return JSON.parse(fixed); } catch (e) {
    // 배열이면 객체 단위로 살린다
    if (!/^\s*\[/.test(fixed)) throw e;
    const items = [];
    const re = /\{[^{}]*\}/g; let m;
    while ((m = re.exec(fixed))) { try { items.push(JSON.parse(m[0])); } catch { try { items.push(JSON.parse(repair(m[0]))); } catch {} } }
    if (!items.length) throw e;
    return items;
  }
}

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
  const cards = parseCards(m[0]);
  if (!Array.isArray(cards)) throw new Error('배열이 아님');
  return { cards, model: d.model || DISTILL_MODEL, usage: d.usage || {} };
}

// ─── AI 사전 검수 ───────────────────────────────────────────────────────────
// 초안 카드를 녹취 원문과 대조해 점수를 매기고, 확실한 것만 자동 승인한다.
//   코드 검사: 인용(quote)이 녹취에 실제로 있는지 (공백·문장부호 무시, 10자 조각 60% 이상 일치)
//   모델 검사: 커밍쏜이 실제로 한 판단인지(수강생 말이 아닌지), 처방·이유가 녹취에 근거하는지,
//             다른 수강생에게도 재사용할 만큼 일반적인지 → 1~5점 + approve/fix/reject
//   승인 후보(eligible) = 점수 ≥ 4 + verdict approve + 인용 확인(정확 일치, 또는 모델 확인+부분 일치) + 근거 발췌가 녹취에 실재 + 처방 있음.
//   기본은 점수·판정만 붙이고 상태는 그대로 둔다. 커밍쏜이 기준을 확인한 뒤 PREREVIEW_AUTO_APPROVE=on
//   으로 켜면 승인 후보만 자동 승인된다. 자동 반려는 어떤 경우에도 하지 않는다.
const REVIEW_MODEL = 'claude-sonnet-5';
const REVIEW_SYSTEM = `당신은 퍼스널메이커스 팀의 검수자입니다. 녹취 원문과, 그 녹취에서 AI가 뽑은 "판단 카드" 초안들을 받습니다.
기준은 「제2의 커밍쏜 기준서」 2-1절 승인 조건입니다. 전부 만족해야 approve. 의심스러우면 점수를 낮춥니다.

승인 조건 (모두 통과해야 5점·approve)
1) 화자가 커밍쏜: 진단·처방이 커밍쏜의 말인가. 수강생·디렉터·다른 참석자의 말을 커밍쏜 판단으로 쓴 카드는 reject. 가장 자주 틀리는 항목이다.
2) 판단이 있다: "이렇게 하세요"가 있는가. 공감·설명·인사만 있으면 reject.
3) 왜가 있다: 그 판단의 이유(원칙·경험·사례)가 녹취에 있는가. 결론만 있으면 fix.
4) 재사용된다: 다른 수강생의 비슷한 상황에도 적용 가능한 판단 기준인가. 그 수강생만의 일정·잡담·인사면 reject.
5) 커밍쏜 판단 패턴과 충돌하지 않는다: 순서(주제 → 결핍 → 방향성 → 코어 키워드 → 메시지 → 페르소나 → 콘텐츠·상품)를 건너뛰거나, 더하라·넓히라고 하거나, 표면 문제에 답한 카드면 커밍쏜이 실제로 말했더라도 reject. "커밍쏜이 말했다"가 아니라 "커밍쏜의 판단 기준에 맞는다"가 조건이다.

추가 확인
- 근거: 처방·이유가 녹취에 실제로 있는가. 녹취에 없는 내용을 보탰으면 reject, 일부 과장·누락·순서 왜곡이면 fix.
- 상황 일치: situation 이 그 수강생의 실제 상황(주제·단계·고민)과 맞는가. 다른 수강생 상황과 섞였으면 reject.
- 인용: quote 가 녹취 원문과 뜻이 같은가(표현 차이 허용). 녹취에 없는 말이면 quoteOk false.
- 넣지 않는 것(있으면 fix 로 표시하고 issue 에 적는다): 본문에 수강생 실명, 수강생의 개인사(가족·건강·재정 세부), 검증 안 된 수치("월 1천" 같은 추정치), 코로나·백신·정치 등 컨설팅과 무관한 발언.

각 카드마다 evidence 에 녹취 원문에서 진단이나 처방을 직접 뒷받침하는 문장을 그대로 1~2문장 복사한다(다듬지 말 것, 없으면 빈 문자열). 이 발췌가 실제로 녹취에 있는지 코드가 다시 확인한다.

점수: 5 승인 조건 전부 통과 / 4 사소한 표현·근거 보강 필요 / 3 일부 보완 필요 / 2 근거 약함 또는 재사용 어려움 / 1 화자 오류·패턴 충돌·지어냄.
출력은 JSON 배열만. [{"i": 카드번호, "score": 1-5, "verdict": "approve"|"fix"|"reject", "quoteOk": true|false, "evidence": "녹취 원문 발췌", "issue": "문제 한 줄(없으면 빈 문자열)"}]`;

// 인용 대조 — 공백·문장부호를 걷어내고 10자 조각이 녹취에 얼마나 있는지 본다.
//   0.9 이상 = 정확 일치(exact)  → 인용 확인
//   0.6~0.9  = 부분 일치(partial) → 조사·어미 차이 수준. 확인으로 치지 않고 표시만 한다.
//   0.6 미만 = 없음(none)
const normQ = (t) => String(t || '').toLowerCase().replace(/[\s"'“”‘’.,!?~…()\[\]·\-]/g, '');
function quoteMatch(quote, text) {
  const q = normQ(quote), t = normQ(text);
  if (q.length < 8) return { level: 'none', ratio: 0 };
  if (t.includes(q)) return { level: 'exact', ratio: 1 };
  const n = 10; let hit = 0, tot = 0;
  for (let i = 0; i + n <= q.length; i += 3) { tot++; if (t.includes(q.slice(i, i + n))) hit++; }
  const ratio = tot ? hit / tot : 0;
  return { level: ratio >= 0.9 ? 'exact' : ratio >= 0.6 ? 'partial' : 'none', ratio: Math.round(ratio * 100) / 100 };
}
function quoteInText(quote, text) { return quoteMatch(quote, text).level === 'exact'; }

async function prereviewBatch(db, KEY, maxDocs = 6) {
  const targets = loadTargets();
  const byKey = {}; targets.forEach((t) => { byKey[t.key] = t; });
  const snap = await db.collection(COL.cases).where('status', '==', 'draft').limit(400).get();
  const drafts = snap.docs.filter((d) => !d.data().review).map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));
  const groups = {};
  for (const c of drafts) { if (c.sourceKey && byKey[c.sourceKey]) (groups[c.sourceKey] = groups[c.sourceKey] || []).push(c); }
  const keys = Object.keys(groups).slice(0, maxDocs);
  const out = { reviewed: 0, approved: 0, remaining: drafts.length, docs: keys.length, errors: 0 };
  for (const k of keys) {
    const t = byKey[k], cards = groups[k];
    const user = `[녹취 제목] ${t.name}\n\n[녹취 전문]\n${t.text.slice(0, 60000)}\n\n[판단 카드 초안 ${cards.length}장]\n` +
      cards.map((c, i) => `#${i}\nsummary: ${c.summary}\nsituation: ${c.situation}\ndiagnosis: ${c.diagnosis}\nprescription: ${c.prescription}\nreasoning: ${c.reasoning}\nquote: ${c.quote}`).join('\n\n');
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: claudeHeaders(KEY),
        body: claudeBody(REVIEW_SYSTEM, user, { maxTokens: 6000, effort: 'medium', model: REVIEW_MODEL }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error?.message || ('Claude ' + r.status));
      const m = pickText(d).match(/\[[\s\S]*\]/);
      const arr = m ? parseCards(m[0]) : null;
      if (!Array.isArray(arr)) throw new Error('JSON 배열 아님');
      const wb = db.batch();
      const now = Date.now();
      cards.forEach((c, i) => {
        const v = arr.find((x) => x && Number(x.i) === i) || {};
        const score = Math.max(1, Math.min(5, Number(v.score) || 0));
        const verdict = ['approve', 'fix', 'reject'].includes(v.verdict) ? v.verdict : 'fix';
        const qm = quoteMatch(c.quote, t.text);
        const quoteCode = qm.level === 'exact';
        // 근거 발췌(모델이 녹취에서 복사한 문장)가 실제로 녹취에 있는지 — 모델 말만 믿지 않는다.
        const em = quoteMatch(String(v.evidence || ''), t.text);
        const evidenceFound = em.level === 'exact';
        // 인용 확인 = 코드로 정확 일치이거나, 모델이 뜻이 같다고 했고 코드로도 부분 일치 이상일 때
        const quoteOk = quoteCode || (v.quoteOk === true && qm.level === 'partial');
        // 자동 승인은 커밍쏜이 검수 기준을 확인하고 켜기 전까지 꺼 둔다(PREREVIEW_AUTO_APPROVE=on).
        // 그전까지는 점수·판정·문제점만 카드에 붙이고 상태(초안)는 건드리지 않는다.
        const autoOn = String(process.env.PREREVIEW_AUTO_APPROVE || 'off').toLowerCase() === 'on';
        const eligible = score >= 4 && verdict === 'approve' && quoteOk && evidenceFound && !!c.prescription;
        const auto = autoOn && eligible;
        const review = { score, verdict, quoteOk, quoteCode, quoteLevel: qm.level, quoteRatio: qm.ratio, evidence: String(v.evidence || '').slice(0, 400), evidenceFound, issue: String(v.issue || '').slice(0, 300), model: d.model || REVIEW_MODEL, at: now, auto, eligible };
        const patch = { review };
        if (auto) Object.assign(patch, { status: 'approved', aiApplied: true, confirmed: false, approvedBy: 'ai', approvedAt: now, embeddedAt: 0 });
        wb.set(c.ref, patch, { merge: true });
        out.reviewed++; if (auto) out.approved++;
      });
      await wb.commit();
    } catch (e) {
      out.errors++;
      console.warn('[prereview] 실패:', t.name, e.message.slice(0, 160));
      // 같은 녹취를 매번 다시 시도하지 않도록 실패 표시만 남긴다(초안 상태는 그대로).
      const wb = db.batch(); cards.forEach((c) => wb.set(c.ref, { review: { score: 0, verdict: 'error', issue: String(e.message).slice(0, 200), at: Date.now() } }, { merge: true })); await wb.commit();
    }
  }
  out.remaining = Math.max(0, drafts.length - out.reviewed);
  return out;
}

// ─── 공통 판단 패턴 추출 ─────────────────────────────────────────────────────
// 승인 카드 + 사전 검수 4점 이상 초안 카드를 묶어 읽혀, 녹취 여러 편에서 반복되는 커밍쏜의
// 판단 원칙을 뽑는다. 결과는 guidelines/logic_candidates 에 "후보"로만 저장되고, 커밍쏜이
// 설정 화면에서 체크한 것만 논리 체크에 들어간다. 자동 반영은 없다.
// 50장씩 배치로 Sonnet 에 보내고(호출당 2배치), 다 끝나면 기존 논리 체크 21줄과 합쳐 정리한다.
const PATTERN_MODEL = 'claude-sonnet-5';
const PATTERN_BATCH = 50;
const PATTERN_MAX_CARDS = 400;
const PATTERN_DOC = '_patterns';
const EXTRACT_PATTERNS_SYSTEM = `당신은 퍼스널메이커스 팀의 분석가입니다. 커밍쏜(코치)의 컨설팅에서 나온 판단 카드 묶음을 받습니다.
여러 카드에서 반복되는 "커밍쏜의 판단 원칙"을 뽑습니다. 원칙은 지침 문장 형식(20~120자, 단정형)으로 씁니다.
- 그 수강생만의 사정이 아니라 다른 수강생에게도 적용되는 판단 기준만.
- 카드 2장 이상에서 반복되는 것을 우선. 1장뿐이어도 분명한 원칙이면 넣되 cards 에 그 1장만.
- 순서·타겟·결핍·코어 키워드·메시지·콘텐츠·수익화·멘탈 등 주제를 가리지 않는다.
- 커밍쏜의 표현을 살리되 내부 용어(경로 1/2, 유형 A/B, 얼라인먼트)는 쓰지 않는다. 문장 안에 큰따옴표(")를 쓰지 않는다.
출력은 JSON 배열만. [{"pattern": "원칙 한 줄", "cards": ["카드id", ...]}]`;
// 병합 출력은 후보 번호(from)만 적게 한다 — 카드 id 를 다시 쓰게 하면 출력이 길어져 한도에서 잘린다(첫 실행이 그렇게 실패했다).
const MERGE_PATTERNS_SYSTEM = `당신은 퍼스널메이커스 팀의 분석가입니다. [기존 논리 체크]와 여러 배치에서 뽑은 [패턴 후보]를 받습니다.
1) 뜻이 같은 후보끼리 하나로 합칩니다. from 에는 합친 후보들의 번호를 전부 적습니다.
2) 각 항목이 기존 논리 체크의 몇 번과 같은 뜻인지 표시합니다(matches: 번호, 없으면 0). 기존 것을 더 구체화하는 정도면 그 번호를 적습니다.
3) 문장은 지침 형식 20~120자, 단정형. 내부 용어 금지. 문장 안에 큰따옴표(")를 쓰지 않는다 — 인용은 작은따옴표나 「」로.
4) 카드 id 는 쓰지 않습니다. 후보 번호만 씁니다.
5) 최종 항목은 최대 50개. 비슷한 것은 과감히 합칩니다.
출력은 JSON 배열만. [{"text": "원칙 한 줄", "matches": 0, "from": [후보 번호, ...]}]`;

async function patternCards(db) {
  const snap = await db.collection(COL.cases).limit(1000).get();
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((c) => c.aiApplied || (c.status === 'draft' && c.review && Number(c.review.score) >= 4))
    .filter((c) => c.summary && (c.prescription || c.body))
    .sort((a, b) => (b.aiApplied ? 1 : 0) - (a.aiApplied ? 1 : 0) || ((b.review && b.review.score) || 0) - ((a.review && a.review.score) || 0))
    .slice(0, PATTERN_MAX_CARDS);
  return rows.map((c) => ({ id: c.id, summary: String(c.summary).slice(0, 120), diagnosis: String(c.diagnosis || '').slice(0, 220), prescription: String(c.prescription || c.body || '').slice(0, 320), doc: String(c.sourceDoc || c.participants || '').slice(0, 80), cohort: c.cohort || '' }));
}
async function claudeJson(system, user, KEY, maxTokens, opts = {}) {
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: claudeHeaders(KEY), body: claudeBody(system, user, Object.assign({ maxTokens, effort: 'medium', model: PATTERN_MODEL }, opts)) });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d.error?.message || ('Claude ' + r.status));
  const txt = pickText(d);
  const m = txt.match(/\[[\s\S]*\]/);
  let arr = m ? parseCards(m[0]) : null;
  if (!Array.isArray(arr)) { const o = (txt.match(/\{[\s\S]*\}/) || [])[0]; const obj = o ? parseCards(o) : null; if (obj && Array.isArray(obj.patterns)) arr = obj.patterns; }
  if (!Array.isArray(arr)) {
    const err = new Error(d.stop_reason === 'max_tokens' ? '출력 한도 초과(max_tokens) — JSON 이 잘림' : 'JSON 배열 아님');
    err.debug = { stop: d.stop_reason, out: (d.usage && d.usage.output_tokens) || 0, head: txt.slice(0, 600), tail: txt.slice(-300) };
    throw err;
  }
  return arr;
}
// 병합 한 라운드: 항목(text, cards)들을 기존 논리 체크와 대조해 합친다. 모델은 번호만 답하고 카드 합집합은 코드가.
const MERGE_CHUNK = 40;
async function mergeRound(items, existing, KEY) {
  const user = '[기존 논리 체크]\n' + existing.map((l, i) => `${i + 1}. ${l}`).join('\n') + '\n\n[패턴 후보 ' + items.length + '개]\n' + items.map((x, i) => `${i + 1}. ${x.text} (카드 ${x.cards.length}장)`).join('\n');
  // 사고(thinking) 없이 — 사고 토큰이 max_tokens 를 같이 써서 출력이 잘린 적이 있다. 항목 40개면 출력 6000 이내.
  const merged = await claudeJson(MERGE_PATTERNS_SYSTEM, user, KEY, 6000, { thinking: false });
  return merged.filter((x) => x && x.text).map((x) => {
    const from = (Array.isArray(x.from) ? x.from : []).map((n) => items[Number(n) - 1]).filter(Boolean);
    const cards = [...new Set([...from.flatMap((c) => c.cards), ...(Array.isArray(x.cards) ? x.cards : [])].map(String))].slice(0, 120);
    const matches = Math.max(0, Math.min(existing.length, Number(x.matches) || 0));
    return { text: String(x.text).slice(0, 220), matches: matches || Math.max(0, ...from.map((c) => c.matches || 0)), cards };
  });
}
// 후보가 많으면 40개씩 1차 병합(병렬) → 결과를 모아 2차 병합. 한 번에 100여 개를 주면 출력이 한도에서 잘리고 함수 시간(120초)도 넘긴다.
async function mergeAll(all, existing, KEY) {
  const items = all.map((x) => ({ text: x.pattern, cards: x.cards, matches: 0 }));
  if (items.length <= MERGE_CHUNK) return mergeRound(items, existing, KEY);
  const chunks = []; for (let i = 0; i < items.length; i += MERGE_CHUNK) chunks.push(items.slice(i, i + MERGE_CHUNK));
  const firsts = (await Promise.all(chunks.map((c) => mergeRound(c, existing, KEY)))).flat();
  if (firsts.length <= MERGE_CHUNK) return firsts;
  return mergeRound(firsts, existing, KEY);
}
async function patternsStep(db, KEY, { force = false, maxBatches = 2 } = {}) {
  const ref = db.collection(COL.distill).doc(PATTERN_DOC);
  let st = (await ref.get()).data() || null;
  if (st && st.status === 'done' && !force && Date.now() - (st.at || 0) < 24 * 3600 * 1000) return { status: 'done', skipped: true, at: st.at, candidates: st.candidates || 0 };
  if (!st || st.status === 'done' || force) {
    const cards = await patternCards(db);
    if (!cards.length) return { status: 'empty', total: 0 };
    const batches = []; for (let i = 0; i < cards.length; i += PATTERN_BATCH) batches.push(cards.slice(i, i + PATTERN_BATCH));
    st = { status: 'running', startedAt: Date.now(), at: Date.now(), total: batches.length, done: 0, cards: cards.length, results: {}, cardDocs: Object.fromEntries(cards.map((c) => [c.id, c.doc])), batchCards: Object.fromEntries(batches.map((b, i) => [i, b])) };
    await ref.set(st);
  }
  let processed = 0, errors = 0;
  for (let i = 0; i < st.total && processed < maxBatches; i++) {
    if (st.results[i]) continue;
    const b = st.batchCards[i];
    const user = '[판단 카드 ' + b.length + '장]\n' + b.map((c) => `#${c.id}\n요약: ${c.summary}\n진단: ${c.diagnosis}\n처방: ${c.prescription}\n출처: ${c.doc}${c.cohort ? ' (' + c.cohort + ')' : ''}`).join('\n\n');
    try {
      const arr = await claudeJson(EXTRACT_PATTERNS_SYSTEM, user, KEY, 6000);
      st.results[i] = arr.filter((x) => x && x.pattern).map((x) => ({ pattern: String(x.pattern).slice(0, 200), cards: (Array.isArray(x.cards) ? x.cards : []).map(String).slice(0, 60) }));
    } catch (e) { errors++; st.results[i] = []; st['error_' + i] = String(e.message).slice(0, 160); console.warn('[patterns] 배치 실패', i, e.message.slice(0, 100)); }
    st.done = Object.keys(st.results).length; st.at = Date.now(); processed++;
    await ref.set(st);
  }
  if (st.done < st.total) return { status: 'running', total: st.total, done: st.done, remaining: st.total - st.done, errors };

  // 병합: 기존 논리 체크와 대조
  const g = await db.collection(COL.guidelines).where('section', '==', 'logic').limit(1).get();
  const existing = g.docs[0] ? (g.docs[0].data().body || []) : [];
  const all = Object.values(st.results).flat();
  let merged;
  try { merged = await mergeAll(all, existing, KEY); }
  catch (e) { st.status = 'error'; st.error = String(e.message).slice(0, 160); st.errorDebug = e.debug || null; st.at = Date.now(); await ref.set(st); return { status: 'error', error: st.error }; }
  const patterns = merged.map((x) => {
    const cards = x.cards.slice(0, 120);
    const docs = [...new Set(cards.map((id) => st.cardDocs[id]).filter(Boolean))];
    return { text: x.text, matches: x.matches, cards, docs, count: docs.length || cards.length, accepted: false };
  }).sort((a, b) => b.count - a.count);
  await db.collection(COL.guidelines).doc('logic_candidates').set({
    section: 'logicCandidates', name: '논리 체크 후보(녹취 공통 패턴)', body: [], active: false, order: 26,
    patterns, cardsUsed: st.cards, existingLines: existing.length, at: Date.now(), model: PATTERN_MODEL,
  });
  st.status = 'done'; st.at = Date.now(); st.candidates = patterns.length;
  await ref.set({ status: 'done', at: st.at, total: st.total, done: st.done, cards: st.cards, candidates: patterns.length });
  return { status: 'done', total: st.total, done: st.done, candidates: patterns.length, cardsUsed: st.cards };
}

// 실패한 병합 자동 재시도 — 배치는 다 끝났는데 병합만 error 로 남은 상태를, 공개 백필 호출(/api/backfill)에서
// 1시간에 최대 1번 다시 시도한다. 배치를 다시 돌리지 않으니 비용은 Sonnet 호출 1번. 오너 로그인이 없어도 스스로 낫는다.
const MERGE_RETRY_GAP_MS = 60 * 60 * 1000;
export async function patternsMergeRetry(db, KEY) {
  if (!db || !KEY) return { skipped: true, reason: 'no-db-or-key' };
  const ref = db.collection(COL.distill).doc(PATTERN_DOC);
  const st = (await ref.get()).data();
  if (!st || st.status !== 'error' || !(st.done >= st.total)) return { skipped: true, reason: 'not-mergeable' };
  if (Date.now() - (st.at || 0) < MERGE_RETRY_GAP_MS) return { skipped: true, reason: 'recent', nextInSec: Math.ceil((MERGE_RETRY_GAP_MS - (Date.now() - (st.at || 0))) / 1000) };
  await ref.set({ at: Date.now() }, { merge: true });   // 먼저 시각을 찍어 동시 호출을 막는다
  return patternsStep(db, KEY, { maxBatches: 0 });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');   // 브라우저가 GET 결과를 304 로 재사용하지 않게 (진행 상태를 매번 새로)
  if (req.method === 'OPTIONS') return res.status(200).end();
  const user = await requireOwner(req, res);
  if (!user) return;
  if (!firestoreEnabled()) return res.status(500).json({ error: 'Firestore 미설정' });
  const db = getDb();
  const KEY = process.env.CLAUDE_API_KEY;

  // 백필만 (녹취 목록을 읽지 않는다). 누구나 부르는 /api/backfill 은 10분 스로틀, 이건 커밍쏜 전용 즉시 실행.
  if (req.method === 'GET' && req.query && req.query.backfill) {
    return res.status(200).json({ backfill: await backfillEmbeddings() });
  }
  // 공통 판단 패턴 추출 — 배치 2개씩. patterns=force 면 처음부터 다시.
  if (req.method === 'GET' && req.query && req.query.patterns) {
    if (!KEY) return res.status(500).json({ error: 'CLAUDE_API_KEY 없음' });
    const r = await patternsStep(db, KEY, { force: req.query.patterns === 'force', maxBatches: Math.min(4, Number(req.query.batches) || 2) });
    return res.status(200).json({ patterns: r });
  }
  // AI 사전 검수 — 한 번에 녹취 6편 분량. 코치 화면이 커밍쏜 로그인 때 남은 게 없을 때까지 반복해 부른다.
  if (req.method === 'GET' && req.query && req.query.prereview) {
    if (!KEY) return res.status(500).json({ error: 'CLAUDE_API_KEY 없음' });
    const r = await prereviewBatch(db, KEY, Math.min(10, Number(req.query.docs) || 6));
    return res.status(200).json({ prereview: r });
  }

  const targets = loadTargets();
  const progSnap = await db.collection(COL.distill).get();
  const prog = {}; progSnap.docs.forEach((d) => { prog[d.id] = d.data(); });
  const done = targets.filter((t) => prog[t.key]?.status === 'done');
  const failed = targets.filter((t) => prog[t.key]?.status === 'failed');

  if (req.method === 'GET') {
    const drafts = (await db.collection(COL.cases).where('status', '==', 'draft').count().get()).data().count;
    // 설정 화면을 열 때마다 아직 검색 자산으로 안 올라간 승인 사례·승인 Q&A 를 조금씩 올린다.
    // (노션에서 옮겨온 34건처럼 버튼을 누르지 않아도 두어 번 열면 다 올라간다)
    const backfill = await backfillEmbeddings();
    return res.status(200).json({ total: targets.length, done: done.length, failed: failed.length, drafts, backfill,
      totalChars: targets.reduce((a, t) => a + t.chars, 0), model: DISTILL_MODEL });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET/POST only' });

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

// 테스트용 노출 (scripts/_prtest.mjs)
export const __test = { prereviewBatch, quoteInText, quoteMatch, patternsStep };
