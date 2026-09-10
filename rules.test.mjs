// firestore.rules 검증 — 에뮬레이터에 실제로 규칙을 로드해서 동작을 확인한다.
import { readFileSync } from 'fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, deleteDoc, collection, getDocs,
} from 'firebase/firestore';

const OWNER = 'comingssoni@gmail.com';
let env, pass = 0, fail = 0;

const tok = (email, uid) => ({ email, email_verified: true, sub: uid || email });

async function t(name, fn) {
  try { await fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) { console.log('  ❌ ' + name + '\n       ' + String(e.message).split('\n')[0]); fail++; }
}

env = await initializeTestEnvironment({
  projectId: 'personalmakers-ai',
  firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
});
await env.clearFirestore();

// 시드: 화이트리스트에 헤이디(일반), 다빈(비활성)
await env.withSecurityRulesDisabled(async (ctx) => {
  const d = ctx.firestore();
  await setDoc(doc(d, 'directors', 'heidi@example.com'), { email: 'heidi@example.com', name: '헤이디', role: 'director', active: true });
  await setDoc(doc(d, 'directors', 'davin@example.com'), { email: 'davin@example.com', name: '디어다빈', role: 'director', active: false });
  await setDoc(doc(d, 'guidelines', 'g1'), { section: 'persona', active: true, body: ['x'] });
});

const owner   = env.authenticatedContext('uidOwner',  tok(OWNER, 'uidOwner')).firestore();
const heidi   = env.authenticatedContext('uidHeidi',  tok('heidi@example.com', 'uidHeidi')).firestore();
const davin   = env.authenticatedContext('uidDavin',  tok('davin@example.com', 'uidDavin')).firestore();
const stranger= env.authenticatedContext('uidX',      tok('random@gmail.com', 'uidX')).firestore();
const anon    = env.unauthenticatedContext().firestore();

console.log('\n── 소유자 부트스트랩 (화이트리스트에 문서 없음) ──');
await t('소유자는 화이트리스트 문서 없이도 프로필 생성 가능',
  () => assertSucceeds(setDoc(doc(owner, 'users', 'uidOwner'), { email: OWNER, nickname: '커밍쏜' })));
await t('소유자는 자기 프로필 읽기 가능',
  () => assertSucceeds(getDoc(doc(owner, 'users', 'uidOwner'))));
await t('소유자는 대화 저장 가능',
  () => assertSucceeds(setDoc(doc(owner, 'users/uidOwner/convs', 'c1'), { title: 't', student: '', ts: 1 })));

console.log('\n── 화이트리스트 디렉터 ──');
await t('등록된 디렉터는 프로필 생성 가능',
  () => assertSucceeds(setDoc(doc(heidi, 'users', 'uidHeidi'), { email: 'heidi@example.com', nickname: '헤이디' })));
await t('active:false 디렉터는 차단',
  () => assertFails(setDoc(doc(davin, 'users', 'uidDavin'), { email: 'davin@example.com', nickname: '다빈' })));
await t('화이트리스트에 없는 계정은 차단',
  () => assertFails(setDoc(doc(stranger, 'users', 'uidX'), { email: 'random@gmail.com', nickname: 'x' })));
await t('비로그인 차단',
  () => assertFails(getDoc(doc(anon, 'users', 'uidOwner'))));

console.log('\n── 남의 데이터 접근 ──');
await t('디렉터가 남의 프로필 읽기 차단',
  () => assertFails(getDoc(doc(heidi, 'users', 'uidOwner'))));
await t('디렉터가 남의 대화 쓰기 차단',
  () => assertFails(setDoc(doc(heidi, 'users/uidOwner/convs', 'c9'), { title: 'x', student: '', ts: 1 })));

console.log('\n── 화이트리스트 관리 ──');
await t('소유자(admin)는 디렉터 목록 조회 가능',
  () => assertSucceeds(getDocs(collection(owner, 'directors'))));
await t('소유자(admin)는 디렉터 추가 가능',
  () => assertSucceeds(setDoc(doc(owner, 'directors', 'new@example.com'), { email: 'new@example.com', name: '신규', role: 'director', active: true })));
await t('소유자(admin)는 디렉터 삭제 가능',
  () => assertSucceeds(deleteDoc(doc(owner, 'directors', 'new@example.com'))));
