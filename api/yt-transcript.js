// ─────────────────────────────────────────────────────────────────────────────
// api/yt-transcript.js — GET /api/yt-transcript?v=<videoId>[&lang=ko]
//
// 컨설팅 녹화(일부공개 영상)의 자동 자막을 텍스트로 돌려준다. consult-case 스킬이 클라우드 세션에서
// 유튜브에 직접 닿지 못할 때 쓰는 우회로. 영상 페이지의 captionTracks 에서 자막 주소를 찾아 받는다.
// 키·로그인 없음(공개 데이터만). 비공개(private) 영상은 안 된다. 유튜브가 서버 IP 를 막으면 빈 결과.
// ─────────────────────────────────────────────────────────────────────────────
export const config = { maxDuration: 60 };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function decodeXml(s) { return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)); }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const v = String((req.query && req.query.v) || '').trim();
  const lang = String((req.query && req.query.lang) || 'ko').trim().slice(0, 8);
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(v)) return res.status(400).json({ error: 'v(영상 id) 필요' });
  try {
    const page = await fetch(`https://www.youtube.com/watch?v=${v}&hl=ko`, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Cookie: 'CONSENT=YES+1' }, signal: AbortSignal.timeout(20000) });
    const html = await page.text();
    const title = decodeXml((html.match(/<meta name="title" content="([^"]*)"/) || [])[1] || (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '');
    const status = (html.match(/"playabilityStatus":\{"status":"([A-Z_]+)"/) || [])[1] || '';
    const m = html.match(/"captionTracks":(\[.*?\])/);
    if (!m) return res.status(200).json({ ok: false, v, title, status, reason: /LOGIN_REQUIRED|UNPLAYABLE|ERROR/.test(status) ? '영상이 비공개이거나 재생 불가 (' + status + ')' : (/consent|robot|bot/i.test(html) ? '유튜브가 서버 접근을 막음' : '자막 트랙 없음 (자동 자막 미생성?)'), htmlChars: html.length });
    let tracks; try { tracks = JSON.parse(m[1]); } catch (e) { return res.status(200).json({ ok: false, v, title, reason: '자막 목록 파싱 실패' }); }
    const list = tracks.map((t) => ({ lang: t.languageCode, kind: t.kind || '', name: (t.name && (t.name.simpleText || (t.name.runs || []).map((r) => r.text).join(''))) || '', url: t.baseUrl }));
    const pick = list.find((t) => t.lang === lang && t.kind !== 'asr') || list.find((t) => t.lang === lang) || list.find((t) => t.lang.startsWith(lang.split('-')[0])) || list[0];
    if (!pick) return res.status(200).json({ ok: false, v, title, reason: '자막 없음', tracks: list.map(({ url, ...r }) => r) });
    const r2 = await fetch(pick.url.replace(/&fmt=[^&]*/, '') + '&fmt=json3', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    const j = await r2.json().catch(() => null);
    const events = (j && j.events) || [];
    const segs = [];
    for (const ev of events) { const t = (ev.segs || []).map((s) => s.utf8 || '').join('').replace(/\n/g, ' ').trim(); if (t) segs.push(t); }
    const text = segs.join(' ').replace(/\s+/g, ' ').trim();
    return res.status(200).json({ ok: text.length > 0, v, title, lang: pick.lang, kind: pick.kind, tracks: list.map(({ url, ...r }) => r), chars: text.length, text });
  } catch (e) {
    return res.status(200).json({ ok: false, v, reason: '호출 실패: ' + String(e.message).slice(0, 120) });
  }
}
