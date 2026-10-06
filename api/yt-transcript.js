// ─────────────────────────────────────────────────────────────────────────────
// api/yt-transcript.js — GET /api/yt-transcript?v=<videoId>[&lang=ko][&debug=1]
//
// 컨설팅 녹화(일부공개 영상)의 자동 자막을 텍스트로 돌려준다. consult-case 스킬이 클라우드 세션에서
// 유튜브에 직접 닿지 못할 때 쓰는 우회로. 키·로그인 없음(공개·일부공개만). 비공개(private)는 안 된다.
//
// 경로 (앞에서 자막을 얻으면 멈춘다)
//   1) 유튜브 앱 클라이언트(InnerTube player API) — 웹 페이지가 서버 IP 를 "봇 확인"으로 막아도
//      앱 클라이언트는 통과하는 경우가 많고, 자막 주소에 PO 토큰이 필요 없다.
//   2) 웹 watch 페이지의 captionTracks — 예전 방식. 요즘은 자막 주소에 PO 토큰이 붙어 본문이 비는 일이 많다.
// 한계(2026-10-06 확인): 유튜브가 데이터센터 IP 에 "로그인하여 봇이 아님을 확인하세요"를 요구하면
// 모든 경로가 막힌다. iad1(미국)·icn1(서울) 둘 다 동일. 그때는 스크립트 텍스트를 직접 받아야 한다.
// 실패하면 경로별로 유튜브가 준 사유(playabilityStatus.reason)를 그대로 돌려준다 —
// "비공개"와 "서버 접근 차단(봇 확인)"을 구분하기 위해서다.
// ─────────────────────────────────────────────────────────────────────────────
export const config = { maxDuration: 60 };
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// 유튜브가 버전을 자주 올린다. 막히면 이 표만 갱신하면 된다.
const CLIENTS = [
  {
    name: 'ANDROID_VR', id: 28,
    client: { clientName: 'ANDROID_VR', clientVersion: '1.62.27', deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L' },
    ua: 'com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
  },
  {
    name: 'IOS', id: 5,
    client: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' },
    ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
  },
  {
    name: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', id: 85,
    client: { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0' },
    ua: WEB_UA, thirdParty: true,
  },
  {
    name: 'MWEB', id: 2,
    client: { clientName: 'MWEB', clientVersion: '2.20250311.03.00' },
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },
];

function decodeXml(s) { return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)); }

const trackName = (t) => (t.name && (t.name.simpleText || (t.name.runs || []).map((r) => r.text).join(''))) || '';

function pickTrack(tracks, lang) {
  const list = (tracks || []).map((t) => ({ lang: t.languageCode, kind: t.kind || '', name: trackName(t), url: t.baseUrl }));
  const base = lang.split('-')[0];
  const pick = list.find((t) => t.lang === lang && t.kind !== 'asr') || list.find((t) => t.lang === lang)
    || list.find((t) => (t.lang || '').startsWith(base)) || list[0];
  return { list, pick };
}

// 자막 본문 받기. json3 → srv3/XML 순으로 시도한다.
async function fetchCaptionText(url, ua) {
  const tries = [];
  const clean = String(url).replace(/&fmt=[^&]*/, '');
  for (const fmt of ['json3', '']) {
    const u = fmt ? clean + '&fmt=' + fmt : clean;
    try {
      const r = await fetch(u, { headers: { 'User-Agent': ua || WEB_UA, 'Accept-Language': 'ko-KR,ko;q=0.9' }, signal: AbortSignal.timeout(20000) });
      const body = await r.text();
      tries.push({ fmt: fmt || 'xml', status: r.status, chars: body.length });
      if (!body) continue;
      let text = '';
      if (fmt === 'json3') {
        let j = null; try { j = JSON.parse(body); } catch (e) {}
        const segs = [];
        for (const ev of (j && j.events) || []) { const t = (ev.segs || []).map((s) => s.utf8 || '').join('').replace(/\n/g, ' ').trim(); if (t) segs.push(t); }
        text = segs.join(' ');
      } else {
        // <text start=..>..</text> (timedtext) 또는 <p t=..><s>..</s></p> (srv3)
        const parts = [];
        const re = /<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/g;
        let m; while ((m = re.exec(body))) { const t = decodeXml(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(); if (t) parts.push(t); }
        text = parts.join(' ');
      }
      text = text.replace(/\s+/g, ' ').trim();
      if (text) return { text, tries };
    } catch (e) {
      tries.push({ fmt: fmt || 'xml', error: String(e.message).slice(0, 80) });
    }
  }
  return { text: '', tries };
}

async function viaClient(v, lang, c) {
  const body = {
    context: { client: Object.assign({ hl: 'ko', gl: 'KR' }, c.client) },
    videoId: v,
    contentCheckOk: true,
    racyCheckOk: true,
  };
  if (c.thirdParty) body.context.thirdParty = { embedUrl: 'https://www.youtube.com/' };
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'User-Agent': c.ua, 'Accept-Language': 'ko-KR,ko;q=0.9',
      'X-YouTube-Client-Name': String(c.id), 'X-YouTube-Client-Version': c.client.clientVersion,
      Origin: 'https://www.youtube.com',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => null);
  const ps = (j && j.playabilityStatus) || {};
  const title = (j && j.videoDetails && j.videoDetails.title) || '';
  const tracks = j && j.captions && j.captions.playerCaptionsTracklistRenderer && j.captions.playerCaptionsTracklistRenderer.captionTracks;
  const diag = { client: c.name, http: r.status, status: ps.status || '', reason: ps.reason || '', tracks: (tracks || []).length };
  if (!tracks || !tracks.length) return { ok: false, title, diag };
  const { list, pick } = pickTrack(tracks, lang);
  const got = await fetchCaptionText(pick.url, c.ua);
  diag.fetch = got.tries;
  return { ok: !!got.text, title, diag, text: got.text, lang: pick.lang, kind: pick.kind, tracks: list.map(({ url, ...x }) => x) };
}

