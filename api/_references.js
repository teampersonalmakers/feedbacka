// ─────────────────────────────────────────────────────────────────────────────
// api/_references.js — 주제별 레퍼런스 채널·콘텐츠 리서치
//
// 디렉터가 "이 사람한테 추천할 레퍼런스 채널 찾아줘" 하면, 참여자 주제로 YouTube 를 실제로
// 검색해서 아래를 만든다.
//   · 채널 9개 — 구독자 10만 이상 3 / 1만~10만 3 / 1만 이하 3 (없는 구간은 없다고 표시)
//   · 발견될 확률이 높은 콘텐츠 — 구독자 대비 조회수가 높은 영상 (소재·제목·썸네일)
// 썸네일은 이미지로 받아 Claude 에 같이 넣는다 — 글이 아니라 실제 구성을 보고 말하게.
//
// 비용(YouTube 쿼터): 검색 1회 100유닛. 질의 4개 영상 검색 + 채널 검색 2개 = 600 + 상세 ~20.
// 하루 한도 10,000 → 리서치 10여 회. 같은 주제는 3일 캐시.
// 실패해도 throw 하지 않는다. 오류는 결과에 담아 답변이 "조회 안 됨"을 말하게 한다.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';
import { getDb } from './_firestore.js';
import { claudeHeaders, claudeBody, pickText } from './_claude.js';
import { fmtKo } from './_channels.js';

const YT = 'https://www.googleapis.com/youtube/v3';
const CACHE_TTL_MS = 3 * 24 * 3600 * 1000;
const QUERY_MODEL = 'claude-sonnet-5';
const TIERS = [
  { key: 'big', label: '구독자 10만 이상', min: 100000, max: Infinity },
  { key: 'mid', label: '구독자 1만~10만', min: 10000, max: 100000 },
  { key: 'small', label: '구독자 1만 이하', min: 0, max: 10000 },
];
const PER_TIER = 3;
const CONTENT_N = 9;
// 콘텐츠 레퍼런스 기준(커밍쏜): 구독자 대비 조회수 5배 이상 + 조회 1만 이상. 미달이면 채우지 않고 부족하다고 말한다.
export const MIN_RATIO = 5;
export const MIN_VIEWS = 10000;

// "레퍼런스 채널 추천해줘 / 벤치마킹 채널 찾아줘 / 참고할 채널 알려줘" 류의 요청인가
const REF_RE = /(레퍼런스|벤치마킹|벤치마크|참고(?:할|할\s*만한)?|롤모델)\s*(?:유튜브\s*)?채널[^\n]{0,20}(추천|찾|알려|골라|뽑|리서치|서치|검색)|채널\s*(추천|리서치)|(추천|찾)[^\n]{0,8}(레퍼런스|벤치마킹)\s*채널/;
export function isReferenceRequest(text) { return REF_RE.test(String(text || '')); }

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 24);

// ─── 1) 주제 → 검색어 (Sonnet, 사고 없음) ─────────────────────────────────────
const QUERY_SYSTEM = `당신은 유튜브 리서치 담당자다. 디렉터의 요청과 참여자(수강생) 맥락을 읽고, 참여자의 채널 주제로 유튜브에서 레퍼런스 채널·영상을 찾기 위한 검색어를 만든다.
- topic: 참여자의 채널 주제 한 줄 (타겟 포함). 맥락에 주제가 없으면 요청문에서 추정.
- queries: 한국어 유튜브 검색어 4개. 시청자가 실제로 칠 법한 말로, 서로 겹치지 않게 (주제 핵심 / 타겟의 고민 / 구체 소재 2개).
- channelQueries: 채널 검색용 짧은 키워드 2개 (예: "상속 세무사", "피부과 전문의").
출력은 JSON 하나만: {"topic":"...","queries":["...","...","...","..."],"channelQueries":["...","..."]}`;

