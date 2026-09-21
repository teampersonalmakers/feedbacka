// ─────────────────────────────────────────────────────────────────────────────
// api/_channels.js — 롤모델 유튜브 채널 리서치
//
// 참여자가 "롤모델: 닥터딩요, 피부심" 처럼 채널을 적어 내면, 그 채널의 공개 데이터를
// 실제로 조회해서 프롬프트에 넣는다. 그 전에는 AI 가 이름만 보고 기억(추측)으로
// 말했다. 숫자·주제가 틀리면 피드백 전체가 흔들리므로, 조회된 값만 쓰게 한다.
//
// 흐름
//   1) 신호 감지   — URL 이 있거나 '롤모델·벤치마킹·레퍼런스·유튜버' 같은 말이 있을 때만
//   2) 언급 추출   — URL 은 정규식으로, 이름만 적힌 것은 Sonnet 에 JSON 으로 뽑게 한다
//   3) 데이터 조회 — YouTube Data API v3 (channels/search/playlistItems/videos)
//                    구독자·영상 수·최근 업로드 빈도·최근 영상 제목·조회 상위 영상·숏폼 비율
//   4) 캐시        — Firestore channels/{key} 7일. 같은 채널을 대화마다 다시 안 부른다.
//   5) 폴백        — 키가 없거나 조회 실패한 채널은 목록으로 돌려주고, feedback.js 가
//                    Claude 웹 검색 도구를 켜서 직접 찾아보게 한다.
//
// 실패해도 절대 throw 하지 않는다. 리서치는 있으면 좋은 것이지 답변을 막을 이유가 아니다.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';
import { GoogleAuth } from 'google-auth-library';
import { getDb, readServiceAccount } from './_firestore.js';
import { claudeHeaders, claudeBody, pickText } from './_claude.js';

const YT = 'https://www.googleapis.com/youtube/v3';
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const RECENT_N = 25;          // 최근 업로드 몇 편을 볼지
const MAX_CHANNELS = 5;       // 한 요청에서 조회할 채널 수 상한 (검색 100유닛 × 5 = 하루 한도 10,000 의 5%)

// 이름만 적힌 채널을 뽑는 데 쓰는 모델. 사고 없이 짧게 — 1초 안팎.
const EXTRACT_MODEL = 'claude-sonnet-5';

const _mem = new Map();       // 인스턴스 메모리 캐시 (Firestore 앞단)

// ─── 1) 신호 감지 ─────────────────────────────────────────────────────────────
const URL_RE = /https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:@([\w.\-]+)|channel\/(UC[\w\-]{20,})|c\/([\w.\-%]+)|user\/([\w.\-]+))/gi;
const TRIGGER_RE = /롤모델|롤 모델|벤치마킹|벤치마크|레퍼런스|참고\s*채널|좋아하는\s*채널|구독\s*(?:하는|중인)\s*채널|닮고\s*싶은|유튜버|채널\s*분석|이런\s*채널|같은\s*채널/;

export function hasChannelSignal(text) {
  const t = String(text || '');
  URL_RE.lastIndex = 0;
  return URL_RE.test(t) || TRIGGER_RE.test(t);
}

// ─── 2) 언급 추출 ─────────────────────────────────────────────────────────────
// 돌려주는 값: [{ name, handle, channelId, hint }]
//   URL 이 있으면 정규식으로 확정(검색 없이 1유닛), 이름만 있으면 모델이 뽑는다.
export async function extractChannelMentions(text, claudeKey) {
  const t = String(text || '').slice(0, 6000);
  const out = [];
  const seen = new Set();
  const push = (m) => {
    const key = (m.channelId || m.handle || m.name || '').toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(m);
  };

  URL_RE.lastIndex = 0;
  let mt;
  while ((mt = URL_RE.exec(t))) {
    if (mt[1]) push({ name: '@' + mt[1], handle: '@' + mt[1], channelId: '', hint: '' });
    else if (mt[2]) push({ name: mt[2], handle: '', channelId: mt[2], hint: '' });
    else if (mt[3] || mt[4]) push({ name: decodeURIComponent(mt[3] || mt[4]), handle: '', channelId: '', hint: '' });
  }

  if (TRIGGER_RE.test(t) && claudeKey) {
    try {
      const names = await extractNamesWithModel(t, claudeKey);
      for (const n of names) push(n);
    } catch (e) {
      console.warn('[channels] 이름 추출 실패(무시):', e.message.slice(0, 120));
    }
  }
  return out.slice(0, MAX_CHANNELS);
}

