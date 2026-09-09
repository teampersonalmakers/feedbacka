#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 디렉터 화이트리스트 관리
//
// firestore.rules 는 directors 컬렉션에 대한 클라이언트 쓰기를 전면 차단한다.
// 등록은 이 스크립트(Admin SDK)나 Firebase 콘솔에서만 가능하다.
//
//   node scripts/directors.mjs list
//   node scripts/directors.mjs add heidi@example.com --name 헤이디
//   node scripts/directors.mjs add boss@example.com --name 커밍쏜 --role admin
//   node scripts/directors.mjs disable heidi@example.com   # 접근만 차단 (기록은 보존)
//   node scripts/directors.mjs enable  heidi@example.com
//   node scripts/directors.mjs remove  heidi@example.com   # 완전 삭제
//
// 필요한 환경변수: FIREBASE_SERVICE_ACCOUNT (JSON 원문 또는 base64)
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function initDb() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT 가 설정되지 않았습니다');
  let txt = raw;
  if (!txt.startsWith('{')) txt = Buffer.from(raw, 'base64').toString('utf-8');
  const sa = JSON.parse(txt);
  if (sa.private_key?.includes('\\n')) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  if (!getApps().length) initializeApp({ credential: cert(sa), projectId: sa.project_id });
  return getFirestore();
}

// 문서 ID 는 소문자 이메일. 보안 규칙이 request.auth.token.email 과 그대로 비교한다.
const key = (e) => String(e || '').trim().toLowerCase();
const valid = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

const argv = process.argv.slice(2);
const cmd = argv[0];
const email = argv[1];
const flag = (n, d = '') => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

async function main() {
  const db = initDb();
  const col = db.collection('directors');

  if (cmd === 'list') {
    const snap = await col.get();
    if (snap.empty) {
      console.log('등록된 디렉터가 없습니다.');
      console.log('  node scripts/directors.mjs add <이메일> --name <이름>');
      return;
    }
    console.log(`등록된 디렉터 ${snap.size}명\n`);
    snap.docs
      .map((d) => d.data())
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ko'))
      .forEach((d) => {
        const state = d.active === false ? '  [비활성]' : '';
        console.log(`  ${(d.name || '(이름 없음)').padEnd(10)} ${d.email}  · ${d.role || 'director'}${state}`);
      });
    return;
  }

  if (!email) throw new Error('이메일을 입력해주세요');
  if (!valid(email)) throw new Error('이메일 형식이 올바르지 않습니다: ' + email);
  const id = key(email);
  const ref = col.doc(id);

  if (cmd === 'add') {
    const name = flag('name');
    if (!name) throw new Error('--name 으로 이름을 지정해주세요');
    await ref.set({
      email: id,
      name,
      role: flag('role', 'director'),
      active: true,
      updatedAt: Date.now(),
    }, { merge: true });
    console.log(`✅ 등록: ${name} <${id}>`);
    console.log('   이 구글 계정으로 바로 로그인할 수 있습니다.');
    return;
  }

  if (cmd === 'disable' || cmd === 'enable') {
    const snap = await ref.get();
    if (!snap.exists) throw new Error('등록되지 않은 이메일입니다: ' + id);
    await ref.set({ active: cmd === 'enable', updatedAt: Date.now() }, { merge: true });
    console.log(`✅ ${id} → ${cmd === 'enable' ? '활성' : '비활성'}`);
    return;
  }

  if (cmd === 'remove') {
    const snap = await ref.get();
    if (!snap.exists) throw new Error('등록되지 않은 이메일입니다: ' + id);
    await ref.delete();
    console.log(`✅ 삭제: ${id}`);
    console.log('   대화·피드백 기록은 users/{uid} 아래에 그대로 남아 있습니다.');
    return;
  }

  console.log(`사용법:
  node scripts/directors.mjs list
  node scripts/directors.mjs add <이메일> --name <이름> [--role admin]
  node scripts/directors.mjs disable <이메일>
  node scripts/directors.mjs enable  <이메일>
  node scripts/directors.mjs remove  <이메일>`);
  process.exitCode = 1;
}

main().catch((e) => {
  console.error('오류:', e.message);
  process.exit(1);
});