async function viaWebPage(v, lang) {
  const page = await fetch(`https://www.youtube.com/watch?v=${v}&hl=ko`, { headers: { 'User-Agent': WEB_UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Cookie: 'CONSENT=YES+1' }, signal: AbortSignal.timeout(20000) });
  const html = await page.text();
  const title = decodeXml((html.match(/<meta name="title" content="([^"]*)"/) || [])[1] || '');
  const status = (html.match(/"playabilityStatus":\{"status":"([A-Z_]+)"/) || [])[1] || '';
  const reason = decodeXml((html.match(/"playabilityStatus":\{"status":"[A-Z_]+","reason":"([^"]*)"/) || [])[1] || '');
  const diag = { client: 'WEB_PAGE', http: page.status, status, reason, htmlChars: html.length };
  const m = html.match(/"captionTracks":(\[.*?\])/);
  if (!m) return { ok: false, title, diag };
  let tracks; try { tracks = JSON.parse(m[1]); } catch (e) { diag.error = '자막 목록 파싱 실패'; return { ok: false, title, diag }; }
  diag.tracks = tracks.length;
  const { list, pick } = pickTrack(tracks, lang);
  const got = await fetchCaptionText(pick.url, WEB_UA);
  diag.fetch = got.tries;
  return { ok: !!got.text, title, diag, text: got.text, lang: pick.lang, kind: pick.kind, tracks: list.map(({ url, ...x }) => x) };
}

// 사람이 읽을 결론. 경로별 사유를 보고 "비공개"와 "서버 차단"을 가른다.
function summarize(diags) {
  const all = diags.map((d) => (d.status + ' ' + d.reason)).join(' | ');
  if (/private|비공개/i.test(all)) return '영상이 비공개(private)입니다 — 일부공개로 바꿔야 서버가 읽을 수 있어요';
  if (/bot|봇|confirm you/i.test(all)) return '유튜브가 서버 접근을 봇 확인으로 막음 (영상 공개 설정 문제 아님)';
  if (/age|연령/i.test(all)) return '연령 제한 영상이라 로그인 없이 못 읽음';
  if (diags.some((d) => d.tracks === 0 && d.status === 'OK')) return '재생은 되지만 자막 트랙이 없음 (자동 자막 미생성 — 업로드 후 수 시간 걸릴 수 있음)';
  if (diags.some((d) => d.tracks > 0)) return '자막 목록은 받았지만 본문을 못 받음 (유튜브 PO 토큰 요구 추정)';
  return '모든 경로 실패: ' + all.slice(0, 200);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const v = String((req.query && req.query.v) || '').trim();
  const lang = String((req.query && req.query.lang) || 'ko').trim().slice(0, 8);
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(v)) return res.status(400).json({ error: 'v(영상 id) 필요' });

  const diags = [];
  let title = '';
  for (const c of CLIENTS) {
    try {
      const r = await viaClient(v, lang, c);
      diags.push(r.diag); if (r.title && !title) title = r.title;
      if (r.ok) return res.status(200).json({ ok: true, v, title, via: c.name, lang: r.lang, kind: r.kind, tracks: r.tracks, chars: r.text.length, text: r.text, diag: diags });
    } catch (e) {
      diags.push({ client: c.name, error: String(e.message).slice(0, 120) });
    }
  }
  try {
    const r = await viaWebPage(v, lang);
    diags.push(r.diag); if (r.title && !title) title = r.title;
    if (r.ok) return res.status(200).json({ ok: true, v, title, via: 'WEB_PAGE', lang: r.lang, kind: r.kind, tracks: r.tracks, chars: r.text.length, text: r.text, diag: diags });
  } catch (e) {
    diags.push({ client: 'WEB_PAGE', error: String(e.message).slice(0, 120) });
  }
  return res.status(200).json({ ok: false, v, title, reason: summarize(diags), region: process.env.VERCEL_REGION || '', diag: diags });
}
