#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Notion → Firestore 마이그레이션
//
// 노션에 쌓아둔 지침 / 컨설팅(디렉팅 사례) / 자료(KB 소스, 원문 자막 포함) / 플레이북 /
// 평가 로그를
// Firestore 로 옮긴다. 페이지 본문(블록)까지 같이 가져온다 — 실제 내용은 속성이
// 아니라 본문에 있기 때문이다.
//
//   node scripts/migrate-notion-to-firestore.mjs --dry-run   # 읽기만, 쓰지 않음
//   node scripts/migrate-notion-to-firestore.mjs             # 실제 반영
//   node scripts/migrate-notion-to-firestore.mjs --only=guidelines,cases
//
// 필요한 환경변수
//   NOTION_API_KEY              노션 인테그레이션 토큰
//   FIREBASE_SERVICE_ACCOUNT    서비스 계정 JSON (원문 또는 base64)
//
// 문서 ID 는 노션 페이지 ID 를 그대로 쓴다. 여러 번 돌려도 덮어쓰기만 되고
// 중복이 생기지 않는다(멱등).
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const NOTION_KEY = (process.env.NOTION_API_KEY || '').trim();
const NOTION_VERSION = '2022-06-28';

const DB = {
  guidelines: process.env.NOTION_DB_ID || 'f1bf4e3893b445eda779d32ec464d4e8',
  playbook: process.env.PLAYBOOK_DB_ID || '3b9818e3e2c94735b9f1d1c75bf73ff2',
  ratings: process.env.RATE_DB_ID || '5707368abfea41a2a861d80ba48aa8ac',
  cases: process.env.CASES_DB_ID || '2ca13dc6a1894927bc5c8ca436fd7a56',
  kbSources: process.env.KB_DB_ID || '16841849b51d489d99b7064358d7bef4',
};

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice(7).split(',').map((s) => s.trim()).filter(Boolean) : null;