await t('일반 디렉터는 목록 조회 차단',
  () => assertFails(getDocs(collection(heidi, 'directors'))));
await t('일반 디렉터는 디렉터 추가 차단 (임의 가입 방지)',
  () => assertFails(setDoc(doc(heidi, 'directors', 'evil@example.com'), { email: 'evil@example.com', name: 'evil', role: 'director', active: true })));
await t('본인 항목 자가 승격 차단',
  () => assertFails(setDoc(doc(stranger, 'directors', 'random@gmail.com'), { email: 'random@gmail.com', name: 'x', role: 'admin', active: true })));
await t('디렉터는 자기 화이트리스트 항목 읽기 가능',
  () => assertSucceeds(getDoc(doc(heidi, 'directors', 'heidi@example.com'))));
await t('디렉터가 남의 화이트리스트 항목 읽기 차단',
  () => assertFails(getDoc(doc(heidi, 'directors', 'davin@example.com'))));

console.log('\n── 플레이북: 작성 ──');
const PB = (over = {}) => Object.assign({
  question: '조회수가 안 나와요', originalQuestion: '조회수가 잘 안 나오는데 뭐가 문제일까요',
  answer: '먼저 주제가 뾰족한지 봅니다.', status: '답변작성',
  category: '채널운영(콘텐츠관점)', director: '헤이디', student: '', type: '수동등록',
}, over);

await t('디렉터는 초안(답변작성) 생성 가능',
  () => assertSucceeds(setDoc(doc(heidi, 'playbook', 'p1'), PB())));
await t('디렉터는 자기 초안 수정 가능',
  () => assertSucceeds(setDoc(doc(heidi, 'playbook', 'p1'), PB({ answer: '수정된 답변' }))));
await t('디렉터는 남이 만든 초안도 수정 가능 (팀 자산)',
  () => assertSucceeds(setDoc(doc(owner, 'playbook', 'p1'), PB({ answer: '커밍쏜이 다듬음' }))));
await t('디렉터는 플레이북 읽기 가능',
  () => assertSucceeds(getDocs(collection(heidi, 'playbook'))));
await t('화이트리스트 밖 계정은 플레이북 읽기 차단',
  () => assertFails(getDocs(collection(stranger, 'playbook'))));

console.log('\n── 플레이북: 승인 권한 (핵심) ──');
await t('디렉터가 바로 승인 상태로 생성 → 차단',
  () => assertFails(setDoc(doc(heidi, 'playbook', 'p2'), PB({ status: '승인' }))));
await t('디렉터가 초안을 승인으로 전환 → 차단',
  () => assertFails(setDoc(doc(heidi, 'playbook', 'p1'), PB({ status: '승인' }))));
await t('커밍쏜(admin)은 승인 전환 가능',
  () => assertSucceeds(setDoc(doc(owner, 'playbook', 'p1'), PB({ status: '승인' }))));
await t('승인된 문서를 디렉터가 수정 → 차단 (AI 프롬프트 보호)',
  () => assertFails(setDoc(doc(heidi, 'playbook', 'p1'), PB({ status: '승인', answer: '몰래 바꾼 답변' }))));
await t('승인된 문서를 디렉터가 초안으로 되돌리기 → 차단',
  () => assertFails(setDoc(doc(heidi, 'playbook', 'p1'), PB({ status: '답변작성' }))));
await t('커밍쏜(admin)은 승인된 문서 수정 가능',
  () => assertSucceeds(setDoc(doc(owner, 'playbook', 'p1'), PB({ status: '승인', answer: '재조정' }))));
await t('디렉터는 삭제 차단',
  () => assertFails(deleteDoc(doc(heidi, 'playbook', 'p1'))));
await t('커밍쏜(admin)은 삭제 가능',
  () => assertSucceeds(deleteDoc(doc(owner, 'playbook', 'p1'))));

console.log('\n── 플레이북: 입력 검증 ──');
await t('질문 빈 값 차단',
  () => assertFails(setDoc(doc(heidi, 'playbook', 'p3'), PB({ question: '' }))));
await t('알 수 없는 상태값 차단',
  () => assertFails(setDoc(doc(heidi, 'playbook', 'p3'), PB({ status: '아무거나' }))));
