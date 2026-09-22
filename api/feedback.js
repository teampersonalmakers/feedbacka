import fs from 'fs';
import path from 'path';
import {
  loadGuidelines as fsLoadGuidelines,
  loadPlaybook as fsLoadPlaybook,
  loadCases as fsLoadCases,
  quoteSamples,
  loadStudentHistory as fsLoadStudentHistory,
  pickCases,
  firestoreEnabled,
  addMetrics,
} from './_firestore.js';
import { claudeHeaders, claudeBody, cachedBlock, pickText, webSearchTool } from './_claude.js';
import { embedQuery, searchChunks, searchChunksByOrigin, countChunks, recencyBoost, timing } from './_vectors.js';
import { isReferenceRequest, isDataQuestion, referenceResearch, formatReferenceBlock, summarizeReferences, REFERENCE_GUIDE } from './_references.js';
import { hasChannelSignal, extractChannelMentions, researchChannels, formatChannelBlock, summarizeChannels, youtubeAuth, probeYouTube } from './_channels.js';
import { todayKST } from './_firestore.js';

// 채널이 자동 조회되지 않았을 때 Claude 웹 검색을 붙일지. WEB_SEARCH=off 로 끌 수 있다.
const webSearchOn = () => String(process.env.WEB_SEARCH || 'on').toLowerCase() !== 'off';

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
        YOUTUBE_API_KEY: !!process.env.YOUTUBE_API_KEY,
      },
      channelResearch: Object.assign(await probeYouTube(), { webSearch: webSearchOn() }),
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
      const _cohort = String(req.body.cohort || '').trim().slice(0, 10);
      let stuCtx = await fsLoadStudentHistory(_name, _cohort);
      if (stuCtx === null) stuCtx = NOTION_KEY_S ? await loadStudentHistory(NOTION_KEY_S, _name) : '';
      if (stuCtx) { extraContext = (extraContext ? extraContext + '\n\n' : '') + stuCtx; M.sources.studentMemory = true; }
    } catch(e) { console.warn('수강생 기록 로드 실패(무시):', e.message); }
  }

  // ─── 롤모델 채널 리서치 ───
  // 참여자가 적어 낸 롤모델 채널의 실제 데이터(구독자·업로드 빈도·최근 제목)를 조회한다.
  // 검색과 나란히 돌리고, 프롬프트를 조립할 때 결과를 합친다. 실패해도 답변은 나간다.
  // 대화 모드에서는 이전 질문(Q:)에 적힌 롤모델도 본다 — "저 채널들 분석해줘" 같은 후속 질문을 위해서.
  let channelResearch = { profiles: [], unresolved: [], backend: 'none', keyFailed: false, mentions: 0 };
  let channelPromise = null;
  if (category !== 'creator' && question) {
    const prevQs = [];
    const qRe = /^Q: (.+)$/gm; let qm;
    while ((qm = qRe.exec(String(req.body.extraContext || '')))) prevQs.push(qm[1]);
    const mentionText = String(question) + '\n' + prevQs.join('\n');
    if (hasChannelSignal(mentionText)) {
      channelPromise = (async () => {
        try {
          const mentions = await extractChannelMentions(mentionText, CLAUDE_KEY);
          mark('channelExtract');
          if (!mentions.length) return;
          const r = await researchChannels(mentions, await youtubeAuth());
          mark('channelFetch');
          channelResearch = Object.assign(r, { mentions: mentions.length });
        } catch (e) { console.warn('채널 리서치 실패(무시):', e.message.slice(0, 120)); }
      })();
    }
  }

  // ─── 레퍼런스 채널 리서치 ("이 사람한테 추천할 레퍼런스 채널 찾아줘") ───
  // 참여자 주제로 YouTube 를 검색해 구독자 구간별 채널 9개 + 발견 확률 높은 콘텐츠(썸네일 포함)를 만든다.
  let refResearch = null;
  let refPromise = null;
  const refExplicit = isReferenceRequest(String(question || ''));
  const refData = !refExplicit && isDataQuestion(String(question || ''));
  if (category !== 'creator' && question && (refExplicit || refData)) {
    M.sources.refTrigger = refExplicit ? 'explicit' : 'data';
    refPromise = (async () => {
      try {
        refResearch = await referenceResearch({ question: String(question), context: String(req.body.extraContext || ''), studentName: String(studentName || '').trim(), claudeKey: CLAUDE_KEY, auth: await youtubeAuth() });
        mark('references');
      } catch (e) { console.warn('레퍼런스 리서치 실패(무시):', e.message.slice(0, 120)); refResearch = { ok: false, topic: '', queries: [], tiers: [], contents: [], thumbs: [], errors: [String(e.message).slice(0, 120)] }; }
    })();
  }

  let hits = [];
  let vectorCases = null;   // 판단 카드(승인 사례) 벡터 검색 결과. null 이면 단어 겹침 폴백.
  if (GEMINI_KEY && question) {
    const q = String(req.body.searchQuery || question);
    try {
      // 1순위: Firestore 벡터 검색. 파일을 읽지 않으니 콜드스타트에 80MB 파싱이 빠진다.
      if (firestoreEnabled()) {
        const queryVec = await embedQuery(q, GEMINI_KEY);
        mark('embed');
        // 자막·검증 답변은 전체에서 6건, 판단 카드는 따로 3건 — 자막 2,344조각에 사례가 묻히지 않게.
        const [all, cs] = await Promise.all([
          searchChunks(queryVec, 6),
          searchChunksByOrigin('case', queryVec, 3).catch((e) => { console.warn('사례 벡터 검색 실패 → 단어 겹침 폴백:', e.message.slice(0, 80)); return null; }),
        ]);
        // 최신 상담 가산점 — 유사도가 비슷하면 최근 판단이 앞에 온다(문턱 0.45 는 원래 유사도로 본다).
        hits = all.map((h) => Object.assign({}, h, { rank: (h.score || 0) + recencyBoost(h.consultedAt) })).sort((a, b) => b.rank - a.rank);
        if (cs) vectorCases = cs.filter((c) => c.score >= 0.45)
          .map((c) => ({ summary: c.summary || c.docName, body: c.text, cohort: c.cohort || '', when: c.when || '', consultedAt: c.consultedAt || 0, score: c.score, rank: c.score + recencyBoost(c.consultedAt) }))
          .sort((a, b) => b.rank - a.rank);
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
  if (channelPromise) await channelPromise;
  if (refPromise) await refPromise;
  if (refResearch) { M.sources.references = refResearch.ok ? refResearch.contents.length : 0; M.sources.referencesErrors = refResearch.errors.length; }
  M.sources.channels = channelResearch.profiles.length;
  M.sources.channelsUnresolved = channelResearch.unresolved.length;
  M.sources.channelsBackend = channelResearch.backend;

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
  // 판단 카드: 벡터 검색이 되면 그 결과(의미 기준), 아니면 예전 단어 겹침 방식.
  // 벡터 결과가 비면(아직 승인 카드가 임베딩되지 않았거나 유사도 미달) 예전 단어 겹침으로.
  let relevantCases = vectorCases !== null ? vectorCases : [];
  M.sources.casesBackend = vectorCases !== null ? 'vector' : 'keyword';
  if (!relevantCases.length) {
    relevantCases = pickCases((await fsLoadCases()) || [], question, 3).map((c) => Object.assign({}, c, { when: timing(c).when }));
    if (relevantCases.length) M.sources.casesBackend = 'keyword';
  }
  mark('firestore');
  M.sources.cases = relevantCases.length;
  M.sources.playbook = playbook.length;
  // 커밍쏜 실제 발화 샘플 — 승인 사례의 녹취 인용. 말투를 지어내지 말고 여기서 배우게. (고정 블록에 들어간다)
  const samples = quoteSamples((await fsLoadCases()) || [], 24);
  M.sources.quoteSamples = samples.length;

  // 답변 근거 — 디렉터 화면에 "무엇을 보고 답했는지" 보여주기 위한 목록.
  // 본문은 짧게 잘라 보낸다(카드에서 펼쳐 볼 정도).
  const evidence = {
    sources: hits.map((h) => ({ docName: h.docName, docType: h.docType || '', score: Math.round((h.score || 0) * 100) / 100, text: String(h.text || '').slice(0, 600) })),
    cases: relevantCases.map((c) => ({ summary: c.summary || '', cohort: c.cohort || '', text: String(c.body || '').slice(0, 600) })),
    playbook: playbook.length,
    studentMemory: M.sources.studentMemory,
    channels: summarizeChannels(channelResearch.profiles, channelResearch.unresolved),
    references: refResearch ? summarizeReferences(refResearch) : null,
  };
  const referenceBlock = refResearch ? formatReferenceBlock(refResearch, todayKST()) : '';
  const referencesBlock = referenceBlock ? '\n\n' + referenceBlock : '';

  // 롤모델 채널 블록 + 평가 지침. 데이터가 있을 때만 붙는다.
  const channelBlock = formatChannelBlock(channelResearch.profiles, channelResearch.unresolved, todayKST());
  const channelsBlock = channelBlock ? '\n\n' + channelBlock : '';
  const useWebSearch = webSearchOn() && channelResearch.unresolved.length > 0;
  const claudeTools = useWebSearch ? [webSearchTool(Math.min(channelResearch.unresolved.length + 1, 4))] : null;
  if (useWebSearch) M.sources.channelsBackend = channelResearch.profiles.length ? 'youtube+websearch' : 'websearch';

  const corePhilosophy = (g.corePhilosophy || [
    '유튜브는 SNS가 아니라 비즈니스다. 채널은 브랜드고, 콘텐츠는 상품이다.',
    '나만의 라이프스타일을 콘텐츠에 전달하고, 이에 공감하는 사람들을 모아야 한다.',
    '감정을 남기는 콘텐츠를 만들어야 한다. 정보는 잊혀지지만 감정은 남는다.',
    '정보는 복제되지만, 서사는 절대 복제되지 않는다. 나만의 서사를 만들어야 한다.',
    '브랜딩은 더 덜어낼 수 없는 상태까지 걸어내야 완성된다.',
  ]).map((p, i) => `${i+1}. ${p}`).join('\n');

  const toneGuide = g.toneGuide || '직접적이고 핵심을 먼저 말합니다. 칭찬보다 구체적인 방향 제시를 우선합니다.';
  // 피드백 순서 — 설정 페이지에서 커밍쏜이 정한 답변 흐름. 비어 있으면 넣지 않는다.
  const feedbackOrder = (g.feedbackOrder || []).length > 0
    ? '\n\n[피드백 순서 — 답변은 이 흐름을 따른다]\n' + g.feedbackOrder.map((f, i) => `${i + 1}. ${f}`).join('\n')
    : '';
  // 카테고리별 지침은 전부 넣고 AI 가 질문 주제에 맞는 것을 고른다.
  // 예전엔 사용자가 고른 카테고리 하나만 넣었는데, 질문은 주제가 섞여 오는 경우가 많고
  // 잘못 고르면 엉뚱한 지침이 들어갔다. 매 요청 같은 내용이라 캐시 블록에 들어간다.
  const catEntries = Object.values(g.categoryGuidelines || {}).filter((c) => c && (c.rules || []).length);
  const categoryRules = catEntries.length
    ? '\n\n[주제별 피드백 지침 — 질문의 주제를 스스로 판단해 해당하는 지침만 적용한다. 여러 주제가 섞였으면 해당하는 것을 모두 적용한다]\n' +
      catEntries.map((c) => `《${c.name}》\n` + c.rules.map((r) => `- ${r}`).join('\n')).join('\n\n')
    : '';
  const doNotDo = (g.doNotDo || []).length > 0 ? '\n[절대 하지 말 것]\n' + g.doNotDo.map(d => `- ${d}`).join('\n') : '';
  const freeGuidelines = g.freeGuidelines ? `\n[추가 지침]\n${g.freeGuidelines}` : '';
  const personaBase = g.persona || '당신은 커밍쏜입니다. 유튜브 채널 성장과 콘텐츠 브랜딩 전문가입니다.';

  // 사례는 질문마다 달라진다. 시스템 프롬프트에 두면 캐시 프리픽스가 매번 깨지므로
  // 참고 자료와 함께 user 턴에 넣는다.
  const casesBlock = relevantCases.length > 0
    ? '\n\n[커밍쏜 디렉팅 사례 — 실제 컨설팅에서 나온 판단 기준]\n' +
      relevantCases.map((c, i) =>
        `사례 ${i + 1}. ${c.summary}${c.when ? ` (상담 시기: ${c.when})` : (c.cohort ? ` (${c.cohort})` : '')}\n${String(c.body).slice(0, 1500)}`
      ).join('\n\n')
    : '';

  const playbookStr = playbook.length > 0
    ? '\n\n[팀 퍼메스 Q&A 플레이북]\n아래는 승인된 공식 Q&A입니다. 유사한 질문에는 이 답변의 내용과 기조를 우선 반영하세요.\n' +
      playbook.map((p, i) => `Q${i+1}. [${p.category}] ${p.q}\nA${i+1}. ${p.answer}`).join('\n\n')
    : '';

  // ── 시스템 프롬프트: [고정] + [가변] ──────────────────────────────────────
  // 고정 블록 = 지침·플레이북. 5분 캐시로 갱신되는 동안 모든 요청에 똑같다 → 프롬프트 캐시.
  // 가변 블록 = 카테고리 지침·모드·대화 지침. 요청마다 달라서 캐시 경계 뒤에 둔다.
  const quoteBlock = samples.length
    ? '\n\n[커밍쏜 실제 발화 샘플 — 실제 컨설팅 녹취에서 그대로 가져온 말. 문장 길이·리듬·단어 선택·직설적인 정도를 이 톤에 맞춘다. 문장을 그대로 베끼지는 않는다]\n' +
      samples.map((q) => `- "${q.quote}"${q.cohort ? ` (${[q.cohort, q.round].filter(Boolean).join(' ')})` : ''}`).join('\n')
    : '';

  // 답변 원칙 — 근거·논리·정직. 매 요청 같으므로 고정 블록(캐시)에 둔다.
  const GROUNDING = `

[답변 원칙 — 커밍쏜이 직접 컨설팅하듯, 근거와 논리를 함께]
1) 판단에는 항상 "왜"가 붙는다. 커밍쏜의 컨설팅은 결론만 던지지 않는다 — 참여자의 상황을 먼저 짚고 → 핵심 문제를 정면으로 말하고 → 그렇게 판단하는 원칙(왜)을 말하고 → 실제 사례나 데이터로 뒷받침하고 → 다음 스텝을 준다. 이 흐름이 답변의 뼈대다. 형식 제목을 붙이지 말고 말하듯 이어간다.
2) 근거는 자료에서 나온 것만. 답변에 쓰는 사례·판단 기준·수치·채널명·영상 제목·커밍쏜 본인 경험은 이번 요청에 딸려 온 참고 자료(자막·승인 답변·디렉팅 사례·리서치 블록)에 있는 것만 쓴다. 자료를 쓸 때는 문장 끝에 출처를 짧게 붙인다 — 예: (사례 2 · 6기 1차), (승인 답변), (자막: 영상 제목), (리서치: 채널명). 디렉터가 어디서 나온 판단인지 볼 수 있어야 한다.
3) 자료에 없는 건 없다고 말한다. 자료가 뒷받침하지 않는 판단을 해야 할 때는 "이건 자료엔 없고, 커밍쏜의 원칙(핵심 철학 n번)에서 나온 추론이에요"처럼 그 사실을 드러낸다. 커밍쏜이 겪은 일·말한 것처럼 꾸며 말하지 않는다. 숫자가 필요한데 자료에 없으면 숫자를 만들지 말고 "이 부분은 유튜브 데이터 확인이 필요해요 — '레퍼런스 채널 찾아줘'로 요청하면 실제 수치로 답합니다"라고 말한다.
4) 확신의 정도를 구분한다. 같은 판단이 사례 2건 이상에서 반복되면 확신 있게, 1건이면 "이런 사례가 하나 있었는데", 없으면 원칙에서 나온 추론이라고 말한다. 최신 상담이 옛 판단과 다르면 최신을 따르고 그 차이를 한 줄 짚는다.
5) 말투는 위 발화 샘플처럼. 디렉터가 그대로 참여자에게 전할 수 있게, 커밍쏜이 눈앞에서 말해주는 톤으로. 다만 사람을 깎아내리는 표현은 쓰지 않는다.`;

  const STABLE_SYSTEM = `${personaBase}

[핵심 철학]
${corePhilosophy}

[말투와 스타일]
${toneGuide}${feedbackOrder}${freeGuidelines}${doNotDo}${GROUNDING}${quoteBlock}${categoryRules}${playbookStr}`;

  let VARIABLE_SYSTEM = `당신의 과거 콘텐츠, 강의, 컨설팅 자료를 참고하여 답변하세요.
참고 자료 중 '커밍쏜 승인 답변'과 '디렉터 검증 답변'은 팀이 실제 상담에서 확인한 답이다. 비슷한 질문이면 자막보다 이 답의 판단과 기조를 우선 따른다. 다른 수강생의 사례라도 판단 기준은 그대로 적용한다.
사례·답변에 '상담 시기'가 있다. 같은 상황에 대한 판단이 겹치는데 방향이 조금 다르면 더 최근 상담의 판단을 따른다 — 커밍쏜의 인사이트는 뒤로 갈수록 정교해진다. 오래된 판단은 최신 판단과 충돌하지 않는 범위에서만 보태고, 그 차이를 짚을 가치가 있으면 "예전엔 A 였는데 최근엔 B" 로 한 줄 언급한다.
${isPublic
  ? '지금 대화하는 상대는 멤버십 회원입니다. 1:1 코칭을 받는 것처럼 따뜻하지만 솔직하게 대화하세요.'
  : '디렉터가 수강생 미션을 검토하는 상황입니다. 커밍쏜의 관점으로 피드백 방향을 제시해주세요.'}`;

  if (referenceBlock) VARIABLE_SYSTEM += '\n\n' + REFERENCE_GUIDE;
  if (channelBlock) {
    VARIABLE_SYSTEM += `\n\n[롤모델 채널 평가 지침]
참여자가 롤모델·벤치마킹 채널을 들었고 아래 user 턴에 '롤모델 채널 리서치' 블록이 있다. 각 채널을 커밍쏜의 기준으로 평가해 피드백에 녹인다.
1) 주제 핏: 그 채널이 실제로 다루는 주제·타겟·메시지(채널 소개, 최근 영상 제목으로 판단)가 참여자의 주제·결핍·타겟과 맞는가. 참여자가 "왜 이 채널인지" 적은 이유가 소재 때문인지, 페르소나·서사·라이프스타일 때문인지 짚는다.
2) 단계 핏: 구독자·업로드 빈도·조회 규모가 참여자의 지금 단계에서 따라할 수 있는 모델인가. 커밍쏜 기준으로 레퍼런스는 초대형 채널이 아니라 구독자 10만 이하에서 찾고, 기관·회사 채널보다 개인 채널을 우선한다. 대형 채널이면 소재를 베끼는 게 아니라 '왜 되는지'(메시지·구조·페르소나)를 뽑아 준다. 숏폼 비율·업로드 빈도가 참여자의 리소스와 맞는지도 본다.
3) 핏이 안 맞으면 솔직하게 말하고, 참여자의 결핍·타겟에 더 맞는 벤치마킹 방향을 제시한다.
4) 숫자와 제목은 리서치 블록에 있는 값만 쓴다. 블록에 없는 수치·영상·사실을 기억으로 지어내지 않는다. '이름 검색 결과' 표시가 있으면 동명 채널일 수 있음을 한 줄 언급한다.
5) 자동 조회가 안 된 채널은 ${useWebSearch ? 'web_search 도구로 "채널명 유튜브" 를 검색해 주제·규모·대표 콘텐츠를 확인한 뒤 평가한다. 채널당 검색 1회, 확인이 안 되면 모른다고 말한다.' : '데이터가 없다고 말하고 참여자가 적은 설명만으로 조심스럽게 판단한다.'}`;
  }

  const contextStr = hits.length > 0
    ? hits.map((h, i) => `[참고 ${i+1} — ${h.docType === 'playbook' ? (h.verified === 'approved' ? '커밍쏜 승인 답변' : '디렉터 검증 답변') + ' · ' : ''}${h.docName}${h.when ? ' · 상담 시기 ' + h.when : ''}]\n${h.text}`).join('\n\n---\n\n')
    : '(검색된 참고 자료 없음 — 핵심 철학을 바탕으로 답변)';


  let userPrompt;
  if (isPublic) {
    userPrompt = mode === 'structured'
      ? `질문입니다.\n\n${question}\n\n---\n\n[참고 자료]\n${contextStr}${casesBlock}${channelsBlock}${referencesBlock}\n\n---\n\n아래 형식으로 답변해주세요:\n\n[핵심 답변]\n(가장 중요한 포인트)\n\n[구체적으로 이렇게 해보세요]\n(실행 가능한 액션 2~3가지)\n\n[한마디]\n(철학이 담긴 한 문장으로 마무리)`
      : `질문입니다.\n\n${question}\n\n---\n\n[참고 자료]\n${contextStr}${casesBlock}${channelsBlock}${referencesBlock}\n\n---\n\n커밍쏜이 직접 대화하듯 구어체로 답변해주세요. 질문자의 상황을 먼저 이해하고, 핵심을 짚은 뒤, 다음 스텝으로 마무리. 300~500자 내외.`;
  } else {
    userPrompt = mode === 'structured'
      ? `${studentName ? studentName + (req.body.cohort ? ' (' + String(req.body.cohort).slice(0, 10) + ')' : '') : '수강생'}의 미션입니다.${extraContext ? `\n\n[디렉터 메모]\n${extraContext}` : ''}\n\n[제출 내용]\n${question}\n\n---\n\n[참고 자료]\n${contextStr}${casesBlock}${channelsBlock}${referencesBlock}\n\n---\n\n[✅ 잘 잡고 있는 방향]\n(2가지, 이유 포함)\n\n[🔧 더 디깅이 필요한 부분]\n(2~3가지)\n\n[💡 다음 스텝]\n(실행 가능한 액션 2~3가지)`
      : `${studentName ? studentName + (req.body.cohort ? ' (' + String(req.body.cohort).slice(0, 10) + ')' : '') : '수강생'}의 미션입니다.${extraContext ? `\n\n[디렉터 메모]\n${extraContext}` : ''}\n\n[제출 내용]\n${question}\n\n---\n\n[참고 자료]\n${contextStr}${casesBlock}${channelsBlock}${referencesBlock}\n\n---\n\n커밍쏜이 직접 말해주듯 구어체로 피드백을 작성해주세요. Why와 서사를 먼저 짚고, 핵심 방향을 제시하고, 실행 가능한 다음 스텝으로 마무리. 400~600자 내외.`;
  }

  try {
    // ─── 대화(챗) 모드: 형식 제약 해제 + 커밍쏜 대화 원칙 ───
    if (req.body && req.body.chat) {
      VARIABLE_SYSTEM += '\n\n[대화 모드 지침 — 위의 출력 형식·분량 지시보다 우선]\n지금은 디렉터와 실시간 채팅 중이다. 답변은 바로 시작한다 — 첫 문장부터 먼저 낸다.\n- 대화 흐름에 맞는 자연스러운 길이로 답한다. 간단한 질문엔 간결하게, 로드맵 점검이나 기획 요청엔 깊이 있게.\n- 커밍쏜의 코칭 방식을 따른다: 1) 잘한 점을 인정하되 핵심 문제를 정면으로 짚는다 2) 왜?를 파고든다 — 결핍이 모호하면 메시지도 타겟도 흔들린다 3) 소재는 대중성으로, 차별화는 메시지·페르소나·라이프스타일로 만든다 4) 수익 불안 때문에 방향을 바꾸려는 패턴을 경계시킨다 5) 마지막엔 실행 가능한 다음 스텝을 제시한다.\n- 판단에 필요한 정보가 부족하면 먼저 되묻는다. 근거 없는 확신 대신 참고 자료와 과거 사례에 기반해 말한다.\n- 아이디어 제안 요청에는 구체적 예시(제목·훅·콘텐츠 구조)까지 낸다.\n- 참고 자료에 관련 사례가 있으면 자연스럽게 인용하고 출처를 짧게 붙인다. 리서치 블록이 있으면 그 수치로 말하고, 없으면 숫자를 만들지 않는다.';
      userPrompt = (extraContext ? '[맥락 정보]\n' + extraContext + '\n\n' : '') + '[참고 자료]\n' + contextStr + casesBlock + channelsBlock + referencesBlock + '\n\n---\n\n디렉터의 메시지: ' + question;
    }

    // 썸네일 이미지가 있으면 user 턴을 [이미지들 + 텍스트] 블록으로. 이미지가 먼저 오는 게 인식이 좋다.
    const thumbs = (refResearch && refResearch.thumbs) || [];
    const userContent = thumbs.length
      ? [
          { type: 'text', text: `[콘텐츠 레퍼런스 썸네일 ${thumbs.length}장 — 순서대로 #${thumbs.map((t) => t.n).join(', #')}]` },
          ...thumbs.map((t) => ({ type: 'image', source: { type: 'base64', media_type: t.media_type, data: t.data } })),
          { type: 'text', text: userPrompt },
        ]
      : userPrompt;
    if (thumbs.length) M.sources.thumbs = thumbs.length;

    if (req.body && req.body.stream) {
      const systemBlocks = [cachedBlock(STABLE_SYSTEM), { type: 'text', text: VARIABLE_SYSTEM }];
      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: claudeHeaders(CLAUDE_KEY),
        body: claudeBody(systemBlocks, userContent, { stream: true, maxTokens: 12000, effort: 'medium', tools: claudeTools }),
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
      if (refResearch) res.write('event: status\ndata: ' + JSON.stringify({ t: refResearch.ok ? '📺 레퍼런스 채널 ' + refResearch.tiers.reduce((a, t) => a + t.channels.length, 0) + '개 · 콘텐츠 ' + refResearch.contents.length + '개 조회 완료, 분석 중…' : '⚠️ 레퍼런스 조회가 되지 않아 데이터 없이 답합니다' }) + '\n\n');
      mark('claudeConnect');
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let sseBuf = '';
      let answerChars = 0, firstToken = false, streamErr = '';
      // 웹 검색이 끼면 텍스트 블록이 여러 개로 나뉜다(검색 전 문장 → 검색 → 이어지는 문장).
      // 블록 사이에 줄바꿈을 넣어 문단이 붙지 않게 한다.
      let textBlocks = 0, searches = 0;
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
            if (ev.type === 'content_block_start' && ev.content_block) {
              if (ev.content_block.type === 'text') {
                if (textBlocks > 0) res.write('event: delta\ndata: ' + JSON.stringify({ t: '\n\n' }) + '\n\n');
                textBlocks++;
              } else if (ev.content_block.type === 'server_tool_use') {
                searches++;
                res.write('event: status\ndata: ' + JSON.stringify({ t: '🔎 웹에서 채널 정보를 찾는 중…' }) + '\n\n');
              }
            } else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.text) {
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
      if (searches) M.sources.webSearches = searches;
      logMetrics({ ok: !streamErr, error: streamErr, answerChars });
      return res.end();
    }

    const systemBlocks = [cachedBlock(STABLE_SYSTEM), { type: 'text', text: VARIABLE_SYSTEM }];
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: claudeHeaders(CLAUDE_KEY),
      body: claudeBody(systemBlocks, userContent, { maxTokens: 8000, effort: 'medium', tools: claudeTools }),
    });
    const data = await response.json();
    if (data.error) throw new Error('Claude: ' + data.error.message);
    const text = pickText(data);
    const u = data.usage || {};
    const webSearches = (data.content || []).filter((b) => b && b.type === 'server_tool_use').length;
    if (webSearches) M.sources.webSearches = webSearches;
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