const EXTRACT_SYSTEM = `당신은 텍스트에서 유튜브 채널 언급을 뽑는 추출기다.
뽑을 것: 글쓴이(참여자·수강생·디렉터)가 롤모델, 벤치마킹, 레퍼런스, 좋아하는·구독하는·닮고 싶은 채널로 든 유튜브 채널.
뽑지 말 것: 글쓴이 본인의 채널, 일반 명사(예: "요리 채널", "브이로그 채널"), 유튜브가 아닌 플랫폼, 커밍쏜·퍼스널메이커스 자체.
채널명은 본문에 적힌 그대로. 사람 이름과 채널명이 함께 있으면 둘 다 name 에 넣는다(예: "피부심 심현철").
출력은 JSON 배열만. 다른 말은 쓰지 않는다.
[{"name":"채널명","handle":"@핸들 또는 빈 문자열","hint":"본문에 적힌 그 채널 설명 한 줄, 없으면 빈 문자열"}]
언급이 없으면 [] 만 출력한다.`;

async function extractNamesWithModel(text, claudeKey) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: claudeHeaders(claudeKey),
    body: claudeBody(EXTRACT_SYSTEM, '[본문]\n' + text, { model: EXTRACT_MODEL, maxTokens: 600, thinking: false, fallbacks: false }),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  const raw = pickText(data).trim();
  const s = raw.indexOf('['), e = raw.lastIndexOf(']');
  if (s < 0 || e < s) return [];
  const arr = JSON.parse(raw.slice(s, e + 1));
  return (Array.isArray(arr) ? arr : [])
    .filter((x) => x && typeof x.name === 'string' && x.name.trim())
    .map((x) => ({
      name: x.name.trim().slice(0, 60),
      handle: /^@[\w.\-]+$/.test(String(x.handle || '').trim()) ? String(x.handle).trim() : '',
      channelId: '',
      hint: String(x.hint || '').trim().slice(0, 160),
    }));
}

// ─── 인증 ─────────────────────────────────────────────────────────────────────
// 두 경로 중 되는 것을 쓴다.
//   1) YOUTUBE_API_KEY 환경변수 (전용 API 키)
//   2) Firestore 에 쓰는 서비스 계정의 OAuth 토큰 — 공개 데이터 읽기는 이걸로 충분하다.
//      키를 따로 만들 필요 없이 GCP 프로젝트에서 YouTube Data API v3 만 켜면 된다.
// 돌려주는 값: { key } | { bearer } | null
let _tok = null;   // { bearer, exp }
export async function youtubeAuth() {
  const key = (process.env.YOUTUBE_API_KEY || '').trim();
  if (key) return { key };
  if (_tok && Date.now() < _tok.exp) return { bearer: _tok.bearer };
  const sa = readServiceAccount();
  if (!sa) return null;
  try {
    const auth = new GoogleAuth({ credentials: sa, projectId: sa.project_id, scopes: ['https://www.googleapis.com/auth/youtube.readonly'] });
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) return null;
    _tok = { bearer: token, exp: Date.now() + 50 * 60 * 1000 };
    return { bearer: token };
  } catch (e) {
    console.warn('[channels] 서비스 계정 토큰 실패:', e.message.slice(0, 120));
    return null;
  }
}
export const YT_ENABLE_URL = 'https://console.cloud.google.com/apis/library/youtube.googleapis.com';

// ─── 3) YouTube Data API 조회 ─────────────────────────────────────────────────
class YtError extends Error {
  constructor(status, reason, message) { super(message); this.status = status; this.reason = reason; }
}

