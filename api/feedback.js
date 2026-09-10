import fs from 'fs';
import path from 'path';
import {
  loadGuidelines as fsLoadGuidelines,
  loadPlaybook as fsLoadPlaybook,
  loadCases as fsLoadCases,
  loadStudentHistory as fsLoadStudentHistory,
  pickCases,
  firestoreEnabled,
  addMetrics,
} from './_firestore.js';
import { claudeHeaders, claudeBody, cachedBlock, pickText } from './_claude.js';
import { embedQuery, searchChunks, countChunks } from './_vectors.js';

// 이 인스턴스가 첫 요청을 받는 중인지. 콜드스타트 지연을 따로 보기 위해서다.
let _coldInstance = true;

export const config = { supportsResponseStreaming: true };

// ─── 서버사이드 KB 캐시 ───────────────────────────────────────────────────────
let _kbCache = null;
function loadKB() {
  if (_kbCache) return _kbCache;
  try {
    const p = path.join(process.cwd(), 'knowledge', 'base.json');
    const kb = JSON.parse(fs.readFileSync(p, 'utf-8'));
    try {
      const p2 = path.join(process.cwd(), 'knowledge', 'base2.json');
      const kb2 = JSON.parse(fs.readFileSync(p2, 'utf-8'));
      if (kb2 && kb2.documents) {
        kb.documents = (kb.documents || []).concat(kb2.documents);
        kb.totalChunks = (kb.totalChunks || 0) + (kb2.totalChunks || 0);
      }
    } catch(e2) {
      console.warn('base2.json 로드 실패(무시):', e2.message);
    }
    for (let bi = 3; bi <= 30; bi++) {
      try {
        const pn = path.join(process.cwd(), 'knowledge', 'base' + bi + '.json');
        if (!fs.existsSync(pn)) continue;
        const kbn = JSON.parse(fs.readFileSync(pn, 'utf-8'));
        if (kbn && kbn.documents) {
          kb.documents = (kb.documents || []).concat(kbn.documents);
          kb.totalChunks = (kb.totalChunks || 0) + (kbn.totalChunks || 0);
        }
      } catch(eN) {
        console.warn('base' + bi + '.json 로드 실패(무시):', eN.message);
      }
    }
    _kbCache = kb;
    return _kbCache;
  } catch(e) {
    console.warn('base.json 로드 실패:', e.message);
    return null;
  }
}

// ─── Cosine Similarity ───────────────────────────────────────────────────────
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

// ─── Retrieve ────────────────────────────────────────────────────────────────
function retrieve(kb, queryVec, topK = 6) {
  if (!kb || !kb.documents) return [];
  const results = [];
  for (const doc of kb.documents) {
    for (const chunk of (doc.chunks || [])) {
      if (!chunk.embedding) continue;
      results.push({ docName: doc.name, docType: doc.type, text: chunk.text, score: cosineSim(queryVec, chunk.embedding) });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, topK);
}

// ─── Gemini Embed ────────────────────────────────────────────────────────────
async function embedText(text, geminiKey) {
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-embedding-001:embedContent?key=${geminiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'models/gemini-embedding-001', content: { parts: [{ text }] }, taskType: 'RETRIEVAL_QUERY' }),
  });
  const data = await res.json();
  if (data.error) throw new Error('Gemini: ' + data.error.message);
  return data.embedding.values;
}

// ─── Notion 가이드라인 로드 (캐시 포함) ─────────────────────────────────────────
let _guidelinesCache = null;
let _guidelinesCacheTime = 0;
const GUIDELINES_TTL = 5 * 60 * 1000; // 5분

