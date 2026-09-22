// ─────────────────────────────────────────────────────────────────────────────
// api/_backfill.js — 검색 자산 백필 (공통)
//
// 승인됐지만 아직 chunks 로 안 올라간 사례·Q&A·지식 소스를 조금씩 임베딩한다.
// distill.js(설정 화면)와 backfill.js(누구나, 10분에 한 번)에서 같이 쓴다.
// 한 번에 사례 60·Q&A 10·소스 3 — 소스는 청크가 많아 임베딩이 오래 걸린다.
// ─────────────────────────────────────────────────────────────────────────────
import { getDb, COL } from './_firestore.js';
import { upsertCaseChunk, upsertPlaybookChunk, upsertKbChunks } from './_vectors.js';

export const BACKFILL_DOC = '_backfill';           // distill/_backfill — 마지막 실행 시각
export const BACKFILL_MIN_GAP_MS = 10 * 60 * 1000;

export async function backfillEmbeddings(limits = {}) {
  const { cases = 60, playbook = 10, sources = 3 } = limits;
  const db = getDb();
  const out = { cases: 0, playbook: 0, sources: 0, pending: { cases: 0, playbook: 0, sources: 0 } };
  const GK = process.env.GEMINI_API_KEY;
  if (!db || !GK) return out;
  try {
    const cs = await db.collection(COL.cases).where('aiApplied', '==', true).limit(400).get();
    const csTodo = cs.docs.filter((x) => !x.data().embeddedAt);
    for (const d of csTodo.slice(0, cases)) { out.cases += await upsertCaseChunk(d.id, GK); }
    out.pending.cases = Math.max(0, csTodo.length - cases);

    const pb = await db.collection(COL.playbook).where('status', '==', '승인').limit(200).get();
    const pbTodo = pb.docs.filter((x) => !x.data().embeddedAt);
    for (const d of pbTodo.slice(0, playbook)) { out.playbook += await upsertPlaybookChunk(d.id, GK); }
    out.pending.playbook = Math.max(0, pbTodo.length - playbook);

    const ks = await db.collection(COL.kbSources).limit(400).get();
    const ksTodo = ks.docs.filter((x) => !x.data().embeddedAt && String(x.data().transcript || '').length >= 40);
    for (const d of ksTodo.slice(0, sources)) { out.sources += (await upsertKbChunks(d.id, GK)) ? 1 : 0; }
    out.pending.sources = Math.max(0, ksTodo.length - sources);
  } catch (e) { console.warn('[backfill] 실패(무시):', e.message); out.error = String(e.message).slice(0, 200); }
  return out;
}

// 누구나 부를 수 있는 경로용 — 10분에 한 번만 실제로 돈다. 승인된 자산만 올리므로
// 남이 눌러도 해가 없고, 임베딩 호출 수는 회당 최대 73번으로 묶여 있다.
export async function backfillThrottled() {
  const db = getDb();
  if (!db) return { skipped: true, reason: 'no-db' };
  const ref = db.collection(COL.distill).doc(BACKFILL_DOC);
  const snap = await ref.get();
  const last = (snap.exists && snap.data().lastAt) || 0;
  const now = Date.now();
  if (now - last < BACKFILL_MIN_GAP_MS) return { skipped: true, nextInSec: Math.ceil((BACKFILL_MIN_GAP_MS - (now - last)) / 1000) };
  await ref.set({ lastAt: now, running: true }, { merge: true });   // 먼저 잠근다 — 동시 호출 방지
  const r = await backfillEmbeddings();
  await ref.set({ lastAt: now, running: false, last: r, finishedAt: Date.now() }, { merge: true });
  return r;
}