async function genQueries({ question, context, studentName, claudeKey }) {
  const user = `[디렉터 요청]\n${question}\n\n[참여자 맥락]${studentName ? '\n참여자: ' + studentName : ''}\n${String(context || '').slice(-3500)}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: claudeHeaders(claudeKey),
    body: claudeBody(QUERY_SYSTEM, user, { model: QUERY_MODEL, maxTokens: 500, thinking: false, fallbacks: false }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  const raw = pickText(d);
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('검색어 JSON 없음');
  const j = JSON.parse(m[0]);
  const qs = (Array.isArray(j.queries) ? j.queries : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 4);
  const cqs = (Array.isArray(j.channelQueries) ? j.channelQueries : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 2);
  if (!qs.length) throw new Error('검색어 없음');
  return { topic: String(j.topic || '').slice(0, 120), queries: qs, channelQueries: cqs };
}

// ─── 2) YouTube ───────────────────────────────────────────────────────────────
class YtError extends Error { constructor(status, reason, message) { super(message); this.status = status; this.reason = reason; } }
async function yt(path, params, auth) {
  const u = new URL(YT + path);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, String(v));
  const headers = {};
  if (auth && auth.key) u.searchParams.set('key', auth.key);
  else if (auth && auth.bearer) headers.Authorization = 'Bearer ' + auth.bearer;
  const r = await fetch(u, { headers, signal: AbortSignal.timeout(9000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    const err = (data.error && data.error.errors && data.error.errors[0]) || {};
    throw new YtError(r.status, err.reason || (data.error && data.error.status) || '', (data.error && data.error.message) || ('HTTP ' + r.status));
  }
  return data;
}
const isoSec = (d) => { const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || ''); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; };
const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

async function searchVideos(q, auth) {
  const d = await yt('/search', { part: 'snippet', type: 'video', q, maxResults: 25, order: 'relevance', regionCode: 'KR', relevanceLanguage: 'ko', safeSearch: 'none' }, auth);
  return (d.items || []).map((it) => ({ id: it.id && it.id.videoId, channelId: it.snippet && it.snippet.channelId, q })).filter((x) => x.id && x.channelId);
}
async function searchChannels(q, auth) {
  const d = await yt('/search', { part: 'snippet', type: 'channel', q, maxResults: 10, regionCode: 'KR', relevanceLanguage: 'ko' }, auth);
  return (d.items || []).map((it) => (it.snippet && it.snippet.channelId) || (it.id && it.id.channelId)).filter(Boolean);
}
async function videoDetails(ids, auth) {
  const out = [];
  for (const part of chunk([...new Set(ids)], 50)) {
    const d = await yt('/videos', { part: 'snippet,statistics,contentDetails', id: part.join(','), maxResults: 50 }, auth);
    for (const v of d.items || []) out.push({
      id: v.id, channelId: v.snippet && v.snippet.channelId, channelTitle: (v.snippet && v.snippet.channelTitle) || '',
      title: String((v.snippet && v.snippet.title) || '').slice(0, 100), publishedAt: ((v.snippet && v.snippet.publishedAt) || '').slice(0, 10),
      views: +((v.statistics && v.statistics.viewCount) || 0), likes: +((v.statistics && v.statistics.likeCount) || 0),
      sec: isoSec(v.contentDetails && v.contentDetails.duration),
      thumb: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
    });
  }
  return out;
}
async function channelDetails(ids, auth) {
  const out = {};
  for (const part of chunk([...new Set(ids)], 50)) {
    const d = await yt('/channels', { part: 'snippet,statistics', id: part.join(','), maxResults: 50 }, auth);
    for (const c of d.items || []) out[c.id] = {
      id: c.id, title: String((c.snippet && c.snippet.title) || '').slice(0, 80), handle: String((c.snippet && c.snippet.customUrl) || '').slice(0, 60),
      description: String((c.snippet && c.snippet.description) || '').replace(/\s+/g, ' ').slice(0, 200), publishedAt: ((c.snippet && c.snippet.publishedAt) || '').slice(0, 10),
      subscribers: (c.statistics && c.statistics.hiddenSubscriberCount) ? -1 : +((c.statistics && c.statistics.subscriberCount) || 0),
      videoCount: +((c.statistics && c.statistics.videoCount) || 0), viewCount: +((c.statistics && c.statistics.viewCount) || 0),
    };
  }
  return out;
}

async function fetchThumb(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 500 || buf.length > 400000) return null;
    return { media_type: 'image/jpeg', data: buf.toString('base64') };
  } catch (e) { return null; }
}

// ─── 3) 조립 ───────────────────────────────────────────────────────────────────
function monthsAgo(dateStr) { const t = Date.parse(dateStr || ''); return isNaN(t) ? 999 : (Date.now() - t) / (30 * 86400000); }

async function runResearch(plan, auth) {
  const errors = [];
  const vidHits = [];
  const chHits = new Set();
  await Promise.all([
    ...plan.queries.map((q) => searchVideos(q, auth).then((r) => vidHits.push(...r)).catch((e) => errors.push('영상 검색 "' + q + '": ' + e.message.slice(0, 80)))),
    ...plan.channelQueries.map((q) => searchChannels(q, auth).then((r) => r.forEach((id) => chHits.add(id))).catch((e) => errors.push('채널 검색 "' + q + '": ' + e.message.slice(0, 80)))),
  ]);
  if (!vidHits.length && !chHits.size) return { errors, tiers: [], contents: [], candidates: 0 };

  const videos = await videoDetails(vidHits.map((v) => v.id), auth).catch((e) => { errors.push('영상 상세: ' + e.message.slice(0, 80)); return []; });
  const chanIds = new Set([...videos.map((v) => v.channelId), ...chHits]);
  const channels = await channelDetails([...chanIds], auth).catch((e) => { errors.push('채널 상세: ' + e.message.slice(0, 80)); return {}; });

  // 채널 관련도: 주제 검색에 걸린 영상 수(질의 다양성 가중) + 채널 검색 적중
  const rel = {};
  const byChan = {};
  for (const v of videos) {
    if (!channels[v.channelId]) continue;
    (byChan[v.channelId] = byChan[v.channelId] || []).push(v);
  }
  for (const [cid, vs] of Object.entries(byChan)) {
    const qs = new Set(vidHits.filter((h) => h.channelId === cid).map((h) => h.q));
    rel[cid] = vs.length + qs.size * 1.5 + Math.log10(1 + vs.reduce((s, v) => s + v.views, 0)) * 0.3;
  }
  for (const cid of chHits) if (channels[cid]) rel[cid] = (rel[cid] || 0) + 1.2;

  // 구독자 구간별 상위 3
  const tiers = TIERS.map((t) => {
    const list = Object.values(channels)
      .filter((c) => c.subscribers >= 0 && c.subscribers >= t.min && c.subscribers < t.max && c.videoCount >= 5)
      .filter((c) => (byChan[c.id] || []).some((v) => monthsAgo(v.publishedAt) <= 24) || chHits.has(c.id))
      .sort((a, b) => (rel[b.id] || 0) - (rel[a.id] || 0))
      .slice(0, PER_TIER)
      .map((c) => {
        const vs = (byChan[c.id] || []).slice().sort((a, b) => b.views - a.views);
        return Object.assign({}, c, {
          relevance: Math.round((rel[c.id] || 0) * 10) / 10,
          topicVideos: vs.slice(0, 3).map((v) => ({ id: v.id, title: v.title, views: v.views, publishedAt: v.publishedAt })),
          lastTopicUpload: vs.map((v) => v.publishedAt).sort().reverse()[0] || '',
        });
      });
    return { key: t.key, label: t.label, channels: list };
  });

  // 발견 확률 높은 콘텐츠: 구독자 대비 조회수 5배 이상 + 조회 1만 이상 (36개월 내, 채널당 2편).
  // 구독자가 아주 적은 채널은 500명으로 잡아 비율이 뻥튀기되지 않게 한다.
  const seenPerChan = {};
  const contents = videos
    .filter((v) => channels[v.channelId] && channels[v.channelId].subscribers >= 0 && v.views >= MIN_VIEWS && monthsAgo(v.publishedAt) <= 36)
    .map((v) => Object.assign({}, v, { subscribers: channels[v.channelId].subscribers, ratio: v.views / Math.max(channels[v.channelId].subscribers, 500) }))
    .filter((v) => v.ratio >= MIN_RATIO)
    .sort((a, b) => b.ratio - a.ratio)
    .filter((v) => { seenPerChan[v.channelId] = (seenPerChan[v.channelId] || 0) + 1; return seenPerChan[v.channelId] <= 2; })
    .slice(0, CONTENT_N)
    .map((v) => ({
      id: v.id, title: v.title, channelId: v.channelId, channelTitle: channels[v.channelId].title, subscribers: v.subscribers,
      views: v.views, ratio: Math.round(v.ratio * 10) / 10, publishedAt: v.publishedAt, sec: v.sec, thumb: v.thumb,
      tier: (TIERS.find((t) => v.subscribers >= t.min && v.subscribers < t.max) || {}).key || '',
      url: 'https://www.youtube.com/watch?v=' + v.id,
    }));

  return { errors, tiers, contents, candidates: Object.keys(channels).length };
}

// ─── 캐시 ──────────────────────────────────────────────────────────────────────
async function cacheGet(key) {
  const db = getDb(); if (!db) return null;
  try { const s = await db.collection('references').doc(key).get(); if (!s.exists) return null; const v = s.data(); return Date.now() - (v.at || 0) < CACHE_TTL_MS ? v : null; } catch (e) { return null; }
}
function cachePut(key, v) { const db = getDb(); if (!db) return; db.collection('references').doc(key).set(v).catch((e) => console.warn('[references] 캐시 저장 실패:', e.message.slice(0, 80))); }

// ─── 공개 API ──────────────────────────────────────────────────────────────────
// → { ok, topic, queries, tiers, contents, thumbs:[{id, media_type, data}], errors, cached }
export async function referenceResearch({ question, context, studentName, claudeKey, auth }) {
  const out = { ok: false, topic: '', queries: [], tiers: [], contents: [], thumbs: [], errors: [], cached: false };
  let plan;
  try { plan = await genQueries({ question, context, studentName, claudeKey }); }
  catch (e) { plan = { topic: String(question).slice(0, 80), queries: [String(question).slice(0, 60)], channelQueries: [] }; out.errors.push('검색어 생성 실패(요청문으로 대체): ' + e.message.slice(0, 80)); }
  out.topic = plan.topic; out.queries = plan.queries;
  if (!auth) { out.errors.push('YouTube 인증 없음'); return out; }

  const key = sha(plan.queries.join('|') + '|' + plan.channelQueries.join('|'));
  const hit = await cacheGet(key);
  let r;
  if (hit) { r = hit; out.cached = true; }
  else {
    r = await runResearch(plan, auth);
    if (r.tiers.some((t) => t.channels.length) || r.contents.length) cachePut(key, Object.assign({ at: Date.now(), topic: plan.topic }, r));
  }
  out.tiers = r.tiers || []; out.contents = r.contents || []; out.errors.push(...(r.errors || []));
  out.ok = out.tiers.some((t) => t.channels.length) || out.contents.length > 0;

  // 썸네일 — 콘텐츠 레퍼런스 순서대로. 실패한 건 건너뛴다(번호는 유지).
  const th = await Promise.all(out.contents.map((c) => fetchThumb(c.thumb)));
  out.thumbs = th.map((t, i) => (t ? Object.assign({ id: out.contents[i].id, n: i + 1 }, t) : null)).filter(Boolean);
  return out;
}

export function formatReferenceBlock(r, todayStr) {
  if (!r) return '';
  const L = [`[레퍼런스 채널 리서치 — 주제: ${r.topic || '(추정 실패)'} · YouTube 데이터 ${todayStr}${r.cached ? ' (3일 내 캐시)' : ''}]`];
  L.push('검색어: ' + r.queries.join(' / '));
  if (!r.ok) {
    L.push('※ 조회 결과 없음' + (r.errors.length ? ' — ' + r.errors.join('; ') : ''));
    return L.join('\n');
  }
  for (const t of r.tiers) {
    L.push(`■ ${t.label} (${t.channels.length}개${t.channels.length < PER_TIER ? ' — 이 구간에서 주제 관련 채널이 더 발견되지 않음' : ''})`);
    t.channels.forEach((c, i) => {
      L.push(`${i + 1}. ${c.title}${c.handle ? ' (' + c.handle + ')' : ''} — 구독 ${fmtKo(c.subscribers)} · 영상 ${fmtKo(c.videoCount)}개 · 누적 조회 ${fmtKo(c.viewCount)} · 개설 ${c.publishedAt}` +
        (c.lastTopicUpload ? ` · 주제 영상 최근 ${c.lastTopicUpload}` : ''));
      if (c.description) L.push(`   소개: ${c.description}`);
      if (c.topicVideos && c.topicVideos.length) L.push('   주제 영상: ' + c.topicVideos.map((v) => `"${v.title}" (${fmtKo(v.views)}, ${v.publishedAt})`).join(' / '));
    });
  }
  L.push(`■ 발견될 확률이 높은 콘텐츠 — 기준: 구독자 대비 조회수 ${MIN_RATIO}배 이상 + 조회 ${fmtKo(MIN_VIEWS)} 이상 (${r.contents.length}개${r.contents.length < CONTENT_N ? ' — 기준을 넘는 영상이 이만큼만 발견됨' : ''}, 썸네일 이미지 #번호와 대응)`);
  if (!r.contents.length) L.push('(기준을 넘는 영상 없음 — 지어내지 말고 없다고 말할 것)');
  r.contents.forEach((c, i) => {
    const tierLabel = (TIERS.find((t) => t.key === c.tier) || {}).label || '';
    L.push(`#${i + 1} [${c.channelTitle} · 구독 ${fmtKo(c.subscribers)}${tierLabel ? ' · ' + tierLabel : ''}] "${c.title}" — 조회 ${fmtKo(c.views)} (구독자의 ${c.ratio}배) · ${c.publishedAt} · ${c.sec <= 60 ? '숏폼' : Math.round(c.sec / 60) + '분'} · ${c.url}`);
  });
  if (r.errors.length) L.push('※ 일부 조회 실패: ' + r.errors.join('; '));
  return L.join('\n');
}

// UI 용 요약
export function summarizeReferences(r) {
  if (!r) return null;
  return {
    topic: r.topic, ok: r.ok, cached: r.cached, errors: r.errors.slice(0, 3),
    tiers: r.tiers.map((t) => ({ key: t.key, label: t.label, channels: t.channels.map((c) => ({ id: c.id, title: c.title, handle: c.handle, subscribers: c.subscribers, url: c.handle ? 'https://www.youtube.com/' + c.handle : 'https://www.youtube.com/channel/' + c.id })) })),
    contents: r.contents.map((c) => ({ id: c.id, title: c.title, channelTitle: c.channelTitle, subscribers: c.subscribers, views: c.views, ratio: c.ratio, publishedAt: c.publishedAt, thumb: c.thumb, url: c.url })),
  };
}

export const REFERENCE_GUIDE = `[레퍼런스 채널 추천 지침]
디렉터가 참여자에게 추천할 레퍼런스 채널을 요청했고, user 턴에 '레퍼런스 채널 리서치' 블록과 썸네일 이미지가 있다. 아래 순서로 답한다.
1) 주제 확인 한 줄: 무엇을 기준으로 찾았는지(주제·타겟).
2) 채널 9개를 구간별로(10만 이상 / 1만~10만 / 1만 이하). 각 채널마다: 이름(링크 가능하면 핸들) · 구독자 · 이 채널에서 '무엇을' 배울지 한 줄(주제 잡는 법·페르소나·구조·업로드 패턴 중 하나로 구체적으로). 커밍쏜 기준으로 1만~10만과 1만 이하 구간이 참여자가 실제로 따라할 모델이고, 10만 이상은 '왜 되는지'를 뽑는 용도라고 구분해 말한다. 구간에 채널이 부족하면 부족하다고 말하고 채우지 않는다.
3) 발견될 확률이 높은 콘텐츠: 블록의 #번호 순서대로(기준: 구독자 대비 조회수 5배 이상 + 조회 1만 이상). 블록에 있는 개수만큼만 — 9개가 안 되면 "기준을 넘는 영상은 n개"라고 말하고 채우지 않는다. 각각 소재(무슨 이야기인지) · 제목의 구조(어떤 훅인지: 숫자·역설·경고·질문·당사자 고백 등) · 썸네일 구성(첨부 이미지를 보고: 인물·표정·텍스트 문구·색·배치) · 왜 구독자 대비 조회가 높은지 한 줄. 마지막에 참여자 주제로 바꾼 제목 예시 1개.
4) 마무리: 참여자가 이번 주에 볼 채널 3개와 만들어볼 소재 3개를 고른다(커밍쏜 기준: 소재는 대중성, 차별화는 메시지·페르소나).
숫자·채널·영상은 블록에 있는 것만 쓴다. 블록에 없는 채널을 기억으로 추가하지 않는다. 이미지가 없는 영상의 썸네일은 설명하지 않는다.`;
