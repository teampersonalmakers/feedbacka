#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 노션에서 옮겨온 kbSources 120건은 knowledge/base*.json 에 이미 임베딩돼 있다
// (본문 대조로 119/120 일치 확인). 같은 자막을 또 임베딩하면 검색 상위권을
// 중복 청크가 차지하므로, 각 소스에 "이미 knowledge 청크로 반영됨" 표시를 남긴다.
//   embeddedVia: 'knowledge', knowledgeDocName: <짝이 되는 knowledge 문서명>
// insight.html 은 이 표시로 ✓ 를 보여주고, kb-embed 는 재반영 시 옛 knowledge
// 청크를 지우고 새 청크로 교체한다.
//
//   export FIREBASE_SERVICE_ACCOUNT="$(cat serviceAccountKey.json)"
//   node scripts/link-kb-to-chunks.mjs [--dry]
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync } from 'fs';
import { getDb, COL } from '../api/_firestore.js';

const DRY = process.argv.includes('--dry');
const db = getDb();
if (!db) { console.error('FIREBASE_SERVICE_ACCOUNT 가 필요합니다'); process.exit(1); }

const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/[^가-힣a-z0-9]/gi, '').toLowerCase();
const kdocs = [];
for (const f of readdirSync('knowledge').sort()) if (/^base\d*\.json$/.test(f))
  for (const d of JSON.parse(readFileSync('knowledge/' + f, 'utf-8')).documents || []) kdocs.push({ name: d.name, text: norm(d.chunks.map((c) => c.text).join('')) });

const snap = await db.collection(COL.kbSources).get();
let linked = 0, already = 0, unmatched = [];
for (const doc of snap.docs) {
  const r = doc.data();
  if (r.embeddedVia || r.embeddedAt) { already++; continue; }
  const body = String(r.transcript || '').split('\n').slice(4).join('');
  const w = norm(body.slice(200, 300));
  // 본문 대조가 1순위, 안 되면 문서명 일치로.
  const k = (w.length >= 30 ? kdocs.find((d) => d.text.includes(w)) : null)
         || kdocs.find((d) => norm(d.name) === norm(r.name));
  if (!k) { unmatched.push(r.name); continue; }
  linked++;
  if (!DRY) await doc.ref.set({ embeddedVia: 'knowledge', knowledgeDocName: k.name, embeddedAt: Date.now() }, { merge: true });
}
console.log(`연결 ${linked}건 · 이미 표시됨 ${already}건 · 짝 없음 ${unmatched.length}건${DRY ? ' (dry)' : ''}`);
for (const n of unmatched) console.log('  짝 없음:', n);
