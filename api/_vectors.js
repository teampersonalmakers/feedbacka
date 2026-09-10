// ─────────────────────────────────────────────────────────────────────────────
// api/_vectors.js — Firestore 벡터 검색 (지식베이스 RAG)
//
// 예전에는 knowledge/base*.json(80MB, 2,344청크)을 요청마다 통째로 읽어
// 메모리에서 코사인 유사도를 계산했다. 콜드스타트 6.8초의 대부분이 이 파싱이다.
// 이제 청크는 Firestore `chunks` 컬렉션에 살고, findNearest 로 상위 몇 개만 가져온다.
//
// 차원: Firestore 벡터 인덱스 상한이 2048 이라 gemini-embedding-001 의 3072차원을
// 앞 1536차원으로 자른 뒤 정규화해서 쓴다(Matryoshka 임베딩이라 앞부분만 써도 된다).
// 기존 3072차원 대비 상위 6건 일치율 98% 를 확인했다(scripts/build-chunks.mjs 참고).
// 문서·질의 모두 같은 함수(toVector)로 자르므로 서로 어긋날 일이 없다.
// ─────────────────────────────────────────────────────────────────────────────

import { getDb, COL } from './_firestore.js';
import { FieldValue } from 'firebase-admin/firestore';

export const VECTOR_DIM = 1536;
export const EMBED_MODEL = 'gemini-embedding-001';

// 3072 → 1536 자르고 L2 정규화. 코사인 거리는 정규화된 벡터를 전제로 한다.
export function toVector(values) {
  const v = Array.from(values).slice(0, VECTOR_DIM);
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  return v.map((x) => x / s);
}

async function embed(text, key, taskType) {
  const url = `https://generativelanguage.googleapis.com/v1/models/${EMBED_MODEL}:embedContent?key=${key}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: `models/${EMBED_MODEL}`, content: { parts: [{ text }] }, taskType }),
  });
  const data = await r.json();
  if (data.error) throw new Error('Gemini: ' + data.error.message);
  return toVector(data.embedding.values);
}
export const embedQuery = (text, key) => embed(text, key, 'RETRIEVAL_QUERY');
export const embedDoc = (text, key) => embed(text, key, 'RETRIEVAL_DOCUMENT');

// 자막을 청크로 나눈다. 기존 지식베이스 청크 평균이 1,465자라 비슷하게 맞춘다.
export function splitChunks(text, size = 1500, overlap = 150) {
  const sentences = String(text).split(/(?<=[.!?。？！\n])/).map((s) => s).filter((s) => s.length);
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if (cur.length + s.length > size && cur.trim()) {
      out.push(cur.trim());
      cur = cur.slice(Math.max(0, cur.length - overlap));   // 문맥이 끊기지 않게 꼬리를 겹친다
    }
    cur += s;
  }
  if (cur.trim().length > 40 || (!out.length && cur.trim())) out.push(cur.trim());
  return out;
}

// ─── 검색 ────────────────────────────────────────────────────────────────────
// 반환 형태는 예전 retrieve() 와 같다: { docName, docType, text, score }
// 인덱스가 아직 없으면 FAILED_PRECONDITION 이 난다 — 호출부가 파일 폴백으로 넘어간다.
export async function searchChunks(queryVec, topK = 6) {
  const db = getDb();
  if (!db) throw new Error('Firestore 미설정');
  const snap = await db.collection(COL.chunks)
    .findNearest({
      vectorField: 'embedding',
      queryVector: FieldValue.vector(queryVec),
      limit: topK,
      distanceMeasure: 'COSINE',
      distanceResultField: 'distance',
    })
    .get();
  return snap.docs.map((d) => {
    const r = d.data();
    return { docName: r.docName, docType: r.docType, text: r.text, score: 1 - (r.distance ?? 1), origin: r.origin };
  });
}

export async function countChunks() {
  const db = getDb();
  if (!db) return 0;
  const agg = await db.collection(COL.chunks).count().get();
  return agg.data().count;
}

// ─── 내부 인사이트 소스 ↔ 청크 동기화 ────────────────────────────────────────
// kbSources/{id} 의 자막을 잘라 임베딩하고 chunks 에 쓴다. 같은 kbId 의 옛 청크는 지운다.
export async function deleteKbChunks(kbId) {
  const db = getDb();
  const snap = await db.collection(COL.chunks).where('kbId', '==', kbId).select().get();
  let n = 0;
  for (let i = 0; i < snap.docs.length; i += 400) {
    const b = db.batch();
    for (const d of snap.docs.slice(i, i + 400)) { b.delete(d.ref); n++; }
    await b.commit();
  }
  return n;
}

export async function upsertKbChunks(kbId, key) {
  const db = getDb();
  const ref = db.collection(COL.kbSources).doc(kbId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error('소스를 찾을 수 없습니다');
  const src = doc.data();
  const text = String(src.transcript || '').trim();
  await deleteKbChunks(kbId);
  // 노션에서 옮겨온 소스는 knowledge 청크로 이미 들어가 있다. 같은 자막이 두 벌
  // 검색되지 않도록 옛 청크를 지우고 새 청크로 교체한다.
  if (src.embeddedVia === 'knowledge' && src.knowledgeDocName) {
    const old = await db.collection(COL.chunks)
      .where('origin', '==', 'knowledge').where('docName', '==', src.knowledgeDocName).select().get();
    for (let i = 0; i < old.docs.length; i += 400) {
      const b = db.batch();
      for (const d of old.docs.slice(i, i + 400)) b.delete(d.ref);
      await b.commit();
    }
  }
  if (text.length < 40) {
    await ref.set({ chunks: 0, embeddedAt: Date.now(), embeddedVia: 'kbSources' }, { merge: true });
    return 0;
  }
  const parts = splitChunks(text);
  const vectors = [];
  for (const p of parts) vectors.push(await embedDoc(p, key));

  for (let i = 0; i < parts.length; i += 200) {
    const b = db.batch();
    for (let j = i; j < Math.min(parts.length, i + 200); j++) {
      b.set(db.collection(COL.chunks).doc(`kb_${kbId}_${j}`), {
        kbId, origin: 'kbSources',
        docId: kbId, docName: src.name || '', docType: src.type || 'youtube', category: src.category || '',
        idx: j, text: parts[j], chars: parts[j].length,
        embedding: FieldValue.vector(vectors[j]),
        createdAt: Date.now(),
      });
    }
    await b.commit();
  }
  await ref.set({ chunks: parts.length, embeddedAt: Date.now(), embeddedVia: 'kbSources' }, { merge: true });
  return parts.length;
}
