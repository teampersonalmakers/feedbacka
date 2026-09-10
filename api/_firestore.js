// ─────────────────────────────────────────────────────────────────────────────
// api/_firestore.js — 서버사이드 Firestore 데이터 레이어 (Firebase Admin SDK)
//
// 이전에는 Notion 이 DB 였다. 이제 Firestore 가 정본이고 Notion 은 폴백이다.
//   가이드라인 / 플레이북 / 디렉팅 사례(컨설팅) / 수강생 이력  → 읽기
//   자동기록 / 평가 / 플레이북 초안                          → 쓰기
//
// 설계 원칙
//  1) 절대 throw 하지 않는다. 자격증명이 없거나 실패하면 null / [] 을 돌려주고,
//     호출부가 기존 Notion 경로로 폴백한다. 배포 순서에 상관없이 앱이 살아있다.
//  2) 서버리스 인스턴스 간 캐시는 공유되지 않는다. TTL 5분은 Notion 시절과 동일해
//     "수정 후 5분 내 반영" 이라는 기존 운영 약속이 그대로 유지된다.
//  3) Admin SDK 는 보안 규칙을 우회한다. 그래서 이 컬렉션들은 firestore.rules 에서
//     클라이언트에게 전면 차단돼 있어도 서버는 읽고 쓸 수 있다.
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

export const COL = {
  guidelines: 'guidelines',   // 지침
  playbook: 'playbook',       // 팀 Q&A 플레이북
  cases: 'cases',             // 디렉팅 사례 아카이브 (컨설팅 내용)
  kbSources: 'kbSources',     // 지식베이스 소스 관리 (자료 목록)
  ratings: 'ratings',         // 답변 품질 로그
  history: 'history',         // 자동 대화 기록
  metrics: 'metrics',         // 요청별 성능 지표 (지연·토큰·캐시·참조소스)
  chunks: 'chunks',           // 지식베이스 청크 + 벡터 (findNearest 대상)
};

const TTL = 5 * 60 * 1000;

let _db = null;
let _initTried = false;

// 서비스 계정: 원문 JSON 과 base64 를 모두 받는다.
// 붙여넣는 과정에서 개행이 섞이거나 앞뒤가 잘리는 일이 잦아서, 가능한 해석을
// 순서대로 다 시도한 뒤 실패하면 값이 아니라 "형태"만 로그로 남긴다.
function readServiceAccount() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) return null;

  const candidates = [];
  if (raw.startsWith('{')) candidates.push(raw);

  // base64 — 줄바꿈·공백이 섞여 들어와도 되도록 먼저 걷어낸다.
  const b64 = raw.replace(/\s+/g, '');
  if (b64 && /^[A-Za-z0-9+/=_-]+$/.test(b64)) {
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf-8');
      if (decoded.trimStart().startsWith('{')) candidates.push(decoded);
    } catch (e) { /* base64 아님 */ }
  }

  // JSON 앞뒤에 따옴표나 잡문자가 붙은 경우
  const braced = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  if (braced.startsWith('{') && !candidates.includes(braced)) candidates.push(braced);

  for (const text of candidates) {
    try {
      const sa = JSON.parse(text);
      if (!sa.private_key || !sa.client_email) continue;
      // Vercel UI 에 붙여넣으면 개행이 \n 문자열로 들어오는 경우가 흔하다.
      if (sa.private_key.indexOf('\\n') >= 0) {
        sa.private_key = sa.private_key.replace(/\\n/g, '\n');
      }
      return sa;
    } catch (e) { /* 다음 후보 */ }
  }

  // 값 자체는 절대 찍지 않는다. 어떤 형태로 들어왔는지만 남긴다.
  console.warn(
    '[Firestore] FIREBASE_SERVICE_ACCOUNT 를 해석할 수 없습니다. ' +
    `길이=${raw.length}, 시작문자=${JSON.stringify(raw.slice(0, 1))}, ` +
    `공백포함=${/\s/.test(raw)}, base64형태=${/^[A-Za-z0-9+/=\s_-]+$/.test(raw)}. ` +
    '서비스 계정 JSON 원문을 그대로 넣거나, base64 로 넣을 경우 줄바꿈 없이(base64 -w0) 넣어주세요.'
  );
  return null;
}

export function getDb() {
  if (_db || _initTried) return _db;
  _initTried = true;
  try {
    if (!getApps().length) {
      const sa = readServiceAccount();
      if (!sa) {
        console.warn('[Firestore] 서비스 계정 없음 — Notion 폴백으로 동작합니다.');
        return null;
      }
      initializeApp({ credential: cert(sa), projectId: sa.project_id });
    }
    _db = getFirestore();
    return _db;
  } catch (e) {
    console.warn('[Firestore] 초기화 실패 — Notion 폴백:', e.message);
    return null;
  }
}