await t('답변 20만자 초과 차단',
  () => assertFails(setDoc(doc(heidi, 'playbook', 'p3'), PB({ answer: 'x'.repeat(200001) }))));

console.log('\n── 내부 인사이트 (kbSources) — 커밍쏜 전용 ──');
const KB = { name: '테스트 소스', type: 'youtube', category: 'general',
             status: '완료', transcript: '자막 본문', chunks: 3 };
await t('커밍쏜은 kbSources 읽기 가능',
  () => assertSucceeds(getDocs(collection(owner, 'kbSources'))));
await t('커밍쏜은 kbSources 쓰기 가능',
  () => assertSucceeds(setDoc(doc(owner, 'kbSources', 'k1'), KB)));
await t('커밍쏜은 kbSources 삭제 가능',
  () => assertSucceeds(deleteDoc(doc(owner, 'kbSources', 'k1'))));
await t('일반 디렉터는 kbSources 읽기 차단',
  () => assertFails(getDocs(collection(heidi, 'kbSources'))));
await t('일반 디렉터는 kbSources 쓰기 차단',
  () => assertFails(setDoc(doc(heidi, 'kbSources', 'k2'), KB)));
await t('화이트리스트 밖 계정도 당연히 차단',
  () => assertFails(getDocs(collection(stranger, 'kbSources'))));

console.log('\n── 팀 지식 컬렉션 (서버 전용) ──');
await t('커밍쏜은 guidelines 읽기 가능 (설정 페이지)',
  () => assertSucceeds(getDoc(doc(owner, 'guidelines', 'g1'))));
await t('커밍쏜은 guidelines 쓰기 가능',
  () => assertSucceeds(setDoc(doc(owner, 'guidelines', 'tone'), { section: 'tone', body: ['짧게'], active: true, order: 3 })));
await t('guidelines 알 수 없는 section 차단',
  () => assertFails(setDoc(doc(owner, 'guidelines', 'x'), { section: 'hack', body: ['x'], active: true })));
await t('guidelines body 가 문자열이면 차단 (배열이어야)',
  () => assertFails(setDoc(doc(owner, 'guidelines', 'x'), { section: 'tone', body: 'x', active: true })));
await t('admin 디렉터도 guidelines 읽기 차단',
  () => assertFails(getDoc(doc(heidi, 'guidelines', 'g1'))));
await t('커밍쏜은 cases 읽기·쓰기 가능',
  () => assertSucceeds(setDoc(doc(owner, 'cases', 'c1'), { summary: '요약', body: '본문', aiApplied: true })));
await t('cases summary 빈 값 차단',
  () => assertFails(setDoc(doc(owner, 'cases', 'c2'), { summary: '', body: '본문', aiApplied: true })));
await t('디렉터는 cases 읽기 차단',
  () => assertFails(getDoc(doc(heidi, 'cases', 'c1'))));
await t('chunks(벡터 청크)는 소유자도 브라우저에서 읽기 차단',
  () => assertFails(getDoc(doc(owner, 'chunks', 'k1'))));
await t('chunks 쓰기 차단',
  () => assertFails(setDoc(doc(owner, 'chunks', 'k1'), { text: 'x' })));
await t('evals(자동 평가) 읽기 차단',
  () => assertFails(getDoc(doc(owner, 'evals', 'e1'))));

console.log('\n── 입력 검증 ──');
await t('닉네임 20자 초과 차단',
  () => assertFails(setDoc(doc(owner, 'users', 'uidOwner'), { nickname: 'x'.repeat(21) })));
await t('디렉터 이름 빈 값 차단',
  () => assertFails(setDoc(doc(owner, 'directors', 'a@b.com'), { email: 'a@b.com', name: '', role: 'director', active: true })));
await t('문서ID와 email 불일치 차단',
  () => assertFails(setDoc(doc(owner, 'directors', 'a@b.com'), { email: 'other@b.com', name: 'x', role: 'director', active: true })));
await t('알 수 없는 role 차단',
  () => assertFails(setDoc(doc(owner, 'directors', 'a@b.com'), { email: 'a@b.com', name: 'x', role: 'superuser', active: true })));

await env.cleanup();
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