async function loadGuidelinesFromNotion(notionKey) {
  const now = Date.now();
  if (_guidelinesCache && (now - _guidelinesCacheTime) < GUIDELINES_TTL) {
    return _guidelinesCache;
  }

  try {
    const NOTION_DB_ID = process.env.NOTION_DB_ID || 'f1bf4e3893b445eda779d32ec464d4e8';

    // 1단계: DB 쿼리 — 활성화된 항목만, 순서대로
    const queryRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${notionKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filter: { property: '활성', checkbox: { equals: true } },
        sorts: [{ property: '순서', direction: 'ascending' }]
      })
    });

    if (!queryRes.ok) throw new Error(`Notion DB 쿼리 실패: ${queryRes.status}`);
    const queryData = await queryRes.json();

    // 2단계: 모든 페이지의 블록 콘텐츠를 병렬로 가져오기
    const pagesWithContent = await Promise.all(
      queryData.results.map(async (page) => {
        const blocksRes = await fetch(`https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`, {
          headers: {
            'Authorization': `Bearer ${notionKey}`,
            'Notion-Version': '2022-06-28'
          }
        });
        if (!blocksRes.ok) return { page, blocks: [] };
        const blocksData = await blocksRes.json();
        return { page, blocks: blocksData.results || [] };
      })
    );

    // 3단계: guidelines 형식으로 파싱
    const g = {};
    for (const { page, blocks } of pagesWithContent) {
      const props = page.properties;
      const section = props['섹션']?.select?.name || '';
      const category = props['카테고리']?.select?.name || '';
      const name = props['이름']?.title?.[0]?.plain_text || '';

      // 블록에서 텍스트 추출
      const textItems = blocks.map(block => {
        const content = block[block.type];
        if (!content?.rich_text) return '';
        return content.rich_text.map(t => t.plain_text).join('');
      }).filter(Boolean);

      switch (section) {
        case 'persona':
          g.persona = textItems.join('\n\n');
          break;
        case 'philosophy':
          g.corePhilosophy = textItems;
          break;
        case 'tone':
          g.toneGuide = textItems.join('\n');
          break;
        case 'category':
          if (!g.categoryGuidelines) g.categoryGuidelines = {};
          g.categoryGuidelines[category] = { name, rules: textItems };
          break;
        case 'freeGuide':
          g.freeGuidelines = textItems.join('\n');
          break;
        case 'doNotDo':
          g.doNotDo = textItems;
          break;
      }
    }

    _guidelinesCache = g;
    _guidelinesCacheTime = now;
    console.log('Notion 가이드라인 로드 완료:', Object.keys(g).join(', '));
    return g;
  } catch (e) {
    const cause = e.cause ? ` | cause: ${e.cause.message || JSON.stringify(e.cause)}` : '';
    console.warn('Notion guidelines load failed:', e.message + cause);
    if (_guidelinesCache) return _guidelinesCache; // 캐시된 데이터라도 반환
    return null;
  }
}

// ─── 플레이북(Q&A) 캐시 ─────────────────────────────────────────────────────
let _playbookCache = null;
let _playbookCacheTime = 0;
const PLAYBOOK_TTL = 5 * 60 * 1000;