export const firestoreEnabled = () => !!getDb();

// ─── 캐시 ────────────────────────────────────────────────────────────────────
const cache = new Map();
function cached(key) {
  const c = cache.get(key);
  return c && Date.now() - c.ts < TTL ? c.value : undefined;
}
function put(key, value) {
  cache.set(key, { ts: Date.now(), value });
  return value;
}
function stale(key) {
  const c = cache.get(key);
  return c ? c.value : null;   // TTL 이 지나도, 조회 실패보다는 옛 값이 낫다.
}

// ─── 읽기: 가이드라인(지침) ──────────────────────────────────────────────────
// Notion 로더와 완전히 같은 형태를 돌려준다 — 호출부를 바꾸지 않기 위해서.
export async function loadGuidelines() {
  const hit = cached('guidelines');
  if (hit !== undefined) return hit;
  const db = getDb();
  if (!db) return null;
  try {
    const snap = await db.collection(COL.guidelines).where('active', '==', true).get();
    if (snap.empty) return put('guidelines', null);

    const rows = snap.docs.map((d) => d.data());
    rows.sort((a, b) => (a.order || 0) - (b.order || 0));

    const g = {};
    for (const r of rows) {
      const body = Array.isArray(r.body) ? r.body.filter(Boolean) : (r.body ? [r.body] : []);
      switch (r.section) {
        case 'persona':   g.persona = body.join('\n\n'); break;
        case 'philosophy': g.corePhilosophy = body; break;
        case 'tone':      g.toneGuide = body.join('\n'); break;
        case 'freeGuide': g.freeGuidelines = body.join('\n'); break;
        case 'doNotDo':   g.doNotDo = body; break;
        case 'category':
          if (!g.categoryGuidelines) g.categoryGuidelines = {};
          g.categoryGuidelines[r.category] = { name: r.name || r.category, rules: body };
          break;
      }
    }
    console.log('[Firestore] 가이드라인 로드:', Object.keys(g).join(', ') || '(빈 값)');
    return put('guidelines', g.persona ? g : null);
  } catch (e) {
    console.warn('[Firestore] 가이드라인 로드 실패:', e.message);
    return stale('guidelines');
  }
}

// ─── 읽기: 플레이북 (승인된 Q&A) ─────────────────────────────────────────────
export async function loadPlaybook() {
  const hit = cached('playbook');
  if (hit !== undefined) return hit;
  const db = getDb();
  if (!db) return null;
  try {
    const snap = await db.collection(COL.playbook).where('status', '==', '승인').limit(100).get();
    const items = snap.docs
      .map((d) => d.data())
      .map((r) => ({ q: r.question || '', category: r.category || '', answer: r.answer || '' }))
      .filter((i) => i.q && i.answer);
    console.log('[Firestore] 플레이북 로드:', items.length + '건');
    return put('playbook', items);
  } catch (e) {
    console.warn('[Firestore] 플레이북 로드 실패:', e.message);
    return stale('playbook');
  }
}

// ─── 읽기: 디렉팅 사례 아카이브 (컨설팅 내용) ────────────────────────────────
// Notion 의 'AI반영' 체크가 켜진 것만 쓴다 — 팀이 이미 큐레이션해 둔 기준을 그대로 따른다.
export async function loadCases() {
  const hit = cached('cases');
  if (hit !== undefined) return hit;
  const db = getDb();
  if (!db) return null;
  try {
    const snap = await db.collection(COL.cases).where('aiApplied', '==', true).limit(200).get();
    const items = snap.docs
      .map((d) => d.data())
      .map((r) => ({
        summary: r.summary || '',
        body: r.body || '',
        director: r.director || '',
        cohort: r.cohort || '',
        confirmed: !!r.confirmed,
      }))
      .filter((i) => i.summary && i.body);
    console.log('[Firestore] 디렉팅 사례 로드:', items.length + '건');
    return put('cases', items);
  } catch (e) {
    console.warn('[Firestore] 디렉팅 사례 로드 실패:', e.message);
    return stale('cases');
  }
}

