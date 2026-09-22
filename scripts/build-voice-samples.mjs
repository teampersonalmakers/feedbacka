// ─────────────────────────────────────────────────────────────────────────────
// scripts/build-voice-samples.mjs — 커밍쏜 실제 발화 샘플 만들기 (유튜브 자막 → guidelines/voice)
//
// 왜 유튜브 자막인가: 컨설팅 녹취는 화자 표시가 없어 수강생 말이 섞인다. 커밍쏜 채널 자막은
// 100% 커밍쏜 본인 말이라 말투 근거로 안전하다. 문장은 자막 원문 그대로 가져오고 다듬지 않는다.
//
// 규칙(결정적): 유튜브 자막 청크에서 문장 단위로 나눠 30~130자, 코칭 어휘 포함, 인사·구독 요청·
// 효과음 제외, 한 영상에서 최대 2문장, 영상 이름순 → 최대 30문장. guidelines/voice 에 lines 로 저장.
// 커밍쏜은 설정 › AI 지침 › '커밍쏜 실제 발화 샘플' 카드에서 고치거나 지울 수 있다.
//
// 사용: FIREBASE_SERVICE_ACCOUNT=… node scripts/build-voice-samples.mjs [--dry-run] [--max 40]
// ─────────────────────────────────────────────────────────────────────────────
import { getDb, COL } from '../api/_firestore.js';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const MAX = Number((args[args.indexOf('--max') + 1]) || 30) || 30;
const PER_DOC = 1;   // 영상당 1문장 — 다양성 우선

const VOCAB = /브랜딩|브랜드|채널|콘텐츠|구독자|메시지|결핍|타겟|수익|조회수|썸네일|서사|페르소나|라이프스타일|주제|유튜브|영향력|팬|나만의|과거의 나|정보|감정|뾰족/;
const BAN = /안녕하세요|구독|좋아요|알림|광고|협찬|링크|댓글로|\[|\]|ㅋㅋ|하하|영상 끝|다음 영상|오늘 영상|이번 영상|제목:|URL:|&gt;|&lt;|&amp;|라이브|북토크|강연|뉴스레터|로마|발리|디지털 ?노마드|씨라는 채널|오늘은|님 영상|님 콘텐츠|님이랑|커밍선|축하|일정이라고|일본이었다/;
// 커밍쏜다운 문장에 가산 — 판단·지시·강조가 들어간 말
const STRONG = /해야 돼요|해야 됩니다|하셔야|버려야|버리세요|안 돼요|안 됩니다|중요해요|중요합니다|거든요|잖아요|이라는 거|라는 거예요|의미를 가질까|뭐냐면|왜냐면|결국에는|무조건|절대/;
const END = /(요|죠|다|까|잖아요|거든요|니다|네요|래요|세요|어요|아요)[.!?…]?$/;

function sentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}
function good(s) {
  if (s.length < 30 || s.length > 120) return false;
  if (BAN.test(s)) return false;
  if (!END.test(s)) return false;
  if (!VOCAB.test(s)) return false;
  if ((s.match(/\s/g) || []).length < 5) return false;       // 단어 5개 미만은 조각일 확률
  if (!/^[가-힣A-Za-z0-9"'(]/.test(s)) return false;          // 문장 첫 글자가 이상하면(조각) 제외
  if (/^(어|음|아|네|근데|그니까|그래서|이제|그러니까|그러다|그러면|그랬을)[ ,]/.test(s)) return false;
  if (/^[가-힣]{1,2} /.test(s) && !/^(내가|내|지금|결국|우리|여러분|정보|주제|콘텐츠|채널|유튜브|브랜딩|메시지|그냥|단순|사실|이건|이게|이걸|이제) /.test(s)) return false;  // "렸는데 …" 같은 잘린 시작
  return true;
}
function score(s) {
  let sc = (s.match(VOCAB) || []).length;
  if (STRONG.test(s)) sc += 3;
  if (s.length <= 90) sc += 1;
  if (/(저는|제가) .*(했어요|했습니다|했었어요)/.test(s)) sc -= 2;   // 본인 근황 서술은 톤 샘플로 약함
  return sc;
}

const db = getDb(); if (!db) throw new Error('FIREBASE_SERVICE_ACCOUNT 필요');
const snap = await db.collection(COL.chunks).where('origin', '==', 'knowledge').where('docType', '==', 'youtube').select('docName', 'text', 'idx').get();
const byDoc = {};
for (const d of snap.docs) { const x = d.data(); (byDoc[x.docName] = byDoc[x.docName] || []).push(x); }
const docNames = Object.keys(byDoc).sort();
console.log('유튜브 자막 문서', docNames.length, '· 청크', snap.size);

const picked = [];
const seen = new Set();
for (const name of docNames) {
  const chunks = byDoc[name].sort((a, b) => (a.idx || 0) - (b.idx || 0));
  // 문서 안의 모든 후보를 점수순으로 보고 상위 PER_DOC 개만 — 청크 첫 문장(중간에서 잘린 것)은 뺀다
  const cands = [];
  for (const c of chunks) {
    const ss = sentences(c.text);
    ss.slice((c.idx || 0) > 0 ? 1 : 0).forEach((s) => { if (good(s)) cands.push(s); });
  }
  cands.sort((a, b) => score(b) - score(a) || a.length - b.length);
  let n = 0;
  for (const s of cands) {
    if (n >= PER_DOC) break;
    const key = s.slice(0, 25);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push({ s, doc: name.replace(/^\d+_/, '').slice(0, 40), sc: score(s) });
    n++;
  }
}
picked.sort((a, b) => b.sc - a.sc);
picked.splice(MAX);
console.log(`후보 ${picked.length}문장 (영상당 최대 ${PER_DOC})`);
picked.forEach((p, i) => console.log(`${String(i + 1).padStart(2)}. [${p.sc}] ${p.s}   ← ${p.doc}`));

if (dry) process.exit(0);
await db.collection(COL.guidelines).doc('voice').set({
  section: 'voice', name: '커밍쏜 실제 발화 샘플', order: 35, active: true,
  body: picked.map((p) => p.s),
  memo: '유튜브 자막에서 자동 추출(다듬지 않음). 말투·리듬 근거로만 쓰인다. 설정에서 고치거나 지울 수 있음.',
  updatedAt: Date.now(), updatedBy: 'script:build-voice-samples',
}, { merge: true });
console.log(`✅ guidelines/voice 저장 (${picked.length}문장)`);
