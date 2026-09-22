// ─────────────────────────────────────────────────────────────────────────────
// scripts/import-case-doc.mjs — "[PT 컨설팅 케이스] …" 마크다운을 판단 카드 + 지식 소스로 넣기
//
// 커밍쏜이 정리한 컨설팅 케이스 문서(요약본 / 케이스 A~ / 코칭 원칙)를
//   1) cases        — 케이스 하나당 판단 카드 1장 (+ 요약본 1장, 코칭 원칙 1장). 승인 상태로.
//   2) kbSources    — 문서 전문 1건 (type 'consulting'). 검색 자막처럼 통째로도 찾히게.
// 임베딩은 여기서 하지 않는다(Gemini 키는 서버에만 있다). 커밍쏜이 앱을 열면 서버가
// 아직 안 올라간 승인 카드·소스를 자동으로 올린다(api/distill.js GET 백필).
//
// 사용: FIREBASE_SERVICE_ACCOUNT=… node scripts/import-case-doc.mjs 문서.md [문서2.md …] [--dry-run]
// 같은 문서를 다시 넣으면 같은 ID 로 덮어쓴다(중복 없음).
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDb } from '../api/_firestore.js';

const TAGS = ['주제선정', '타겟', '메시지', '콘셉트', '썸네일제목', '대본', '영상퀄리티', '업로드주기', '쇼츠', '수익화', '상품', '광고협업', '멤버십', '채널운영', '멘탈', '기타'];
// 본문 단어 → 태그. 앞에 오는 규칙이 우선.
const TAG_RULES = [
  [/코어 키워드|메시지|Why|WHY|결핍|방향성/, '메시지'],
  [/주제|카테고리|레퍼런스 없는|시장|니치|진입/, '주제선정'],
  [/타겟|과거의 나|피라미드|단계별|페르소나/, '타겟'],
  [/자신감|불안|자존감|헤매|기죽|동기 부여/, '멘탈'],
  [/레퍼런스 채널|롤모델|확장|브랜딩은 더하는/, '채널운영'],
  [/상품|패키징|문의|매출/, '상품'],
];

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const cut = (s, n) => String(s || '').trim().slice(0, n);

function pickTags(text, docTags) {
  const out = [];
  for (const [re, tag] of TAG_RULES) if (re.test(text) && !out.includes(tag)) out.push(tag);
  for (const t of docTags) if (out.length < 3 && !out.includes(t)) out.push(t);
  return out.filter((t) => TAGS.includes(t)).slice(0, 3);
}

