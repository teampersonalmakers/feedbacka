// ─────────────────────────────────────────────────────────────────────────────
// scripts/patch-chunk-timing.mjs — 이미 올라간 사례·Q&A 청크에 상담 시기(consultedAt·when) 붙이기
// 임베딩은 다시 하지 않는다(벡터는 그대로). 새로 올라가는 청크는 upsert 가 알아서 붙인다.
// 사용: FIREBASE_SERVICE_ACCOUNT=… node scripts/patch-chunk-timing.mjs [--dry-run]
// ─────────────────────────────────────────────────────────────────────────────
import { getDb, COL } from '../api/_firestore.js';
import { timing } from '../api/_vectors.js';
const dry = process.argv.includes('--dry-run');
const db = getDb(); if (!db) throw new Error('FIREBASE_SERVICE_ACCOUNT 필요');
let n = 0, skipped = 0;
for (const [origin, col, idField] of [['case', COL.cases, 'caseId'], ['playbook', COL.playbook, 'playbookId']]) {
  const snap = await db.collection(COL.chunks).where('origin', '==', origin).get();
  const b = db.batch();
  for (const d of snap.docs) {
    const src = await db.collection(col).doc(d.data()[idField]).get();
    if (!src.exists) { skipped++; continue; }
    const tm = timing(src.data());
    if (!dry) b.set(d.ref, { consultedAt: tm.consultedAt, when: tm.when }, { merge: true });
    n++;
    if (n <= 5) console.log(origin, d.id, '→', tm.when || '(시기 없음)', tm.consultedAt);
  }
  if (!dry) await b.commit();
}
console.log(`${dry ? '(dry) ' : ''}청크 ${n}건 시기 부여, 원본 없음 ${skipped}건`);
