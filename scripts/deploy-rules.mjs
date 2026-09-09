#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 보안 규칙 배포 (Firebase Rules REST API)
//
// firebase-tools 는 배포 전에 serviceusage.googleapis.com 으로 API 활성화 여부를
// 확인하는데, 콘솔에서 받는 firebase-adminsdk 서비스 계정에는 그 권한이 없어
// 403 으로 막힌다. Rules API 를 직접 호출하면 그 사전 점검을 건너뛴다.
//
//   export FIREBASE_SERVICE_ACCOUNT="$(cat serviceAccountKey.json)"
//   node scripts/deploy-rules.mjs                 # firestore 규칙 배포
//   node scripts/deploy-rules.mjs --storage       # storage 규칙도 함께
//   node scripts/deploy-rules.mjs --check         # 배포하지 않고 현재 상태만 확인
//
// (firebase login 을 한 사람은 그냥 `firebase deploy --only firestore:rules` 를
//  써도 된다. 이 스크립트는 서비스 계정만 있을 때를 위한 경로다.)
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import { GoogleAuth } from 'google-auth-library';

const args = process.argv.slice(2);
const WITH_STORAGE = args.includes('--storage');
const CHECK_ONLY = args.includes('--check');

// 서비스 계정: 원문 JSON / base64 / GOOGLE_APPLICATION_CREDENTIALS 경로 모두 지원
function credentials() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (raw) {
    let txt = raw;
    if (!txt.startsWith('{')) txt = Buffer.from(raw, 'base64').toString('utf-8');
    const sa = JSON.parse(txt);
    if (sa.private_key?.includes('\\n')) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    return { credentials: sa, projectId: sa.project_id };
  }
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!path) throw new Error('FIREBASE_SERVICE_ACCOUNT 또는 GOOGLE_APPLICATION_CREDENTIALS 가 필요합니다');
  const sa = JSON.parse(readFileSync(path, 'utf-8'));
  return { keyFile: path, projectId: sa.project_id };
}

const { projectId, ...authOpts } = credentials();
const auth = new GoogleAuth({
  ...authOpts,
  scopes: ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/firebase'],
});
const { token } = await (await auth.getClient()).getAccessToken();

async function api(method, path, body) {
  const r = await fetch('https://firebaserules.googleapis.com/v1' + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}\n${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : {};
}

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// releaseName: cloud.firestore | firebase.storage/<bucket>
async function deploy(label, file, releaseId) {
  const source = readFileSync(file, 'utf-8');
  const releaseName = `projects/${projectId}/releases/${releaseId}`;

  let current = null;
  try { current = await api('GET', '/' + releaseName); } catch (e) { /* 아직 릴리스 없음 */ }

  if (current) {
    const rs = await api('GET', '/' + current.rulesetName);
    const deployed = rs.source.files[0].content;
    if (deployed === source) {
      console.log(`  ${label}: 이미 최신 (${sha(source)}) — 건너뜀`);
      return;
    }
  }
  if (CHECK_ONLY) {
    console.log(`  ${label}: 변경 있음 (로컬 ${sha(source)}) — --check 이므로 배포하지 않음`);
    return;
  }

  const rs = await api('POST', `/projects/${projectId}/rulesets`, {
    source: { files: [{ name: file, content: source }] },
  });
  if (current) {
    await api('PATCH', '/' + releaseName, { release: { name: releaseName, rulesetName: rs.name } });
  } else {
    await api('POST', `/projects/${projectId}/releases`, { name: releaseName, rulesetName: rs.name });
  }

  // 되읽어서 실제로 반영됐는지 확인한다.
  const after = await api('GET', '/' + releaseName);
  const verify = await api('GET', '/' + after.rulesetName);
  const ok = verify.source.files[0].content === source;
  console.log(`  ${label}: ${ok ? '✅ 배포 확인' : '❌ 내용 불일치'} (${sha(source)}) ${after.rulesetName.split('/').pop()}`);
  if (!ok) process.exitCode = 1;
}

console.log(`프로젝트: ${projectId}${CHECK_ONLY ? '  [확인 전용]' : ''}\n`);
await deploy('firestore.rules', 'firestore.rules', 'cloud.firestore');

if (WITH_STORAGE) {
  // Storage 를 활성화하지 않았으면 이 릴리스는 존재하지 않는다.
  try {
    await deploy('storage.rules  ', 'storage.rules', `firebase.storage/${projectId}.firebasestorage.app`);
  } catch (e) {
    console.log('  storage.rules  : 배포 실패 — Storage 가 활성화되지 않았을 수 있습니다');
    console.log('                   ' + String(e.message).split('\n')[0]);
  }
} else {
  console.log('  storage.rules  : 건너뜀 (--storage 를 붙이면 함께 배포)');
}