// ── 파서 ──────────────────────────────────────────────────────────────────────
export function parseCaseDoc(md, fileName) {
  const lines = md.replace(/\r/g, '').split('\n');
  const title = (lines.find((l) => l.startsWith('# ')) || '# ' + fileName).slice(2).trim();
  const m = /\[PT 컨설팅 케이스\]\s*([^·]+)·\s*([^·]+)·\s*(.+)$/.exec(title);
  const participant = m ? m[1].trim() : '';
  const round = m ? m[2].trim() : '';
  const subject = m ? m[3].trim() : title;

  const meta = {};
  for (const l of lines.slice(0, 15)) {
    const mm = /^- (고객 유형|컨설팅 단계|결과|태그|WHY 디깅 경로|상담일):\s*(.+)$/.exec(l);
    if (mm) meta[mm[1]] = mm[2].trim();
  }
  const docTags = (meta['태그'] || '').split(/\s+/).map((t) => t.replace(/^#/, '')).filter(Boolean);
  const docTagMapped = pickTags(docTags.join(' '), []);

  // 섹션 나누기: '## 1.' 요약본 / '## 2.' 케이스 / '## 3.' 원칙
  const sec = { summary: [], cases: [], principles: [] };
  let cur = null;
  for (const l of lines) {
    if (/^## 1\./.test(l)) { cur = 'summary'; continue; }
    if (/^## 2\./.test(l)) { cur = 'cases'; continue; }
    if (/^## 3\./.test(l)) { cur = 'principles'; continue; }
    if (/^---\s*$/.test(l)) continue;
    if (cur) sec[cur].push(l);
  }

  const cards = [];
  const base = `${participant} · ${round} · ${subject}`;
  const ctx = participant ? `${participant} (${meta['고객 유형'] || ''})` : (meta['고객 유형'] || '');
  // 기준서 2-4: 실명은 문서명(관리용)에만. 카드 요약·본문에는 고객 유형으로 부른다.
  const who = String(meta['고객 유형'] || participant || '참여자').replace(/\([^)]*\)/g, '').split(/[.,]/)[0].trim().slice(0, 22) || '참여자';

  // 1) 요약본 → 카드 1장: 이 회차에서 확정된 판단(주제·결핍·방향)
  {
    const blocks = {};
    let k = '';
    for (const l of sec.summary) {
      const h = /^\*\*(.+?)\*\*\s*$/.exec(l.trim());
      if (h) { k = h[1]; blocks[k] = []; continue; }
      if (k && l.trim()) blocks[k].push(l.trim());
    }
    const get = (re) => Object.keys(blocks).filter((x) => re.test(x)).map((x) => blocks[x].join('\n')).join('\n');
    const topic = get(/주제/), lack = get(/결핍/), over = get(/극복/), dir = get(/방향/), core = get(/코어|메시지/), mission = get(/미션/);
    cards.push({
      key: 'summary',
      summary: cut(`브랜드 로드맵 ${round} 정리 — ${who} (${subject})`, 300),
      situation: cut(`고객: ${meta['고객 유형'] || ''}\n단계: ${meta['컨설팅 단계'] || ''}${meta['WHY 디깅 경로'] ? '\nWHY 디깅 경로: ' + meta['WHY 디깅 경로'].replace(/\*\*/g, '') : ''}`, 2000),
      diagnosis: cut(`${meta['결과'] ? '결과: ' + meta['결과'] + '\n' : ''}${topic}`, 2000),
      prescription: cut([dir && '[방향성]\n' + dir, core && '[코어 키워드·메시지]\n' + core, mission && '[미션]\n' + mission].filter(Boolean).join('\n\n'), 3000),
      reasoning: cut([lack && '[결핍]\n' + lack, over && '[극복]\n' + over].filter(Boolean).join('\n\n'), 2000),
      quote: '',
      tags: pickTags(topic + core, docTagMapped),
    });
  }

  // 2) 케이스 → 카드
  let cur2 = null;
  const caseList = [];
  for (const l of sec.cases) {
    const h = /^### 케이스 ([A-Z])\.\s*(.+)$/.exec(l.trim());
    if (h) { cur2 = { letter: h[1], title: h[2].trim(), bullets: [] }; caseList.push(cur2); continue; }
    if (cur2 && /^- /.test(l.trim())) cur2.bullets.push(l.trim().slice(2));
    else if (cur2 && l.trim() && cur2.bullets.length) cur2.bullets[cur2.bullets.length - 1] += ' ' + l.trim();
  }
  for (const c of caseList) {
    const by = (re) => c.bullets.filter((b) => re.test(b));
    const not = (res) => c.bullets.filter((b) => !res.some((re) => re.test(b)));
    const R_SIT = /^상황:/, R_DX = /^커밍쏜 판단|^판단/, R_WHY = /^근거|^원인 진단|^논리 구조|^차별화 논리|^왜 먼저|^이 고객만/;
    const situation = [c.title, ...by(R_SIT).map((b) => b.replace(/^상황:\s*/, ''))].join('\n');
    const diagnosis = by(R_DX).map((b) => b.replace(/^커밍쏜 판단( 기준)?:\s*|^판단:\s*/, '')).join('\n');
    const reasoning = by(R_WHY).join('\n');
    const prescription = not([R_SIT, R_DX, R_WHY]).join('\n');
    const q = c.bullets.map((b) => (/"([^"]{8,})"/.exec(b) || [])[1]).filter(Boolean);
    cards.push({
      key: 'case_' + c.letter,
      summary: cut(`${c.title} — ${who} ${round}`, 300),
      situation: cut(situation, 2000),
      diagnosis: cut(diagnosis || prescription.split('\n')[0] || '', 2000),
      prescription: cut(prescription, 3000),
      reasoning: cut(reasoning, 2000),
      quote: cut(q[0] || '', 1000),
      tags: pickTags(c.title + ' ' + c.bullets.join(' '), docTagMapped),
    });
  }

  // 3) 코칭 원칙 → 카드 1장
  const pr = sec.principles.map((l) => l.trim()).filter((l) => /^\d+\./.test(l));
  if (pr.length) {
    cards.push({
      key: 'principles',
      summary: cut(`커밍쏜 코칭 원칙 — ${subject} (${who} ${round}에서 드러난 것)`, 300),
      situation: cut(`브랜드 로드맵 컨설팅 ${round}. 고객: ${meta['고객 유형'] || ''}`, 2000),
      diagnosis: '',
      prescription: cut(pr.join('\n'), 3000),
      reasoning: '',
      quote: cut((pr.map((p) => (/"([^"]{6,})"/.exec(p) || [])[1]).filter(Boolean))[0] || '', 1000),
      tags: pickTags(pr.join(' '), docTagMapped),
    });
  }

  return { title, participant, round, subject, meta, docTags, cards, base, ctx, md };
}

// ── 방법론 문서 ("# [커밍쏜 방법론] …") ──────────────────────────────────────
// 케이스 파일과 달리 '## 섹션' 단위로 카드를 만든다. 표(케이스 매핑)는 카드로 만들지 않고 전문에만 남긴다.
export function parseMethodDoc(md, fileName) {
  const lines = md.replace(/\r/g, '').split('\n');
  const title = (lines.find((l) => l.startsWith('# ')) || '# ' + fileName).slice(2).trim();
  const subject = title.replace(/^\[커밍쏜 방법론\]\s*/, '').trim();
  const meta = {};
  for (const l of lines.slice(0, 10)) { const mm = /^- (태그|적용 단계):\s*(.+)$/.exec(l); if (mm) meta[mm[1]] = mm[2].trim(); }
  const docTags = (meta['태그'] || '').split(/\s+/).map((t) => t.replace(/^#/, '')).filter(Boolean);
  const docTagMapped = pickTags(docTags.join(' '), []);
  const secs = [];
  let cur = null;
  for (const l of lines) {
    const h = /^## (.+)$/.exec(l);
    if (h) { cur = { title: h[1].trim(), body: [] }; secs.push(cur); continue; }
    if (cur && !/^# /.test(l)) cur.body.push(l);
  }
  const cards = [];
  for (const sc of secs) {
    const text = sc.body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    const bodyNoTable = text.split('\n').filter((x) => !/^\|/.test(x)).join('\n').trim();
    if (!bodyNoTable) continue;                                   // 표만 있는 섹션은 건너뜀
    const q = (/"([^"]{8,})"/.exec(bodyNoTable) || [])[1] || '';
    cards.push({
      key: 'm_' + sha(sc.title).slice(0, 8),
      summary: cut(`커밍쏜 방법론 · ${subject} — ${sc.title}`, 300),
      situation: cut(`브랜드 로드맵 컨설팅, ${sc.title} 상황.${meta['적용 단계'] ? ' 적용 단계: ' + meta['적용 단계'] : ''}`, 2000),
      diagnosis: '',
      prescription: cut(bodyNoTable, 3000),
      reasoning: '',
      quote: cut(q, 1000),
      tags: pickTags(sc.title + ' ' + bodyNoTable, docTagMapped),
    });
  }
  return { title, participant: '', round: '', subject, meta, docTags, cards, ctx: '커밍쏜 방법론', md, isMethod: true };
}

// ── 쓰기 ──────────────────────────────────────────────────────────────────────
async function importDoc(file, dry) {
  const md = fs.readFileSync(file, 'utf-8');
  const doc = /^#\s*\[커밍쏜 방법론\]/m.test(md) ? parseMethodDoc(md, path.basename(file)) : parseCaseDoc(md, path.basename(file));
  const docKey = sha(doc.title);
  console.log(`\n■ ${doc.title}`);
  console.log(`  참여자 ${doc.participant} · ${doc.round} · 카드 ${doc.cards.length}장 · 태그 ${doc.docTags.join(' ')}`);
  for (const c of doc.cards) {
    console.log(`  - [${c.key}] ${c.summary}  {${c.tags.join(',')}}  상황 ${c.situation.length}자 / 진단 ${c.diagnosis.length}자 / 처방 ${c.prescription.length}자 / 이유 ${c.reasoning.length}자${c.quote ? ' / 발화 ✓' : ''}`);
  }
  if (dry) return doc;

  const db = getDb();
  if (!db) throw new Error('FIREBASE_SERVICE_ACCOUNT 가 필요합니다');
  const b = db.batch();
  const now = Date.now();
  for (const c of doc.cards) {
    const ref = db.collection('cases').doc(`i_${docKey}_${c.key}`);
    b.set(ref, {
      summary: c.summary, situation: c.situation, diagnosis: c.diagnosis, prescription: c.prescription, reasoning: c.reasoning, quote: c.quote,
      tags: c.tags, participants: cut(doc.ctx, 200),
      body: ['상황: ' + c.situation, '진단: ' + c.diagnosis, '처방: ' + c.prescription, '이유: ' + c.reasoning].join('\n').slice(0, 8000),
      cohort: '', round: doc.round, director: '커밍쏜', kind: doc.isMethod ? 'method' : 'case',
      status: 'approved', aiApplied: true, confirmed: true,
      source: 'import', sourceDoc: doc.title, sourceKey: docKey,
      // 상담 시기 — 문서에 '- 상담일: 2026-09-20' 이 있으면 그 날짜, 없으면 가져온 날(최신 상담으로 취급)
      consultedAt: (doc.meta && doc.meta['상담일'] && Date.parse(String(doc.meta['상담일']).slice(0, 10))) || now,
      consultDate: (doc.meta && doc.meta['상담일'] && String(doc.meta['상담일']).slice(0, 10)) || new Date(now).toISOString().slice(0, 10),
      createdAt: now, embeddedAt: 0,
    }, { merge: true });
  }
  // 문서 전문도 지식 소스로 — 요약본의 1인칭 결핍·극복·방향 문장이 통째로 검색되게.
  b.set(db.collection('kbSources').doc(`import_${docKey}`), {
    name: doc.title, type: 'consulting', category: 'branding', status: '완료',
    link: '', memo: `${doc.isMethod ? '커밍쏜 방법론 문서' : 'PT 컨설팅 케이스 문서'}(커밍쏜 정리, 판단 카드 ${doc.cards.length}장으로도 등록)`,
    tags: doc.docTags.slice(0, 12),
    transcript: md, transcriptChars: md.length, transcriptTruncated: false,
    createdAt: now, addedAt: now, embeddedAt: 0, chunks: 0,
  }, { merge: true });
  await b.commit();
  console.log(`  ✅ cases ${doc.cards.length}장 + kbSources 1건 저장 (id 접두 i_${docKey}_ / import_${docKey})`);
  return doc;
}

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) { console.log('usage: node scripts/import-case-doc.mjs 문서.md [...] [--dry-run]'); process.exit(1); }
for (const f of files) await importDoc(f, dry);