// ─── Notion helpers ──────────────────────────────────────────────────────────
async function notion(path, init = {}) {
  const r = await fetch('https://api.notion.com/v1' + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${NOTION_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`Notion ${path} → ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// 노션은 초당 3요청 정도가 한계다. 부드럽게 통과시킨다.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function queryAll(dbId) {
  const out = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const d = await notion(`/databases/${dbId}/query`, { method: 'POST', body: JSON.stringify(body) });
    out.push(...(d.results || []));
    cursor = d.has_more ? d.next_cursor : null;
    if (cursor) await sleep(350);
  } while (cursor);
  return out;
}

// 페이지 본문을 텍스트 줄 배열로. 실제 지침/사례 내용이 여기 들어있다.
async function pageLines(pageId) {
  const lines = [];
  let cursor;
  do {
    const qs = cursor ? `?page_size=100&start_cursor=${cursor}` : '?page_size=100';
    const d = await notion(`/blocks/${pageId}/children${qs}`);
    for (const b of d.results || []) {
      const c = b[b.type];
      if (!c || !c.rich_text) continue;
      const t = c.rich_text.map((x) => x.plain_text).join('');
      if (t.trim()) lines.push(t);
    }
    cursor = d.has_more ? d.next_cursor : null;
    if (cursor) await sleep(350);
  } while (cursor);
  return lines;
}

// 헤딩으로 섹션을 나눠, '커밍쏜' 이 들어간 섹션을 최우선 기준으로 앞세운다.
// 기존 api/feedback.js 의 플레이북 파싱 규칙과 동일하게 맞췄다.
async function pageAnswer(pageId) {
  const secs = {};
  let cur = '';
  let cursor;
  do {
    const qs = cursor ? `?page_size=100&start_cursor=${cursor}` : '?page_size=100';
    const d = await notion(`/blocks/${pageId}/children${qs}`);
    for (const b of d.results || []) {
      if (b.type.startsWith('heading')) {
        cur = ((b[b.type] || {}).rich_text || []).map((t) => t.plain_text).join('').trim();
        continue;
      }
      const c = b[b.type];
      if (!c || !c.rich_text) continue;
      const t = c.rich_text.map((x) => x.plain_text).join('');
      if (t) (secs[cur] = secs[cur] || []).push(t);
    }
    cursor = d.has_more ? d.next_cursor : null;
    if (cursor) await sleep(350);
  } while (cursor);

  const boss = Object.keys(secs).filter((k) => k.includes('커밍쏜')).map((k) => secs[k].join('\n')).join('\n').trim();
  const rest = Object.keys(secs).filter((k) => !k.includes('커밍쏜')).map((k) => secs[k].join('\n')).join('\n').trim();
  return (boss ? '[커밍쏜 피드백 — 이 내용을 최우선 기준으로 삼을 것]\n' + boss + '\n\n' : '') + rest;
}

const title = (p, k) => (p.properties?.[k]?.title || []).map((t) => t.plain_text).join('');
const text = (p, k) => (p.properties?.[k]?.rich_text || []).map((t) => t.plain_text).join('');
const select = (p, k) => p.properties?.[k]?.select?.name || '';
const multi = (p, k) => (p.properties?.[k]?.multi_select || []).map((o) => o.name);
const check = (p, k) => !!p.properties?.[k]?.checkbox;
const num = (p, k) => (typeof p.properties?.[k]?.number === 'number' ? p.properties[k].number : null);
const url = (p, k) => p.properties?.[k]?.url || '';
const created = (p) => (p.created_time ? Date.parse(p.created_time) : Date.now());

// ─── Firestore ───────────────────────────────────────────────────────────────
function initDb() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT 가 설정되지 않았습니다');
  let txt = raw;
  if (!txt.startsWith('{')) txt = Buffer.from(raw, 'base64').toString('utf-8');
  const sa = JSON.parse(txt);
  if (sa.private_key?.includes('\\n')) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  if (!getApps().length) initializeApp({ credential: cert(sa), projectId: sa.project_id });
  return getFirestore();
}

async function writeAll(db, col, docs) {
  if (DRY) return docs.length;
  let n = 0;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    for (const d of docs.slice(i, i + 400)) {
      batch.set(db.collection(col).doc(d.id), { ...d.data, migratedAt: Date.now() }, { merge: true });
      n++;
    }
    await batch.commit();
  }
  return n;
}

// ─── 마이그레이터 ────────────────────────────────────────────────────────────
const migrators = {
  // 지침
  async guidelines() {
    const pages = await queryAll(DB.guidelines);
    const docs = [];
    for (const p of pages) {
      const body = await pageLines(p.id);
      docs.push({
        id: p.id,
        data: {
          section: select(p, '섹션'),
          category: select(p, '카테고리'),
          name: title(p, '이름'),
          order: num(p, '순서') ?? 0,
          active: check(p, '활성'),
          body,
          notionUrl: p.url || '',
        },
      });
      await sleep(350);
    }
    return docs;
  },

  // 팀 Q&A 플레이북
  async playbook() {
    const pages = await queryAll(DB.playbook);
    const docs = [];
    for (const p of pages) {
      const answer = await pageAnswer(p.id);
      docs.push({
        id: p.id,
        data: {
          question: title(p, '질문'),
          originalQuestion: text(p, '원본 질문'),
          answer,
          status: select(p, '상태'),
          type: select(p, '유형'),
          category: select(p, '카테고리'),
          director: select(p, '디렉터'),
          tone: select(p, '말투'),
          student: text(p, '수강생'),
          missionType: text(p, '미션유형'),
          createdAt: created(p),
          notionUrl: p.url || '',
          source: 'notion',
        },
      });
      await sleep(350);
    }
    return docs;
  },

  // 컨설팅 내용 — 디렉팅 사례 아카이브
  async cases() {
    const pages = await queryAll(DB.cases);
    const docs = [];
    for (const p of pages) {
      const body = (await pageLines(p.id)).join('\n');
      docs.push({
        id: p.id,
        data: {
          summary: title(p, '고민 요약'),
          body,
          director: select(p, '디렉터'),
          cohort: text(p, '기수'),
          round: text(p, '회차'),
          participants: text(p, '참여자'),
          aiApplied: check(p, 'AI반영'),
          confirmed: check(p, '커밍쏜컴펌'),
          createdAt: created(p),
          notionUrl: p.url || '',
        },
      });
      await sleep(350);
    }
    return docs;
  },

  // 자료 — 지식베이스 소스 관리
  // 페이지 본문에 원문 자막/전문이 들어 있다. 속성만 가져오면 정작 알맹이가 빠진다.
  async kbSources() {
    const pages = await queryAll(DB.kbSources);
    const docs = [];
    for (const p of pages) {
      const lines = await pageLines(p.id);
      // '원문 자막' 같은 헤딩 줄은 pageLines 가 이미 걸러낸다(heading 은 rich_text 를
      // 갖지만 본문과 섞이면 지저분해서 그대로 둔다 — 검색·보관 목적엔 무해).
      let transcript = lines.join('\n');

      // Firestore 문서 상한은 1MiB. 한글은 UTF-8 로 3바이트라 넉넉히 잘라둔다.
      const LIMIT = 900 * 1024;
      let truncated = false;
      if (Buffer.byteLength(transcript, 'utf8') > LIMIT) {
        // 바이트 기준으로 자르되 글자가 깨지지 않게 뒤에서 줄여나간다.
        let cut = transcript.length;
        while (cut > 0 && Buffer.byteLength(transcript.slice(0, cut), 'utf8') > LIMIT) {
          cut = Math.floor(cut * 0.95);
        }
        transcript = transcript.slice(0, cut);
        truncated = true;
      }

      docs.push({
        id: p.id,
        data: {
          name: title(p, '소스명'),
          sourceId: text(p, '소스ID'),
          type: select(p, '유형'),
          category: select(p, '카테고리'),
          status: select(p, '상태'),
          link: url(p, '원본링크'),
          chunks: num(p, '청크수') ?? 0,
          tags: multi(p, '태그'),
          memo: text(p, '메모'),
          addedAt: p.properties?.['추가일']?.date?.start || '',
          transcript,
          transcriptChars: transcript.length,
          transcriptTruncated: truncated,
          createdAt: created(p),
          notionUrl: p.url || '',
        },
      });
      await sleep(350);
    }
    return docs;
  },

  // 답변 품질 로그
  async ratings() {
    const pages = await queryAll(DB.ratings);
    const docs = [];
    for (const p of pages) {
      const body = (await pageLines(p.id)).join('\n');
      docs.push({
        id: p.id,
        data: {
          question: title(p, '질문'),
          answer: body,
          rating: select(p, '평가'),
          student: text(p, '수강생'),
          comment: text(p, '코멘트'),
          createdAt: created(p),
          notionUrl: p.url || '',
        },
      });
      await sleep(350);
    }
    return docs;
  },
};

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!NOTION_KEY) throw new Error('NOTION_API_KEY 가 설정되지 않았습니다');
  const db = DRY ? null : initDb();

  const names = Object.keys(migrators).filter((n) => !ONLY || ONLY.includes(n));
  if (!names.length) throw new Error('--only 값이 잘못됐습니다. 가능: ' + Object.keys(migrators).join(', '));

  console.log(DRY ? '── DRY RUN (쓰지 않음) ──\n' : '── Notion → Firestore 마이그레이션 ──\n');
  const summary = [];

  for (const name of names) {
    process.stdout.write(`${name} … `);
    try {
      const docs = await migrators[name]();
      const written = await writeAll(db, name, docs);
      const empty = docs.filter((d) => {
        const b = d.data.body ?? d.data.answer ?? d.data.transcript;
        return Array.isArray(b) ? b.length === 0 : !b;
      }).length;
      console.log(`${docs.length}건 읽음 → ${DRY ? '0' : written}건 기록${empty ? ` (본문 없음 ${empty}건)` : ''}`);
      summary.push({ name, read: docs.length, written: DRY ? 0 : written, empty });
    } catch (e) {
      console.log('실패: ' + e.message);
      summary.push({ name, error: e.message });
    }
  }

  console.log('\n── 요약 ──');
  for (const s of summary) {
    console.log(s.error ? `  ❌ ${s.name}: ${s.error}` : `  ✅ ${s.name}: 읽기 ${s.read} / 기록 ${s.written}`);
  }
  if (DRY) console.log('\n실제로 반영하려면 --dry-run 을 빼고 다시 실행하세요.');
  if (summary.some((s) => s.error)) process.exitCode = 1;
}

main().catch((e) => {
  console.error('\n마이그레이션 중단:', e.message);
  process.exit(1);
});
