// ─────────────────────────────────────────────────────────────────────────────
// firebase.js — Personalmakers AI · Firestore + Storage 연동 레이어
//
// 이 파일은 <script type="module"> 로 로드되고, 기존 페이지의 일반 스크립트가
// 쓸 수 있도록 window.PMFire 에 API 를 노출합니다.
//
// 설계 원칙
//  1) 절대 앱을 죽이지 않는다. Firebase 가 없거나 실패해도 페이지는 기존
//     localStorage 동작으로 그대로 굴러간다. (PMFire 가 null 이 될 뿐)
//  2) localStorage 는 "즉시 렌더용 캐시", Firestore 는 "진짜 저장소".
//  3) 익명 로그인으로 uid 를 확보해 보안 규칙(users/{uid}/…)을 걸 수 있게 한다.
//     화면상 로그인 UI 는 없다 — 기존 비밀번호 게이트가 그대로 유지된다.
// ─────────────────────────────────────────────────────────────────────────────

const SDK = '12.18.0';
const CDN = `https://www.gstatic.com/firebasejs/${SDK}`;

// 웹 앱 config — 공개되어도 되는 값입니다(브라우저에 그대로 내려가는 식별자).
// 실제 보호는 firestore.rules / storage.rules 가 담당합니다.
export const firebaseConfig = {
  apiKey: 'AIzaSyDLKwj866Rbc1SHbLZfl0oVyL-0FM1kwXk',
  authDomain: 'personalmakers-ai.firebaseapp.com',
  projectId: 'personalmakers-ai',
  storageBucket: 'personalmakers-ai.firebasestorage.app',
  messagingSenderId: '314929185239',
  appId: '1:314929185239:web:b95c2352e8266beca4cb92',
  measurementId: 'G-ZW2CQJQDNM',
};

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function fail(stage, e) {
  console.warn('[PMFire] ' + stage + ' 실패 — 로컬 저장으로 계속합니다:', e && e.message ? e.message : e);
  window.PMFire = null;
  window.dispatchEvent(new CustomEvent('pmfire:error', { detail: { stage, error: String(e) } }));
}

