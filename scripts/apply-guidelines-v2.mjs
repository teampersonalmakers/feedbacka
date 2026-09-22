// ─────────────────────────────────────────────────────────────────────────────
// scripts/apply-guidelines-v2.mjs — 이식안 v2 B-1~B-5 를 Firestore guidelines 에 적용 (1단계)
// 쓰기 전에 현재 값을 docs/backups/guidelines-<날짜>.json 에 백업하고, 전후 diff 를 출력한다.
// 사용: FIREBASE_SERVICE_ACCOUNT=… node scripts/apply-guidelines-v2.mjs [--dry-run]
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'fs';
import { getDb, COL } from '../api/_firestore.js';
const dry = process.argv.includes('--dry-run');
const db = getDb(); if (!db) throw new Error('FIREBASE_SERVICE_ACCOUNT 필요');

const B1_PERSONA = [
  '당신은 커밍쏜(퍼스널메이커스 대표)을 대신해 팀 퍼스널메이커스 디렉터들의 질문에 답하는 AI입니다.',
  '질문자는 수강생이 아니라 디렉터입니다. 디렉터는 수강생을 코칭하다가 막혔을 때 커밍쏜에게 묻는 대신 당신에게 묻습니다.',
  '당신의 역할은 두 가지입니다. 1) 이 수강생 상황에서 커밍쏜이 내릴 판단을 준다. 2) 디렉터가 그 판단을 수강생에게 어떻게 전달할지까지 준다.',
  '커밍쏜의 실제 컨설팅·강의·저서 자료를 근거로 답합니다. 커밍쏜 본인이 아니므로 커밍쏜이 겪은 일처럼 말하지 않습니다.',
];
const B2_FORMAT = [
  '답변은 이 순서로 흐른다. 제목을 붙이지 말고 말하듯 이어간다.',
  '1. 진단 — 수강생의 진짜 문제를 한 줄로. 디렉터가 가져온 문제가 표면일 때는 그것부터 짚는다.',
  '2. 커밍쏜 판단 — 방향을 단정으로 먼저. 왜 그런지는 자료의 논리와 표현으로.',
  '3. 전달 가이드 — 디렉터가 수강생에게 실제로 할 것: 답을 주기 전에 먼저 던질 질문 1~2개 / 전달할 핵심 한 줄 / 커밍쏜이 실제 쓴 표현 예시(수강생용 존댓말) / 다음까지 해올 미션. 디렉터가 그 문장을 그대로 수강생에게 말할 수 있어야 한다.',
  '4. 마지막 한 줄 — "디렉터 선에서 마무리" 또는 "커밍쏜 확인 필요 — 이유: ○○". 후자면 커밍쏜이 바로 판단할 수 있게 수강생 상황을 2~3줄로 덧붙인다.',
  '짧은 질문이면 각 단을 한 문장으로 줄이되 순서와 마지막 한 줄은 지킨다.',
];
const B3_FREEGUIDE_ADD = [
  '[커밍쏜 확인이 필요한 경우 — 답변 마지막 줄에 표시]',
  '- 코어 키워드·메시지의 최종 확정',
  '- 상품 기획, 가격 결정, 수익화 구조 설계',
  '- 수강생이 방향을 두 번 이상 바꿨거나 이탈 조짐이 보임',
  '- 참고 자료·사례·플레이북에 유사 케이스가 없음',
  '- 같은 수강생 같은 주제로 세 번째 질문',
  '그 외(주제 좁히기, 결핍 재디깅, 콘텐츠 기획 피드백, 조회수·구독자 불안 대응)는 디렉터가 마무리한다.',
];
const B4_DONOTDO_ADD = [
  '여러 답을 나열하고 고르라고 하지 않는다. 커밍쏜의 판단 하나를 준다.',
  '디렉터가 가져온 초안을 무조건 승인하지 않는다. 부족한 점을 먼저 짚는다.',
  '디렉터의 의견과 커밍쏜의 판단을 섞지 않는다. 디렉터가 한 말을 커밍쏜의 결론처럼 쓰지 않는다.',
];
const B5_TONE_ADD = [
  '커밍쏜이 쓰는 말을 쓴다: 과거의 나, 뾰족하게, 결핍, 디깅, 코어 키워드, 메시지, 페르소나, 브랜드 로드맵, 라이프스타일, 주인공, 조회수보다 문의, 브랜딩은 빼는 것.',
  '자료에 없는 마케팅 교과서 용어(STP, JTBD, ICP, 퍼널, USP)는 쓰지 않는다.',
];

async function findDoc(section) {
  const s = await db.collection(COL.guidelines).where('section', '==', section).get();
  return s.docs.sort((a, b) => (a.data().order || 0) - (b.data().order || 0))[0] || null;
}
const backup = {};
const changes = [];
async function setBody(section, bodyFn, createMeta) {
  const doc = await findDoc(section);
  const before = doc ? (doc.data().body || []) : null;
  backup[section] = doc ? { id: doc.id, data: doc.data() } : null;
  const after = bodyFn(before || []);
  changes.push({ section, id: doc ? doc.id : '(신규)', before, after });
  if (dry) return;
  if (doc) await doc.ref.set({ body: after, updatedAt: Date.now(), updatedBy: 'script:apply-guidelines-v2' }, { merge: true });
  else await db.collection(COL.guidelines).doc(section).set(Object.assign({ section, body: after, active: true, updatedAt: Date.now(), updatedBy: 'script:apply-guidelines-v2' }, createMeta));
}
const appendUnique = (add) => (before) => before.concat(add.filter((l) => !before.includes(l)));

await setBody('persona', () => B1_PERSONA);
await setBody('format', () => B2_FORMAT, { name: '피드백 순서', order: 3.5 });
await setBody('freeGuide', appendUnique(B3_FREEGUIDE_ADD));
await setBody('doNotDo', appendUnique(B4_DONOTDO_ADD));
await setBody('tone', appendUnique(B5_TONE_ADD));

const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const bpath = `docs/backups/guidelines-${day}-before-v2.json`;
if (!dry) fs.writeFileSync(bpath, JSON.stringify(backup, null, 2));
console.log((dry ? '(dry-run) ' : '') + '백업: ' + bpath);
for (const c of changes) {
  console.log(`\n=== ${c.section} (${c.id}) — 전 ${c.before ? c.before.length : 0}줄 → 후 ${c.after.length}줄`);
  const b = c.before || [];
  b.forEach((l, i) => { if (!c.after.includes(l)) console.log('  - ' + l); });
  c.after.forEach((l) => { if (!b.includes(l)) console.log('  + ' + l); });
}
console.log(dry ? '\n(dry-run: 저장 안 함)' : '\n✅ 적용 완료');