async function loadPlaybookFromNotion(notionKey) {
  notionKey = (notionKey || '').trim();
  const now = Date.now();
  if (_playbookCache && (now - _playbookCacheTime) < PLAYBOOK_TTL) return _playbookCache;
  try {
    const PLAYBOOK_DB_ID = (process.env.PLAYBOOK_DB_ID || '3b9818e3e2c94735b9f1d1c75bf73ff2').trim();
    const queryRes = await fetch(`https://api.notion.com/v1/databases/${PLAYBOOK_DB_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${notionKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filter: { property: '상태', select: { equals: '승인' } },
        page_size: 100
      })
    });
    if (!queryRes.ok) throw new Error(`플레이북 DB 쿼리 실패: ${queryRes.status}`);
    const queryData = await queryRes.json();

    const items = await Promise.all(
      (queryData.results || []).map(async (page) => {
        const q = page.properties?.['질문']?.title?.map(t => t.plain_text).join('') || '';
        const category = page.properties?.['카테고리']?.select?.name || '';
        let answer = '';
        const blocksRes = await fetch(`https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`, {
          headers: { 'Authorization': `Bearer ${notionKey}`, 'Notion-Version': '2022-06-28' }
        });
        if (blocksRes.ok) {
          const blocksData = await blocksRes.json();
          const _blocks = blocksData.results || [];
          const _secs = {};
          let _cur = '';
          for (const block of _blocks) {
            if (block.type.startsWith('heading')) {
              _cur = ((block[block.type] || {}).rich_text || []).map(t => t.plain_text).join('').trim();
              continue;
            }
            const content = block[block.type];
            if (!content || !content.rich_text) continue;
            const txt = content.rich_text.map(t => t.plain_text).join('');
            if (txt) (_secs[_cur] = _secs[_cur] || []).push(txt);
          }
          const _boss = Object.keys(_secs).filter(k => k.indexOf('커밍쏜') >= 0).map(k => _secs[k].join('\n')).join('\n').trim();
          const _rest = Object.keys(_secs).filter(k => k.indexOf('커밍쏜') < 0).map(k => _secs[k].join('\n')).join('\n').trim();
          answer = (_boss ? '[커밍쏜 피드백 — 이 내용을 최우선 기준으로 삼을 것]\n' + _boss + '\n\n' : '') + _rest;
        }
        return { q, category, answer };
      })
    );

    _playbookCache = items.filter(i => i.q && i.answer);
    _playbookCacheTime = now;
    console.log('플레이북 로드 완료:', _playbookCache.length + '건');
    return _playbookCache;
  } catch (e) {
    console.warn('플레이북 로드 실패:', e.message);
    return _playbookCache || [];
  }
}

// 로컬 파일 폴백
function loadGuidelinesFromFile() {
  try {
    const gPath = path.join(process.cwd(), 'knowledge', 'guidelines.json');
    return JSON.parse(fs.readFileSync(gPath, 'utf-8'));
  } catch(e) {
    console.warn('guidelines.json 로드 실패');
    return {};
  }
}

let _stuCache = {};
async function loadStudentHistory(key, name) {
  const now = Date.now();
  const c = _stuCache[name];
  if (c && now - c.ts < 5 * 60 * 1000) return c.text;
  const DB = (process.env.PLAYBOOK_DB_ID || '3b9818e3e2c94735b9f1d1c75bf73ff2').trim();
  const r = await fetch(`https://api.notion.com/v1/databases/${DB}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ filter: { property: '수강생', rich_text: { equals: name } }, sorts: [{ property: '등록일', direction: 'descending' }], page_size: 4 })
  });
  if (!r.ok) return '';
  const d = await r.json();
  const rows = (d.results || []).slice(0, 3);
  if (!rows.length) { _stuCache[name] = { ts: now, text: '' }; return ''; }
  const parts = [];
  for (const pg of rows) {
    const props = pg.properties || {};
    const q = ((props['원본 질문'] || {}).rich_text || []).map(t => t.plain_text).join('') || ((props['질문'] || {}).title || []).map(t => t.plain_text).join('');
    let ans = '';
    try {
      const br = await fetch(`https://api.notion.com/v1/blocks/${pg.id}/children?page_size=50`, { headers: { Authorization: `Bearer ${key}`, 'Notion-Version': '2022-06-28' } });
      if (br.ok) {
        const bd = await br.json();
        ans = (bd.results || []).filter(b => !b.type.startsWith('heading')).map(b => { const cc = b[b.type]; return cc && cc.rich_text ? cc.rich_text.map(t => t.plain_text).join('') : ''; }).filter(Boolean).join('\n');
      }
    } catch(e) {}
    parts.push('과거 질문: ' + q.slice(0, 300) + (ans ? '\n당시 답변 요약: ' + ans.slice(0, 500) : ''));
  }
  const text = '[' + name + ' 수강생의 최근 상담 기록 — 이 맥락을 이어서 답변할 것]\n' + parts.join('\n---\n');
  _stuCache[name] = { ts: now, text };
  return text;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: KB 상태 확인 ──────────────────────────────────────────────────────
  if (req.method === 'GET') {
    // 청크 수는 Firestore 를 우선 센다(파일 80MB 를 읽지 않기 위해). 없으면 파일로.
    let total = 0, docCount = 0, chunkSource = 'file';
    try {
      if (firestoreEnabled()) { total = await countChunks(); chunkSource = 'firestore'; }
    } catch (e) { console.warn('chunks count 실패:', e.message); }
    if (!total) {
      const kb = loadKB();
      if (!kb) return res.status(200).json({ status: 'error', message: '지식베이스 로드 실패' });
      total = (kb.documents || []).reduce((s, d) => s + (d.chunks || []).length, 0);
      docCount = (kb.documents || []).length;
      chunkSource = 'file';
    }

    // 어떤 저장소에서 무엇을 읽고 있는지 그대로 보여준다.
    // 배포 후 환경변수가 실제로 먹었는지 확인하는 용도.
    // 값은 절대 노출하지 않고 설정 여부(boolean)만 담는다.
    const fsOn = firestoreEnabled();
    const g = fsOn ? await fsLoadGuidelines() : null;
    const pb = fsOn ? await fsLoadPlaybook() : null;
    const cs = fsOn ? await fsLoadCases() : null;

    let notionPlaybookCount = 0;
    if (process.env.NOTION_API_KEY) {
      notionPlaybookCount = (await loadPlaybookFromNotion(process.env.NOTION_API_KEY)).length;
    }

    return res.status(200).json({
      status: 'ok',
      docCount,
      chunkCount: total,
      playbookCount: (pb && pb.length) || notionPlaybookCount,
      env: {
        CLAUDE_API_KEY: !!process.env.CLAUDE_API_KEY,
        GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
        FIREBASE_SERVICE_ACCOUNT: !!process.env.FIREBASE_SERVICE_ACCOUNT,
        NOTION_API_KEY: !!process.env.NOTION_API_KEY,
      },
      firestore: {
        enabled: fsOn,
        guidelines: g ? Object.keys(g.categoryGuidelines || {}).length + 6 : 0,
        hasPersona: !!(g && g.persona),
        playbook: (pb || []).length,
        cases: (cs || []).length,
      },
      source: {
        chunks: chunkSource,
        guidelines: g && g.persona ? 'firestore' : (process.env.NOTION_API_KEY ? 'notion' : 'file'),
        playbook: pb && pb.length ? 'firestore' : (notionPlaybookCount ? 'notion' : 'none'),
      },
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!CLAUDE_KEY) return res.status(500).json({ error: 'CLAUDE_API_KEY not configured' });

  let { question, category, mode, isPublic, studentName, extraContext, creatorOptions } = req.body;

  // ── 계측 ───────────────────────────────────────────────────────────────────
  const T0 = Date.now();
  const cold = _coldInstance; _coldInstance = false;
  const M = {
    cold, mode, category, chat: !!(req.body && req.body.chat), student: String(studentName || '').trim(),
    questionChars: String(question || '').length,
    timings: {}, usage: {}, sources: { rag: [], cases: 0, playbook: 0, studentMemory: false },
  };
  const mark = (k) => { M.timings[k] = Date.now() - T0; };
  function logMetrics(extra) {
    M.timings.total = Date.now() - T0;
    addMetrics(Object.assign(M, extra || {})).catch(() => {});
  }

  // ─── 서버사이드 RAG 검색 ─────────────────────────────────────────────────────
  // ─── 수강생 기억: 과거 상담 기록 자동 로드 ───
  const NOTION_KEY_S = (process.env.NOTION_API_KEY || '').trim();
  if (studentName && String(studentName).trim()) {
    try {
      const _name = String(studentName).trim();
      // Firestore 정본 → 없으면(null) Notion 폴백. 빈 문자열은 "기록 없음"이라 폴백하지 않는다.
      let stuCtx = await fsLoadStudentHistory(_name);
      if (stuCtx === null) stuCtx = NOTION_KEY_S ? await loadStudentHistory(NOTION_KEY_S, _name) : '';
      if (stuCtx) { extraContext = (extraContext ? extraContext + '\n\n' : '') + stuCtx; M.sources.studentMemory = true; }
    } catch(e) { console.warn('수강생 기록 로드 실패(무시):', e.message); }
  }

  let hits = [];
  if (GEMINI_KEY && question) {
    const q = String(req.body.searchQuery || question);
    try {
      // 1순위: Firestore 벡터 검색. 파일을 읽지 않으니 콜드스타트에 80MB 파싱이 빠진다.
      if (firestoreEnabled()) {
        const queryVec = await embedQuery(q, GEMINI_KEY);
        mark('embed');
        hits = await searchChunks(queryVec, 6);
        mark('retrieve');
        M.sources.ragBackend = 'firestore';
      } else {
        throw new Error('Firestore 미설정');
      }
    } catch (e) {
      // 인덱스가 아직 없거나(FAILED_PRECONDITION) 청크가 안 올라간 경우 파일로 폴백.
      console.warn('벡터 검색 실패 → 파일 폴백:', e.message);
      try {
        const kb = loadKB();
        mark('kbLoad');
        if (kb) {
          const queryVec = await embedText(q, GEMINI_KEY);
          mark('embed');
          hits = retrieve(kb, queryVec, 6);
          mark('retrieve');
          M.sources.ragBackend = 'file';
        }
      } catch (e2) {
        console.warn('RAG 검색 실패 (계속 진행):', e2.message);
      }
    }
    M.sources.rag = hits.map((h) => h.docName).filter(Boolean);
  }

  // ── Creator 모드 ──────────────────────────────────────────────────────────────
  if (category === 'creator' && creatorOptions) {
    const { outputList, typeStr, channelData, scriptContext } = creatorOptions;
    const direction = extraContext || '';

    const creatorSystem = `당신은 커밍쏜 유튜브 채널의 콘텐츠 기획 전문 AI입니다.
커밍쏜의 실제 대본과 채널 데이터를 완전히 학습했으며, 커밍쏜의 말투, 가치관, 콘텐츠 구조를 깊이 이해합니다.
핵심: 솔직하고 직접적, 현실 기반, 숫자와 데이터 활용, 정보보다 감정과 서사 중심, 나만의 이야기 강조.`;

    const contextStr = hits.length > 0
      ? hits.map((h, i) => `[참고 ${i+1} — ${h.docName}]\n${h.text}`).join('\n\n---\n\n')
      : scriptContext;

    const creatorPrompt = `${channelData}

[실제 커밍쏜 대본 관련 내용]
${contextStr}

---
소재: ${question}
유형: ${typeStr}
${direction ? '방향: ' + direction : ''}
요청: ${outputList.join(', ')}

${outputList.includes('제목 후보 5개') ? `## 🎯 제목 후보 (5개)
채널 잘된 패턴 활용. 각 제목마다 클릭 이유 한 줄.
형식:
1. [제목]
→ [클릭 이유]
` : ''}
${outputList.includes('대본 구조') ? `## 📝 대본 구조
실제 커밍쏜 대본 구조 참고. 파트명 / 시간 / 핵심 내용 / 예시 멘트(커밍쏜 말투)
` : ''}
${outputList.includes('썸네일 아이디어') ? `## 🖼 썸네일 아이디어 (3개)
각각: 배경/분위기, 메인 텍스트, 서브 텍스트, 인물 포즈, 클릭 이유
` : ''}`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: claudeHeaders(CLAUDE_KEY),
        body: claudeBody(creatorSystem, creatorPrompt, { maxTokens: 8000, effort: 'medium' }),
      });
      const data = await response.json();
      if (data.error) throw new Error('Claude: ' + data.error.message);
      return res.status(200).json({ feedback: pickText(data), sources: hits });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── 피드백 모드 ───────────────────────────────────────────────────────────────
  const NOTION_KEY = (process.env.NOTION_API_KEY || '').trim();
  let g = {};

  // 가이드라인: Firestore(정본) → Notion(폴백) → 로컬 파일(최후)
  g = (await fsLoadGuidelines()) || {};
  if (!g.persona && NOTION_KEY) {
    g = (await loadGuidelinesFromNotion(NOTION_KEY)) || {};
  }
  if (!g.persona) {
    g = loadGuidelinesFromFile();
  }

  // 플레이북(승인된 Q&A): Firestore → Notion
  let playbook = await fsLoadPlaybook();
  if (playbook === null && NOTION_KEY) {
    playbook = await loadPlaybookFromNotion(NOTION_KEY);
  }
  playbook = playbook || [];
  // 자동 평가(api/eval.js)가 서버 안에서 직접 호출할 때만 켜진다. 클라이언트 요청 본문으로는
  // 세울 수 없는 속성이라 외부에서 플레이북을 빼고 답하게 만들 수는 없다.
  if (req.__skipPlaybook) playbook = [];
  if (req.__eval) M.eval = true;

  // 디렉팅 사례 아카이브(컨설팅 내용) — Notion 에서 'AI반영' 체크된 것만.
  // 기존 코드에는 이 경로가 아예 없어서, 컴펌된 사례가 AI 에 닿지 않고 있었다.
  const allCases = (await fsLoadCases()) || [];
  const relevantCases = pickCases(allCases, question, 3);
  mark('firestore');
  M.sources.cases = relevantCases.length;
  M.sources.playbook = playbook.length;

  // 답변 근거 — 디렉터 화면에 "무엇을 보고 답했는지" 보여주기 위한 목록.
  // 본문은 짧게 잘라 보낸다(카드에서 펼쳐 볼 정도).
  const evidence = {
    sources: hits.map((h) => ({ docName: h.docName, docType: h.docType || '', score: Math.round((h.score || 0) * 100) / 100, text: String(h.text || '').slice(0, 600) })),
    cases: relevantCases.map((c) => ({ summary: c.summary || '', cohort: c.cohort || '', text: String(c.body || '').slice(0, 600) })),
    playbook: playbook.length,
    studentMemory: M.sources.studentMemory,
  };

  const corePhilosophy = (g.corePhilosophy || [
    '유튜브는 SNS가 아니라 비즈니스다. 채널은 브랜드고, 콘텐츠는 상품이다.',
    '나만의 라이프스타일을 콘텐츠에 전달하고, 이에 공감하는 사람들을 모아야 한다.',
    '감정을 남기는 콘텐츠를 만들어야 한다. 정보는 잊혀지지만 감정은 남는다.',
    '정보는 복제되지만, 서사는 절대 복제되지 않는다. 나만의 서사를 만들어야 한다.',
    '브랜딩은 더 덜어낼 수 없는 상태까지 걸어내야 완성된다.',
  ]).map((p, i) => `${i+1}. ${p}`).join('\n');

  const toneGuide = g.toneGuide || '직접적이고 핵심을 먼저 말합니다. 칭찬보다 구체적인 방향 제시를 우선합니다.';
  const categoryRules = category && g.categoryGuidelines?.[category]?.rules
    ? `\n[${g.categoryGuidelines[category].name} 피드백 지침]\n` + g.categoryGuidelines[category].rules.map(r => `- ${r}`).join('\n')
    : '';
  const doNotDo = (g.doNotDo || []).length > 0 ? '\n[절대 하지 말 것]\n' + g.doNotDo.map(d => `- ${d}`).join('\n') : '';
  const freeGuidelines = g.freeGuidelines ? `\n[추가 지침]\n${g.freeGuidelines}` : '';
  const personaBase = g.persona || '당신은 커밍쏜입니다. 유튜브 채널 성장과 콘텐츠 브랜딩 전문가입니다.';

  // 사례는 질문마다 달라진다. 시스템 프롬프트에 두면 캐시 프리픽스가 매번 깨지므로
  // 참고 자료와 함께 user 턴에 넣는다.
  const casesBlock = relevantCases.length > 0
    ? '\n\n[커밍쏜 디렉팅 사례 — 실제 컨설팅에서 나온 판단 기준]\n' +
      relevantCases.map((c, i) =>
        `사례 ${i + 1}. ${c.summary}${c.cohort ? ` (${c.cohort})` : ''}\n${String(c.body).slice(0, 1500)}`
      ).join('\n\n')
    : '';

  const playbookStr = playbook.length > 0
    ? '\n\n[팀 퍼메스 Q&A 플레이북]\n아래는 승인된 공식 Q&A입니다. 유사한 질문에는 이 답변의 내용과 기조를 우선 반영하세요.\n' +
      playbook.map((p, i) => `Q${i+1}. [${p.category}] ${p.q}\nA${i+1}. ${p.answer}`).join('\n\n')
    : '';

  // ── 시스템 프롬프트: [고정] + [가변] ──────────────────────────────────────
  // 고정 블록 = 지침·플레이북. 5분 캐시로 갱신되는 동안 모든 요청에 똑같다 → 프롬프트 캐시.
  // 가변 블록 = 카테고리 지침·모드·대화 지침. 요청마다 달라서 캐시 경계 뒤에 둔다.
  const STABLE_SYSTEM = `${personaBase}

[핵심 철학]
${corePhilosophy}

[말투와 스타일]
${toneGuide}${freeGuidelines}${doNotDo}${playbookStr}`;

  let VARIABLE_SYSTEM = `${categoryRules ? categoryRules.replace(/^\n/, '') + '\n\n' : ''}당신의 과거 콘텐츠, 강의, 컨설팅 자료를 참고하여 답변하세요.
${isPublic
  ? '지금 대화하는 상대는 멤버십 회원입니다. 1:1 코칭을 받는 것처럼 따뜻하지만 솔직하게 대화하세요.'
  : '디렉터가 수강생 미션을 검토하는 상황입니다. 커밍쏜의 관점으로 피드백 방향을 제시해주세요.'}`;

  const contextStr = hits.length > 0
    ? hits.map((h, i) => `[참고 ${i+1} — ${h.docName}]\n${h.text}`).join('\n\n---\n\n')
    : '(검색된 참고 자료 없음 — 핵심 철학을 바탕으로 답변)';

  const LABELS = { channel: '채널 기획', content: '콘텐츠 기획', free: '자유 질문' };
  const categoryLabel = LABELS[category] || '질문';

  let userPrompt;
  if (isPublic) {
    userPrompt = mode === 'structured'
      ? `[${categoryLabel}] 질문입니다.\n\n${question}\n\n---\n\n[참고 자료]\n${contextStr}${casesBlock}\n\n---\n\n아래 형식으로 답변해주세요:\n\n[핵심 답변]\n(가장 중요한 포인트)\n\n[구체적으로 이렇게 해보세요]\n(실행 가능한 액션 2~3가지)\n\n[한마디]\n(철학이 담긴 한 문장으로 마무리)`
      : `[${categoryLabel}] 질문입니다.\n\n${question}\n\n---\n\n[참고 자료]\n${contextStr}${casesBlock}\n\n---\n\n커밍쏜이 직접 대화하듯 구어체로 답변해주세요. 질문자의 상황을 먼저 이해하고, 핵심을 짚은 뒤, 다음 스텝으로 마무리. 300~500자 내외.`;
  } else {
    userPrompt = mode === 'structured'
      ? `${studentName || '수강생'}의 [${categoryLabel}] 미션입니다.${extraContext ? `\n\n[디렉터 메모]\n${extraContext}` : ''}\n\n[제출 내용]\n${question}\n\n---\n\n[참고 자료]\n${contextStr}${casesBlock}\n\n---\n\n[✅ 잘 잡고 있는 방향]\n(2가지, 이유 포함)\n\n[🔧 더 디깅이 필요한 부분]\n(2~3가지)\n\n[💡 다음 스텝]\n(실행 가능한 액션 2~3가지)`
      : `${studentName || '수강생'}의 [${categoryLabel}] 미션입니다.${extraContext ? `\n\n[디렉터 메모]\n${extraContext}` : ''}\n\n[제출 내용]\n${question}\n\n---\n\n[참고 자료]\n${contextStr}${casesBlock}\n\n---\n\n커밍쏜이 직접 말해주듯 구어체로 피드백을 작성해주세요. Why와 서사를 먼저 짚고, 핵심 방향을 제시하고, 실행 가능한 다음 스텝으로 마무리. 400~600자 내외.`;
  }

  try {
    // ─── 대화(챗) 모드: 형식 제약 해제 + 커밍쏜 대화 원칙 ───
    if (req.body && req.body.chat) {
      VARIABLE_SYSTEM += '\n\n[대화 모드 지침 — 위의 출력 형식·분량 지시보다 우선]\n지금은 디렉터와 실시간 채팅 중이다. 답변은 바로 시작한다 — 첫 문장부터 먼저 낸다.\n- 대화 흐름에 맞는 자연스러운 길이로 답한다. 간단한 질문엔 간결하게, 로드맵 점검이나 기획 요청엔 깊이 있게.\n- 커밍쏜의 코칭 방식을 따른다: 1) 잘한 점을 인정하되 핵심 문제를 정면으로 짚는다 2) 왜?를 파고든다 — 결핍이 모호하면 메시지도 타겟도 흔들린다 3) 소재는 대중성으로, 차별화는 메시지·페르소나·라이프스타일로 만든다 4) 수익 불안 때문에 방향을 바꾸려는 패턴을 경계시킨다 5) 마지막엔 실행 가능한 다음 스텝을 제시한다.\n- 판단에 필요한 정보가 부족하면 먼저 되묻는다. 근거 없는 확신 대신 참고 자료와 과거 사례에 기반해 말한다.\n- 아이디어 제안 요청에는 구체적 예시(제목·훅·콘텐츠 구조)까지 낸다.\n- 참고 자료에 관련 사례가 있으면 자연스럽게 인용한다.';
      userPrompt = (extraContext ? '[맥락 정보]\n' + extraContext + '\n\n' : '') + '[참고 자료]\n' + contextStr + casesBlock + '\n\n---\n\n디렉터의 메시지: ' + question;
    }

    if (req.body && req.body.stream) {
      const systemBlocks = [cachedBlock(STABLE_SYSTEM), { type: 'text', text: VARIABLE_SYSTEM }];
      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: claudeHeaders(CLAUDE_KEY),
        body: claudeBody(systemBlocks, userPrompt, { stream: true, maxTokens: 12000, effort: 'medium' }),
      });
      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text().catch(() => '');
        return res.status(500).json({ error: 'Claude 스트림 실패: ' + upstream.status + ' ' + errText.slice(0, 180) });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      });
      res.write('event: meta\ndata: ' + JSON.stringify({ sources: hits, evidence }) + '\n\n');
      mark('claudeConnect');
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let sseBuf = '';
      let answerChars = 0, firstToken = false, streamErr = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        const sseLines = sseBuf.split('\n');
        sseBuf = sseLines.pop();
        for (const sseLine of sseLines) {
          if (sseLine.indexOf('data:') !== 0) continue;
          const payload = sseLine.slice(5).trim();
          if (!payload) continue;
          try {
            const ev = JSON.parse(payload);
            if (ev.type === 'content_block_delta' && ev.delta && ev.delta.text) {
              if (!firstToken) { firstToken = true; mark('firstToken'); }
              answerChars += ev.delta.text.length;
              res.write('event: delta\ndata: ' + JSON.stringify({ t: ev.delta.text }) + '\n\n');
            } else if (ev.type === 'message_start' && ev.message && ev.message.usage) {
              // 입력 토큰과 캐시 적중은 첫 이벤트에 실려 온다.
              const u = ev.message.usage;
              M.model = ev.message.model || '';
              M.usage.input = u.input_tokens || 0;
              M.usage.cacheRead = u.cache_read_input_tokens || 0;
              M.usage.cacheWrite = u.cache_creation_input_tokens || 0;
            } else if (ev.type === 'message_delta' && ev.usage) {
              M.usage.output = ev.usage.output_tokens || 0;
            } else if (ev.type === 'error') {
              streamErr = (ev.error && ev.error.message) || 'stream error';
              res.write('event: err\ndata: ' + JSON.stringify({ error: streamErr }) + '\n\n');
            }
          } catch(ignored) {}
        }
      }
      res.write('event: done\ndata: {}\n\n');
      logMetrics({ ok: !streamErr, error: streamErr, answerChars });
      return res.end();
    }

    const systemBlocks = [cachedBlock(STABLE_SYSTEM), { type: 'text', text: VARIABLE_SYSTEM }];
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: claudeHeaders(CLAUDE_KEY),
      body: claudeBody(systemBlocks, userPrompt, { maxTokens: 8000, effort: 'medium' }),
    });
    const data = await response.json();
    if (data.error) throw new Error('Claude: ' + data.error.message);
    const text = pickText(data);
    const u = data.usage || {};
    M.model = data.model || '';
    M.usage = { input: u.input_tokens || 0, output: u.output_tokens || 0,
                cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 };
    logMetrics({ ok: true, answerChars: text.length });
    return res.status(200).json({ feedback: text, sources: hits, evidence });
  } catch(e) {
    logMetrics({ ok: false, error: e.message });
    return res.status(500).json({ error: e.message });
  }
}