// 질문과 겹치는 2글자 이상 토큰 수로 사례를 고른다.
// 임베딩을 쓸 만큼 건수가 많지 않고(수십 건), 매 요청마다 임베딩 API 를 때리는
// 비용이 이득보다 크다.
export function pickCases(cases, question, topK = 3) {
  if (!cases || !cases.length || !question) return [];
  const tokens = new Set(
    String(question).toLowerCase().split(/[^가-힣a-z0-9]+/).filter((t) => t.length >= 2)
  );
  if (!tokens.size) return [];
  const scored = cases.map((c) => {
    const hay = (c.summary + ' ' + c.body).toLowerCase();
    let score = 0;
    for (const t of tokens) if (hay.indexOf(t) >= 0) score++;
    // 커밍쏜이 직접 컴펌한 사례를 우선한다.
    if (c.confirmed) score *= 1.2;
    return { c, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => s.c);
}

// ─── 읽기: 수강생 최근 상담 이력 ─────────────────────────────────────────────
// 두 곳을 합쳐 본다:
//   history  — 앱에서 디렉터가 상담할 때마다 자동으로 쌓이는 기록 (addHistory)
//   playbook — 노션에서 옮겨온 과거 Q&A + 디렉터가 직접 등록한 것
// 예전에는 playbook 만 읽어서, 앱에서 5번 상담해도 6번째에 그 5번을 몰랐다.
export async function loadStudentHistory(name) {
  if (!name) return '';
  const key = 'stu:' + name;
  const hit = cached(key);
  if (hit !== undefined) return hit;
  const db = getDb();
  if (!db) return null;
  try {
    // createdAt 정렬은 복합 인덱스를 요구하므로, 적게 가져와 메모리에서 정렬한다.
    const [h, p] = await Promise.all([
      db.collection(COL.history).where('student', '==', name).limit(20).get(),
      db.collection(COL.playbook).where('student', '==', name).limit(20).get(),
    ]);
    const rows = [...h.docs, ...p.docs]
      .map((d) => d.data())
      .filter((r) => r.question || r.originalQuestion)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 3);
    if (!rows.length) return put(key, '');
    const parts = rows.map((r) => {
      const q = (r.originalQuestion || r.question || '').slice(0, 300);
      const a = (r.answer || '').slice(0, 500);
      const when = r.createdAt ? new Date(r.createdAt).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' }) : '';
      return '과거 질문' + (when ? ' (' + when + ')' : '') + ': ' + q + (a ? '\n당시 답변 요약: ' + a : '');
    });
    return put(key, '[' + name + ' 수강생의 최근 상담 기록 — 이 맥락을 이어서 답변할 것]\n' + parts.join('\n---\n'));
  } catch (e) {
    console.warn('[Firestore] 수강생 이력 로드 실패:', e.message);
    return stale(key);
  }
}

// ─── 쓰기 ────────────────────────────────────────────────────────────────────
// 실패해도 예외를 던지지 않는다. 기록 실패로 사용자 요청 자체가 깨지면 안 된다.
async function add(col, data) {
  const db = getDb();
  if (!db) return null;
  try {
    const ref = await db.collection(col).add({
      ...data,
      createdAt: Date.now(),
      createdAtServer: FieldValue.serverTimestamp(),
    });
    return ref.id;
  } catch (e) {
    console.warn('[Firestore] ' + col + ' 쓰기 실패:', e.message);
    return null;
  }
}

const cut = (v, n) => String(v == null ? '' : v).slice(0, n);

// 자동 대화 기록 (기존 api/history.js → Notion '자동기록')
export function addHistory({ question, answer, student, missionType, mode, type }) {
  return add(COL.history, {
    question: cut(question, 60000),
    answer: cut(answer, 200000),
    student: cut(student, 190),
    missionType: cut(missionType, 190),
    mode: mode === 'conv' ? '구어체' : '문어체',
    type: type === 'followup' ? '재질문' : '피드백',
    status: '자동기록',
  });
}

// 답변 평가 (기존 api/rate.js → Notion '답변 품질 로그')
export function addRating({ question, answer, rating, student, comment }) {
  return add(COL.ratings, {
    question: cut(question, 60000),
    answer: cut(answer, 200000),
    rating: rating === 'up' ? '좋음' : '아쉬움',
    student: cut(student, 190),
    comment: cut(comment, 1900),
  });
}

// 요청별 성능 지표. 개선 전후를 숫자로 비교하기 위한 것.
// 답변 본문은 넣지 않는다 — history 가 이미 갖고 있고, 여기는 가볍게 유지한다.
export function addMetrics(m) {
  return add(COL.metrics, {
    cold: !!m.cold,
    ok: m.ok !== false,
    error: cut(m.error || '', 300),
    model: cut(m.model || '', 60),
    mode: cut(m.mode || '', 20),
    category: cut(m.category || '', 40),
    chat: !!m.chat,
    student: cut(m.student || '', 100),
    questionChars: m.questionChars || 0,
    answerChars: m.answerChars || 0,
    timings: m.timings || {},
    usage: m.usage || {},
    sources: m.sources || {},
  });
}

// "AI 학습시키기" — 검수 대기 초안 (기존 api/playbook.js)
export function addPlaybookDraft({ question, answer, category }) {
  return add(COL.playbook, {
    question: cut(question, 60000),
    originalQuestion: cut(question, 60000),
    answer: cut(answer, 200000),
    category: cut(category, 100),
    status: '답변작성',   // 승인 전까지는 프롬프트에 들어가지 않는다
    type: '수동등록',
    source: 'app',
  });
}