(async function boot() {
  let app, db, storage, auth, uid, S, F;
  try {
    const [appMod, authMod, fsMod, stMod] = await Promise.all([
      import(`${CDN}/firebase-app.js`),
      import(`${CDN}/firebase-auth.js`),
      import(`${CDN}/firebase-firestore.js`),
      import(`${CDN}/firebase-storage.js`),
    ]);
    F = fsMod; S = stMod;

    app = appMod.initializeApp(firebaseConfig);

    // 오프라인 캐시 — 사파리 프라이빗 모드 등에서 실패할 수 있어 폴백을 둔다.
    try {
      db = F.initializeFirestore(app, {
        localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }),
      });
    } catch (e) {
      db = F.getFirestore(app);
    }

    storage = S.getStorage(app);
    auth = authMod.getAuth(app);

    // 익명 로그인 — 보안 규칙에서 쓸 uid 확보용. 화면에는 아무 변화도 없다.
    const cred = await authMod.signInAnonymously(auth);
    uid = cred.user.uid;
  } catch (e) {
    return fail('초기화', e);
  }

  const userDoc = () => F.doc(db, 'users', uid);
  const convCol = () => F.collection(db, 'users', uid, 'convs');
  const convDoc = (id) => F.doc(db, 'users', uid, 'convs', String(id));
  const turnCol = (id) => F.collection(db, 'users', uid, 'convs', String(id), 'turns');
  const recCol = () => F.collection(db, 'users', uid, 'records');
  const turnId = (seq) => 't' + String(seq).padStart(6, '0');

  // 한 문서에 넣기엔 큰 필드를 잘라둔다 (Firestore 문서 상한 1MiB).
  const cut = (v, n) => (typeof v === 'string' ? v.slice(0, n) : v);

  const PMFire = {
    uid,
    sdkVersion: SDK,
    projectId: firebaseConfig.projectId,

    // ── 대화 (chat.html / index.html) ────────────────────────────────────────
    // 목록만 읽는다. turns 는 openConv 할 때 필요한 것만 가져온다.
    async listConvs(max = 60) {
      const q = F.query(convCol(), F.orderBy('ts', 'desc'), F.limit(max));
      const snap = await F.getDocs(q);
      return snap.docs.map((d) => {
        const v = d.data() || {};
        return { id: d.id, title: v.title || '', student: v.student || '', ts: v.ts || 0, turnCount: v.turnCount || 0 };
      });
    },

    async loadTurns(convId) {
      const q = F.query(turnCol(convId), F.orderBy('seq', 'asc'));
      const snap = await F.getDocs(q);
      return snap.docs.map((d) => {
        const v = d.data() || {};
        return {
          q: v.q || '', a: v.a == null ? null : v.a,
          att: !!v.att, attUrl: v.attUrl || '', attName: v.attName || '',
          sources: v.sources || [],
        };
      });
    },

    async saveConvMeta(conv) {
      await F.setDoc(convDoc(conv.id), {
        title: cut(conv.title || '', 200),
        student: cut(conv.student || '', 100),
        ts: conv.ts || Date.now(),
        turnCount: (conv.turns || []).length,
        updatedAt: F.serverTimestamp(),
      }, { merge: true });
    },

    async saveTurn(convId, seq, turn) {
      await F.setDoc(F.doc(turnCol(convId), turnId(seq)), {
        seq,
        q: cut(turn.q || '', 60000),
        a: turn.a == null ? null : cut(turn.a, 200000),
        att: !!turn.att,
        attUrl: turn.attUrl || '',
        attName: cut(turn.attName || '', 300),
        sources: (turn.sources || []).slice(0, 20).map((s) => ({
          docName: cut((s && (s.docName || s.name)) || String(s), 200),
        })),
        updatedAt: F.serverTimestamp(),
      }, { merge: true });
    },

    // 대화 삭제 — 서브컬렉션은 자동으로 지워지지 않으므로 turns 부터 지운다.
    async deleteConv(convId) {
      const snap = await F.getDocs(turnCol(convId));
      for (let i = 0; i < snap.docs.length; i += 400) {
        const batch = F.writeBatch(db);
        snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
      await F.deleteDoc(convDoc(convId));
    },

    // ── 피드백 기록 (classic.html) ───────────────────────────────────────────
    async addRecord(rec) {
      const ref = F.doc(recCol());
      await F.setDoc(ref, {
        student: cut(rec.student || '', 100),
        missionType: cut(rec.missionType || '', 50),
        mission: cut(rec.mission || '', 60000),
        answer: cut(rec.answer || '', 200000),
        mode: cut(rec.mode || '', 20),
        time: cut(rec.time || '', 60),
        imageUrl: rec.imageUrl || '',
        sources: (rec.sources || []).slice(0, 20).map((s) => ({
          docName: cut((s && (s.docName || s.name)) || String(s), 200),
        })),
        ts: rec.ts || Date.now(),   // 기존 기록 마이그레이션 시 원래 시각을 보존
        createdAt: F.serverTimestamp(),
      });
      return ref.id;
    },

    async listRecords(max = 100) {
      const q = F.query(recCol(), F.orderBy('ts', 'desc'), F.limit(max));
      const snap = await F.getDocs(q);
      return snap.docs.map((d) => Object.assign({ _id: d.id }, d.data()));
    },

    async clearRecords() {
      const snap = await F.getDocs(recCol());
      for (let i = 0; i < snap.docs.length; i += 400) {
        const batch = F.writeBatch(db);
        snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
    },

    // ── Storage: 워크시트 이미지 ─────────────────────────────────────────────
    // OCR 자체는 기존대로 base64 를 /api/ocr 로 보낸다. Storage 는 "원본 캡처를
    // 나중에 다시 열어볼 수 있게" 보관하는 용도.
    async uploadImage(file, scope) {
      if (!file) throw new Error('파일이 없습니다');
      if (!IMAGE_TYPES.includes(file.type)) throw new Error('지원하지 않는 이미지 형식입니다');
      if (file.size > MAX_UPLOAD_BYTES) throw new Error('이미지가 10MB를 초과합니다');
      const d = new Date();
      const day = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
      const safe = (file.name || 'image').replace(/[^\w.\-가-힣]/g, '_').slice(-80);
      const path = `users/${uid}/uploads/${scope || 'misc'}/${day}/${Date.now()}-${safe}`;
      const ref = S.ref(storage, path);
      await S.uploadBytes(ref, file, { contentType: file.type });
      return { url: await S.getDownloadURL(ref), path };
    },
  };

  // 사용자 문서 — 마지막 접속 시각. 규칙 테스트에도 쓰인다.
  try {
    await F.setDoc(userDoc(), { lastSeenAt: F.serverTimestamp() }, { merge: true });
  } catch (e) {
    return fail('쓰기 권한 확인', e);
  }

  window.PMFire = PMFire;
  window.dispatchEvent(new CustomEvent('pmfire:ready', { detail: { uid } }));
  console.info('[PMFire] Firestore + Storage 연결됨 (uid: ' + uid.slice(0, 8) + '…)');
})();