async function yt(path, params, auth) {
  const u = new URL(YT + path);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, String(v));
  const headers = {};
  if (auth && auth.key) u.searchParams.set('key', auth.key);
  else if (auth && auth.bearer) headers.Authorization = 'Bearer ' + auth.bearer;
  const r = await fetch(u, { headers, signal: AbortSignal.timeout(8000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    const err = (data.error && data.error.errors && data.error.errors[0]) || {};
    throw new YtError(r.status, err.reason || (data.error && data.error.status) || '', (data.error && data.error.message) || ('HTTP ' + r.status));
  }
  return data;
}

// 키 자체가 못 쓰는 상태(미설정·API 미활성·한도 소진)인지 — 채널 하나가 아니라 전체를 웹 검색으로 돌려야 한다.
export function isKeyLevelFailure(e) {
  if (!(e instanceof YtError)) return false;
  // 'required' = Login Required(401): 키가 이 API 에 안 맞는 경우(예: Gemini 키를 YouTube 에 쓸 때)
  return ['accessNotConfigured', 'keyInvalid', 'forbidden', 'quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'PERMISSION_DENIED', 'required'].includes(e.reason)
    || e.status === 401 || e.status === 403
    || (e.status === 400 && /API key/i.test(e.message));
}

function isoDurationSec(d) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || '');
  if (!m) return 0;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

async function resolveChannelId(mention, key) {
  if (mention.channelId) return { id: mention.channelId, via: 'id' };
  if (mention.handle) {
    const d = await yt('/channels', { part: 'id', forHandle: mention.handle }, key);
    if (d.items && d.items[0]) return { id: d.items[0].id, via: 'handle' };
  }
  // 이름 검색 — 100유닛. 채널 타입만, 한국어 우선.
  const q = mention.name.replace(/^@/, '');
  const d = await yt('/search', { part: 'snippet', type: 'channel', q, maxResults: 3, relevanceLanguage: 'ko' }, key);
  const items = d.items || [];
  if (!items.length) return null;
  // 제목이 이름과 겹치는 것을 우선, 없으면 첫 결과.
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
  const nq = norm(q);
  const best = items.find((it) => { const nt = norm(it.snippet && it.snippet.title); return nt && (nt.includes(nq) || nq.includes(nt)); }) || items[0];
  return { id: best.snippet.channelId || best.id.channelId, via: 'search' };
}

async function fetchProfile(mention, key) {
  const r = await resolveChannelId(mention, key);
  if (!r) return null;
  const ch = await yt('/channels', { part: 'snippet,statistics,contentDetails', id: r.id }, key);
  const c = ch.items && ch.items[0];
  if (!c) return null;
  const sn = c.snippet || {}, st = c.statistics || {};
  const uploads = c.contentDetails && c.contentDetails.relatedPlaylists && c.contentDetails.relatedPlaylists.uploads;

  let videos = [];
  if (uploads) {
    try {
      const pl = await yt('/playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: RECENT_N }, key);
      const ids = (pl.items || []).map((it) => it.contentDetails && it.contentDetails.videoId).filter(Boolean);
      if (ids.length) {
        const vd = await yt('/videos', { part: 'snippet,statistics,contentDetails', id: ids.join(','), maxResults: RECENT_N }, key);
        videos = (vd.items || []).map((v) => ({
          title: String((v.snippet && v.snippet.title) || '').slice(0, 90),
          views: +((v.statistics && v.statistics.viewCount) || 0),
          publishedAt: (v.snippet && v.snippet.publishedAt) || '',
          sec: isoDurationSec(v.contentDetails && v.contentDetails.duration),
        }));
      }
    } catch (e) {
      if (isKeyLevelFailure(e)) throw e;
      console.warn('[channels] 영상 목록 실패(채널 정보만 사용):', e.message.slice(0, 100));
    }
  }

  videos.sort((a, b) => (b.publishedAt > a.publishedAt ? 1 : -1));
  const n = videos.length;
  let perMonth = 0;
  if (n >= 2) {
    const newest = Date.parse(videos[0].publishedAt), oldest = Date.parse(videos[n - 1].publishedAt);
    const months = Math.max((newest - oldest) / (30 * 86400000), 0.5);
    perMonth = Math.round((n / months) * 10) / 10;
  }
  const shorts = videos.filter((v) => v.sec > 0 && v.sec <= 60).length;
  const avgViews = n ? Math.round(videos.reduce((s, v) => s + v.views, 0) / n) : 0;
  const top = videos.slice().sort((a, b) => b.views - a.views).slice(0, 5);

  return {
    id: c.id,
    query: mention.name,
    hint: mention.hint || '',
    via: r.via,
    title: String(sn.title || '').slice(0, 80),
    handle: String(sn.customUrl || '').slice(0, 60),
    description: String(sn.description || '').replace(/\s+/g, ' ').slice(0, 400),
    country: sn.country || '',
    publishedAt: (sn.publishedAt || '').slice(0, 10),
    subscribers: st.hiddenSubscriberCount ? -1 : +(st.subscriberCount || 0),
    videoCount: +(st.videoCount || 0),
    viewCount: +(st.viewCount || 0),
    recent: { n, perMonth, shorts, avgViews, lastUpload: n ? videos[0].publishedAt.slice(0, 10) : '' },
    recentTitles: videos.slice(0, 6).map((v) => ({ title: v.title, views: v.views, date: v.publishedAt.slice(0, 10) })),
    topRecent: top.map((v) => ({ title: v.title, views: v.views, date: v.publishedAt.slice(0, 7) })),
    fetchedAt: Date.now(),
  };
}

// ─── 4) 캐시 ───────────────────────────────────────────────────────────────────
function cacheKey(m) {
  return crypto.createHash('sha1').update((m.channelId || m.handle || m.name || '').toLowerCase().trim()).digest('hex').slice(0, 24);
}

async function cacheGet(key) {
  const m = _mem.get(key);
  if (m && Date.now() - m.fetchedAt < CACHE_TTL_MS) return m;
  const db = getDb();
  if (!db) return null;
  try {
    const s = await db.collection('channels').doc(key).get();
    if (!s.exists) return null;
    const v = s.data();
    if (!v || Date.now() - (v.fetchedAt || 0) >= CACHE_TTL_MS) return null;
    _mem.set(key, v);
    return v;
  } catch (e) { return null; }
}

function cachePut(key, v) {
  _mem.set(key, v);
  const db = getDb();
  if (!db) return;
  db.collection('channels').doc(key).set(v).catch((e) => console.warn('[channels] 캐시 저장 실패:', e.message.slice(0, 80)));
}

// 상태 확인용 — 어느 인증으로 실제 조회가 되는지. channels.list 1유닛.
export async function probeYouTube() {
  const auth = await youtubeAuth();
  const via = auth ? (auth.key ? 'YOUTUBE_API_KEY' : 'service-account') : 'none';
  if (!auth) return { youtube: 'no-auth', via };
  try {
    await yt('/channels', { part: 'id', forHandle: '@youtube' }, auth);
    return { youtube: 'ok', via };
  } catch (e) {
    const sa = readServiceAccount();
    const out = { youtube: 'error', via, reason: e.reason || String(e.status || ''), message: String(e.message || '').slice(0, 160) };
    if (e.reason === 'accessNotConfigured' || /has not been used|is disabled/i.test(e.message)) {
      out.fix = 'GCP 프로젝트에서 YouTube Data API v3 를 사용 설정하세요: ' + YT_ENABLE_URL + (sa ? '?project=' + sa.project_id : '');
    }
    return out;
  }
}

// ─── 공개 API ─────────────────────────────────────────────────────────────────
// mentions → { profiles: [...], unresolved: [{name,hint}], backend: 'youtube'|'none', keyFailed: bool }
export async function researchChannels(mentions, auth) {
  const profiles = [], unresolved = [];
  let keyFailed = false;
  if (!mentions.length) return { profiles, unresolved, backend: 'none', keyFailed };

  await Promise.all(mentions.map(async (m) => {
    const key = cacheKey(m);
    const hit = await cacheGet(key);
    if (hit) { profiles.push(Object.assign({}, hit, { query: m.name, hint: m.hint || hit.hint || '', cached: true })); return; }
    if (!auth || keyFailed) { unresolved.push({ name: m.name, hint: m.hint || '' }); return; }
    try {
      const p = await fetchProfile(m, auth);
      if (!p) { unresolved.push({ name: m.name, hint: m.hint || '' }); return; }
      cachePut(key, p);
      profiles.push(p);
    } catch (e) {
      if (isKeyLevelFailure(e)) keyFailed = true;
      console.warn('[channels] 조회 실패:', m.name, '—', e.reason || '', e.message.slice(0, 120));
      unresolved.push({ name: m.name, hint: m.hint || '' });
    }
  }));

  // 같은 채널이 URL 과 이름으로 두 번 적힌 경우 — 조회 후 채널 ID 로 하나로 합친다.
  const byId = new Map();
  for (const p of profiles) {
    const prev = byId.get(p.id);
    if (!prev) byId.set(p.id, p);
    else if (!prev.hint && p.hint) prev.hint = p.hint;
  }
  const uniq = [...byId.values()];
  return { profiles: uniq, unresolved, backend: uniq.length ? 'youtube' : 'none', keyFailed };
}

// 숫자를 한국식으로. 1234567 → 123.5만, 320000000 → 3.2억
export function fmtKo(n) {
  if (n == null || n < 0) return '비공개';
  if (n >= 1e8) return (Math.round(n / 1e7) / 10) + '억';
  if (n >= 1e4) return (n >= 1e6 ? Math.round(n / 1e4) : Math.round(n / 1e3) / 10) + '만';
  return String(n);
}

// 프롬프트 블록. 조회된 값만 넣는다 — 모델이 여기 없는 숫자를 말하면 지어낸 것이다.
export function formatChannelBlock(profiles, unresolved, todayStr) {
  if (!profiles.length && !unresolved.length) return '';
  const lines = ['[롤모델 채널 리서치 — YouTube 공개 데이터, 조회 기준 ' + todayStr + ']'];
  for (const p of profiles) {
    const head = `■ ${p.title}${p.handle ? ' (' + p.handle + ')' : ''}` +
      (p.query && p.query.replace(/^@/, '') !== p.title ? ` ← 참여자 표기 "${p.query}"` : '') +
      (p.via === 'search' ? ' [이름 검색 결과 — 동명 채널일 수 있음]' : '');
    lines.push(head);
    lines.push(`  규모: 구독자 ${fmtKo(p.subscribers)} · 영상 ${fmtKo(p.videoCount)}개 · 누적 조회 ${fmtKo(p.viewCount)} · 개설 ${p.publishedAt || '?'}`);
    if (p.description) lines.push(`  채널 소개: ${p.description}`);
    if (p.hint) lines.push(`  참여자가 적은 이유: ${p.hint}`);
    const r = p.recent || {};
    if (r.n) {
      lines.push(`  최근 ${r.n}편: 월 ${r.perMonth}편 업로드 · 평균 조회 ${fmtKo(r.avgViews)} · 숏폼 ${r.shorts}편(${Math.round(r.shorts / r.n * 100)}%) · 마지막 업로드 ${r.lastUpload}`);
      lines.push('  최근 영상: ' + (p.recentTitles || []).map((v) => `${v.title} (${fmtKo(v.views)}, ${v.date})`).join(' / '));
      lines.push('  최근 편 중 조회 상위: ' + (p.topRecent || []).map((v) => `${v.title} (${fmtKo(v.views)}, ${v.date})`).join(' / '));
    }
  }
  if (unresolved.length) {
    lines.push('※ 자동 조회가 안 된 채널: ' + unresolved.map((u) => u.name + (u.hint ? ` (참여자 설명: ${u.hint})` : '')).join(', '));
  }
  return lines.join('\n');
}

// 디렉터 화면에 "무엇을 봤는지" 한 줄로 보여주기 위한 요약.
export function summarizeChannels(profiles, unresolved) {
  return profiles.map((p) => ({
    name: p.title, handle: p.handle || '', subscribers: p.subscribers, videoCount: p.videoCount,
    perMonth: (p.recent && p.recent.perMonth) || 0, resolved: true, cached: !!p.cached,
    url: p.handle ? 'https://www.youtube.com/' + p.handle : (p.id ? 'https://www.youtube.com/channel/' + p.id : ''),
  })).concat(unresolved.map((u) => ({ name: u.name, resolved: false })));
}
