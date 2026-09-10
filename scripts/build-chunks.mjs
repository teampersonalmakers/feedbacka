#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// knowledge/base*.json 의 청크 2,344개를 Firestore `chunks` 컬렉션으로 올린다.
//
//   export FIREBASE_SERVICE_ACCOUNT="$(cat serviceAccountKey.json)"
//   node scripts/build-chunks.mjs            # 업로드 (같은 ID 로 덮어쓰므로 여러 번 실행해도 안전)
//   node scripts/build-chunks.mjs --dry      # 세지만 쓰지 않음
//   node scripts/build-chunks.mjs --check    # 3072 vs 1536 검색 일치율만 측정
//
// 임베딩은 새로 만들지 않는다. 파일에 든 3072차원 벡터를 앞 1536차원으로 잘라
// 정규화한다(api/_vectors.js 의 toVector 와 같은 함수). Gemini 호출 0회.
//
// 벡터 인덱스는 별도로 한 번 만들어야 한다(콘솔 UI 로는 못 만든다):
//   gcloud firestore indexes composite create --project=personalmakers-ai \
//     --collection-group=chunks --query-scope=COLLECTION \
//     --field-config=vector-config='{"dimension":"1536","flat":"{}"}',field-path=embedding
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { getDb, COL } from '../api/_firestore.js';
import { toVector, VECTOR_DIM } from '../api/_vectors.js';
import { FieldValue } from 'firebase-admin/firestore';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const CHECK = args.includes('--check');

function loadDocs() {
  const docs = [];
  for (const f of readdirSync('knowledge').sort()) {
    if (!/^base\d*\.json$/.test(f)) continue;
    const j = JSON.parse(readFileSync('knowledge/' + f, 'utf-8'));
    for (const d of j.documents || []) docs.push(Object.assign({ file: f }, d));
  }
  return docs;
}

const docs = loadDocs();
const rows = [];
for (const d of docs) {
  // 파일 안의 문서 162개는 id 가 없고 이름도 겹치는 게 있어, 내용 기반으로 고정 ID 를 만든다.
  const key = createHash('sha1').update(`${d.file}|${d.name}|${(d.chunks?.[0]?.text || '').slice(0, 200)}`).digest('hex').slice(0, 16);
  (d.chunks || []).forEach((c, idx) => {
    if (!c.embedding || !c.text) return;
    rows.push({
      id: `k_${key}_${idx}`,
      docId: String(d.id || key), docName: d.name || '', docType: d.type || '', idx,
      text: c.text, chars: c.text.length, embedding: c.embedding,
    });
  });
}
console.log(`문서 ${docs.length}개 · 청크 ${rows.length}개 · 원 차원 ${rows[0]?.embedding.length} → ${VECTOR_DIM}`);
const dup = rows.length - new Set(rows.map((r) => r.id)).size;
if (dup) { console.error(`ID 중복 ${dup}건 — 중단`); process.exit(1); }

if (CHECK) {
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return v.map((x) => x / s); };
  const full = rows.map((r) => norm(r.embedding)), cut = rows.map((r) => toVector(r.embedding));
  const top = (vecs, qi) => vecs.map((v, i) => [i === qi ? -2 : dot(v, vecs[qi]), i]).sort((a, b) => b[0] - a[0]).slice(0, 6).map((x) => x[1]);
  let agree = 0, q = 0;
  for (let qi = 0; qi < rows.length; qi += Math.floor(rows.length / 150)) {
    const a = new Set(top(full, qi)); agree += top(cut, qi).filter((i) => a.has(i)).length; q++;
  }
  console.log(`상위 6건 일치율: ${(agree / (q * 6) * 100).toFixed(1)}% (질의 ${q}건)`);
  process.exit(0);
}

if (DRY) process.exit(0);

const db = getDb();
if (!db) { console.error('FIREBASE_SERVICE_ACCOUNT 가 필요합니다'); process.exit(1); }

let done = 0;
const t0 = Date.now();
for (let i = 0; i < rows.length; i += 100) {
  const b = db.batch();
  for (const r of rows.slice(i, i + 100)) {
    b.set(db.collection(COL.chunks).doc(r.id), {
      origin: 'knowledge', docId: r.docId, docName: r.docName, docType: r.docType, idx: r.idx,
      text: r.text, chars: r.chars, embedding: FieldValue.vector(toVector(r.embedding)), createdAt: Date.now(),
    });
  }
  await b.commit();
  done += Math.min(100, rows.length - i);
  process.stdout.write(`\r  ${done}/${rows.length}`);
}
console.log(`\n완료 · ${((Date.now() - t0) / 1000).toFixed(1)}초`);
const agg = await db.collection(COL.chunks).count().get();
console.log(`Firestore chunks 문서 수: ${agg.data().count}`);
