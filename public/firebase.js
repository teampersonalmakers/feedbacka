// ─────────────────────────────────────────────────────────────────────────────
// firebase.js — Personalmakers AI · 인증 + Firestore + Storage
//
// <script type="module" src="/firebase.js"> 로 로드되고, 기존 페이지의 일반
// 스크립트가 쓸 수 있도록 window.PMFire 에 API 를 노출한다.
//
// 접근 통제
//   구글 로그인 → directors/{이메일} 문서가 있어야 통과 (디렉터 화이트리스트).
//   화이트리스트에 없으면 즉시 로그아웃시키고 게이트를 닫지 않는다.
//   닉네임이 없으면 설정 화면을 먼저 띄운다.
//
// fail-closed: Firebase 가 안 뜨거나 인증이 안 끝나면 게이트는 열리지 않는다.
// (예전 비밀번호 게이트와 달리 우회 경로가 없다)
//
// 저장
//   users/{uid}/convs/{id}/turns/*  대화
//   users/{uid}/records/{id}        피드백 기록
//   Storage users/{uid}/uploads/**  워크시트 캡처본
// ─────────────────────────────────────────────────────────────────────────────

const SDK = '12.18.0';
const CDN = `https://www.gstatic.com/firebasejs/${SDK}`;

// 웹 앱 config — 브라우저에 그대로 내려가는 공개 식별자입니다.
// 실제 보호는 firestore.rules / storage.rules 가 합니다.
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

// ─── 게이트 UI ───────────────────────────────────────────────────────────────
// 페이지마다 이미 전체화면 오버레이가 있다(#pwGate / #pwOverlay).
// 그 안을 우리 카드로 갈아끼워서, 페이지별 배경 스타일은 그대로 살린다.
const gateEl = () => document.querySelector('#pwGate, #pwOverlay');

function injectStyles() {
  if (document.getElementById('pmauth-style')) return;
  const s = document.createElement('style');
  s.id = 'pmauth-style';
  s.textContent = `
.pmauth { background:#262320; border:1px solid #3a3530; border-radius:16px;
  padding:34px 32px; width:min(360px,calc(100vw - 40px)); text-align:center;
  font-family:'Pretendard','Apple SD Gothic Neo',system-ui,sans-serif;
  box-shadow:0 20px 60px rgba(0,0,0,.35); }
.pmauth h2 { color:#f0ede8; font-size:17px; margin:0 0 6px; font-weight:700; letter-spacing:-.2px; }
.pmauth p { color:#8a857e; font-size:12.5px; margin:0 0 20px; line-height:1.65; }
.pmauth-btn { width:100%; border:0; border-radius:10px; padding:12px;
  font-size:13.5px; font-weight:700; cursor:pointer; font-family:inherit;
  display:flex; align-items:center; justify-content:center; gap:9px; transition:opacity .15s; }
.pmauth-btn:disabled { opacity:.5; cursor:not-allowed; }
.pmauth-google { background:#fff; color:#1f1d1a; }
.pmauth-google:hover:not(:disabled) { opacity:.9; }
.pmauth-ghost { background:none; color:#8a857e; border:1px solid #3a3530; margin-top:10px; }
.pmauth-ghost:hover:not(:disabled) { color:#c8622a; border-color:#c8622a; }
.pmauth-input { width:100%; border:1px solid #3a3530; background:#1c1a17; color:#f0ede8;
  border-radius:10px; padding:12px 14px; font-size:14.5px; text-align:center;
  font-family:inherit; margin-bottom:12px; box-sizing:border-box; }
.pmauth-input:focus { outline:none; border-color:#c8622a; }
.pmauth-msg { font-size:11.5px; min-height:16px; margin-top:10px; line-height:1.5; }
.pmauth-err { color:#e07b6f; }
.pmauth-ok { color:#8a857e; }
.pmauth-who { color:#6f6a63; font-size:11px; margin-top:14px; word-break:break-all; }
`;
  document.head.appendChild(s);
}

function renderGate(html) {
  const el = gateEl();
  if (!el) return null;
  injectStyles();
  el.style.display = 'flex';
  el.style.alignItems = 'center';
  el.style.justifyContent = 'center';
  el.innerHTML = html;
  return el;
}

function closeGate() {
  const el = gateEl();
  if (el) el.style.display = 'none';
}

const GOOGLE_ICON =
  '<svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">' +
  '<path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.7 9.5 24 9.5z"/>' +
  '<path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.2 5.5-4.7 7.2l7.6 5.9c4.4-4.1 6.9-10.1 6.9-17.6z"/>' +
  '<path fill="#FBBC05" d="M10.4 28.7c-.5-1.4-.8-2.9-.8-4.7s.3-3.3.8-4.7l-7.8-6.1C.9 16.4 0 20.1 0 24s.9 7.6 2.6 10.8l7.8-6.1z"/>' +
  '<path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.8 2.3-8.3 2.3-6.3 0-11.7-3.7-13.6-9.7l-7.8 6.1C6.5 42.6 14.6 48 24 48z"/></svg>';

function gateLogin(msg, isError) {
  return renderGate(`
    <div class="pmauth">
      <h2>Personalmakers AI</h2>
      <p>디렉터 전용입니다.<br>등록된 구글 계정으로 로그인해주세요.</p>
      <button class="pmauth-btn pmauth-google" id="pmauthGoogle">${GOOGLE_ICON}<span>Google로 로그인</span></button>
      <div class="pmauth-msg ${isError ? 'pmauth-err' : 'pmauth-ok'}" id="pmauthMsg">${msg || ''}</div>
    </div>`);
}

function gateDenied(email) {
  return renderGate(`
    <div class="pmauth">
      <h2>접근 권한이 없습니다</h2>
      <p>디렉터로 등록된 계정만 이용할 수 있어요.<br>커밍쏜에게 계정 등록을 요청해주세요.</p>
      <button class="pmauth-btn pmauth-ghost" id="pmauthOut">다른 계정으로 로그인</button>
      <div class="pmauth-who">${email || ''}</div>
    </div>`);
}

function gateNickname(suggested) {
  return renderGate(`
    <div class="pmauth">
      <h2>닉네임을 정해주세요</h2>
      <p>기록과 피드백에 표시될 이름이에요.<br>나중에 헤더에서 바꿀 수 있습니다.</p>
      <input class="pmauth-input" id="pmauthNick" maxlength="20" placeholder="예: 커밍쏜" value="${(suggested || '').replace(/"/g, '&quot;')}">
      <button class="pmauth-btn pmauth-google" id="pmauthSave">시작하기</button>
      <div class="pmauth-msg pmauth-err" id="pmauthMsg"></div>
    </div>`);
}

function gateFatal(detail) {
  return renderGate(`
    <div class="pmauth">
      <h2>로그인을 시작할 수 없습니다</h2>
      <p>네트워크나 Firebase 설정을 확인해주세요.<br>새로고침하면 다시 시도합니다.</p>
      <button class="pmauth-btn pmauth-ghost" onclick="location.reload()">새로고침</button>
      <div class="pmauth-who">${(detail || '').slice(0, 200)}</div>
    </div>`);
}

// ─── 부트 ────────────────────────────────────────────────────────────────────
(async function boot() {
  let A, F, S, app, auth, db, storage;

  try {
    const [appMod, authMod, fsMod, stMod] = await Promise.all([
      import(`${CDN}/firebase-app.js`),
      import(`${CDN}/firebase-auth.js`),
      import(`${CDN}/firebase-firestore.js`),
      import(`${CDN}/firebase-storage.js`),
    ]);
    A = authMod; F = fsMod; S = stMod;

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
    auth = A.getAuth(app);
    await A.setPersistence(auth, A.browserLocalPersistence).catch(() => {});
  } catch (e) {
    console.error('[PMFire] 초기화 실패:', e);
    gateFatal(e && e.message);
    window.dispatchEvent(new CustomEvent('pmfire:error', { detail: { stage: '초기화', error: String(e) } }));
    return;
  }

  const provider = new A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  async function doLogin(btn, msgEl) {
    if (btn) { btn.disabled = true; }
    if (msgEl) { msgEl.className = 'pmauth-msg pmauth-ok'; msgEl.textContent = '구글 인증 창을 확인해주세요…'; }
    try {
      await A.signInWithPopup(auth, provider);
      // 이후 처리는 onAuthStateChanged 가 이어받는다.
    } catch (e) {
      const code = e && e.code ? e.code : '';
      const msg =
        code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request'
          ? '로그인이 취소됐어요.'
          : code === 'auth/popup-blocked'
          ? '팝업이 차단됐어요. 브라우저 팝업 허용 후 다시 시도해주세요.'
          : code === 'auth/unauthorized-domain'
          ? '이 도메인이 Firebase 승인 도메인에 없습니다. 콘솔에서 추가해주세요.'
          : '로그인 실패: ' + (e && e.message ? e.message : code);
      if (msgEl) { msgEl.className = 'pmauth-msg pmauth-err'; msgEl.textContent = msg; }
      if (btn) btn.disabled = false;
    }
  }

  function wireLogin() {
    const btn = document.getElementById('pmauthGoogle');
    const msg = document.getElementById('pmauthMsg');
    if (btn) btn.onclick = () => doLogin(btn, msg);
  }

  function wireSignOut() {
    const btn = document.getElementById('pmauthOut');
    if (btn) btn.onclick = () => A.signOut(auth);
  }

  const emailKey = (e) => String(e || '').trim().toLowerCase();

  // 화이트리스트 확인. 규칙에서도 같은 검사를 하므로 여기서 통과해도 서버가 막는다.
  async function lookupDirector(email) {
    const snap = await F.getDoc(F.doc(db, 'directors', emailKey(email)));
    if (!snap.exists()) return null;
    const d = snap.data() || {};
    return d.active === false ? null : d;
  }

  let PMFire = null;

  function buildApi(user, director, profile) {
    const uid = user.uid;
    const convCol = () => F.collection(db, 'users', uid, 'convs');
    const convDoc = (id) => F.doc(db, 'users', uid, 'convs', String(id));
    const turnCol = (id) => F.collection(db, 'users', uid, 'convs', String(id), 'turns');
    const recCol = () => F.collection(db, 'users', uid, 'records');
    const turnId = (seq) => 't' + String(seq).padStart(6, '0');
    const cut = (v, n) => (typeof v === 'string' ? v.slice(0, n) : v);

    return {
      uid,
      sdkVersion: SDK,
      projectId: firebaseConfig.projectId,
      profile: {
        uid,
        email: user.email || '',
        nickname: profile.nickname || '',
        displayName: user.displayName || '',
        photoURL: user.photoURL || '',
        role: director.role || 'director',
      },

      signOut: () => A.signOut(auth),

      async setNickname(nickname) {
        const n = String(nickname || '').trim().slice(0, 20);
        if (!n) throw new Error('닉네임을 입력해주세요');
        await F.setDoc(F.doc(db, 'users', uid), { nickname: n, updatedAt: F.serverTimestamp() }, { merge: true });
        this.profile.nickname = n;
        window.dispatchEvent(new CustomEvent('pmfire:profile', { detail: { nickname: n } }));
        return n;
      },

      // ── 대화 ────────────────────────────────────────────────────────────
      async listConvs(max = 60) {
        const snap = await F.getDocs(F.query(convCol(), F.orderBy('ts', 'desc'), F.limit(max)));
        return snap.docs.map((d) => {
          const v = d.data() || {};
          return { id: d.id, title: v.title || '', student: v.student || '', ts: v.ts || 0, turnCount: v.turnCount || 0 };
        });
      },

      async loadTurns(convId) {
        const snap = await F.getDocs(F.query(turnCol(convId), F.orderBy('seq', 'asc')));
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

      // 서브컬렉션은 자동으로 지워지지 않으므로 turns 부터 지운다.
      async deleteConv(convId) {
        const snap = await F.getDocs(turnCol(convId));
        for (let i = 0; i < snap.docs.length; i += 400) {
          const batch = F.writeBatch(db);
          snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
          await batch.commit();
        }
        await F.deleteDoc(convDoc(convId));
      },

      // ── 피드백 기록 ─────────────────────────────────────────────────────
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
          director: this.profile.nickname || '',
          sources: (rec.sources || []).slice(0, 20).map((s) => ({
            docName: cut((s && (s.docName || s.name)) || String(s), 200),
          })),
          ts: rec.ts || Date.now(),
          createdAt: F.serverTimestamp(),
        });
        return ref.id;
      },

      async listRecords(max = 100) {
        const snap = await F.getDocs(F.query(recCol(), F.orderBy('ts', 'desc'), F.limit(max)));
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

      // ── Storage: 워크시트 이미지 ────────────────────────────────────────
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
  }

  // 헤더에 닉네임 배지를 붙인다. 클릭하면 닉네임을 바꿀 수 있다.
  function mountBadge(api) {
    if (document.getElementById('pmauthBadge')) return;
    const host = document.querySelector('header, .top-bar, .header');
    if (!host) return;
    const b = document.createElement('button');
    b.id = 'pmauthBadge';
    b.type = 'button';
    b.style.cssText =
      'margin-left:auto;background:rgba(200,98,42,.14);border:1px solid rgba(200,98,42,.35);' +
      'color:#c8622a;border-radius:20px;padding:5px 12px;font-size:11.5px;font-weight:700;' +
      'cursor:pointer;font-family:inherit;white-space:nowrap;';
    const paint = () => { b.textContent = '👤 ' + (api.profile.nickname || '닉네임 설정'); };
    paint();
    window.addEventListener('pmfire:profile', paint);
    b.onclick = async () => {
      const next = prompt('닉네임을 입력하세요 (최대 20자)', api.profile.nickname || '');
      if (next === null) return;
      if (!next.trim()) {
        if (confirm('로그아웃할까요?')) api.signOut();
        return;
      }
      try { await api.setNickname(next); } catch (e) { alert(e.message); }
    };
    host.appendChild(b);
  }

  // ─── 인증 상태 ─────────────────────────────────────────────────────────────
  gateLogin('');
  wireLogin();

  A.onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.PMFire = null;
      PMFire = null;
      gateLogin('');
      wireLogin();
      return;
    }

    let director;
    try {
      director = await lookupDirector(user.email);
    } catch (e) {
      // 규칙이 막았거나 네트워크 문제. 통과시키지 않는다.
      console.warn('[PMFire] 디렉터 확인 실패:', e.message);
      gateLogin('디렉터 확인에 실패했어요. 잠시 후 다시 시도해주세요.', true);
      wireLogin();
      await A.signOut(auth).catch(() => {});
      return;
    }

    if (!director) {
      gateDenied(user.email);
      wireSignOut();
      await A.signOut(auth).catch(() => {});
      return;
    }

    // 프로필 확보 (+ 마지막 접속 기록)
    let profile = {};
    try {
      const ref = F.doc(db, 'users', user.uid);
      const snap = await F.getDoc(ref);
      profile = snap.exists() ? snap.data() || {} : {};
      await F.setDoc(ref, {
        email: user.email || '',
        displayName: user.displayName || '',
        photoURL: user.photoURL || '',
        role: director.role || 'director',
        lastSeenAt: F.serverTimestamp(),
      }, { merge: true });
    } catch (e) {
      console.warn('[PMFire] 프로필 저장 실패:', e.message);
      gateLogin('프로필을 불러오지 못했어요. 새로고침 후 다시 시도해주세요.', true);
      wireLogin();
      await A.signOut(auth).catch(() => {});
      return;
    }

    const api = buildApi(user, director, profile);
    PMFire = api;

    // 닉네임이 없으면 먼저 정하게 한다.
    if (!api.profile.nickname) {
      const suggested = director.name || user.displayName || '';
      gateNickname(suggested);
      const input = document.getElementById('pmauthNick');
      const save = document.getElementById('pmauthSave');
      const msg = document.getElementById('pmauthMsg');
      const submit = async () => {
        save.disabled = true;
        try {
          await api.setNickname(input.value);
          finish(api);
        } catch (e) {
          msg.textContent = e.message;
          save.disabled = false;
        }
      };
      save.onclick = submit;
      input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
      input.focus();
      input.select();
      return;
    }

    finish(api);
  });

  function finish(api) {
    window.PMFire = api;
    closeGate();
    mountBadge(api);
    window.dispatchEvent(new CustomEvent('pmfire:ready', { detail: { uid: api.uid, nickname: api.profile.nickname } }));
    console.info('[PMFire] 로그인 완료:', api.profile.nickname, '(' + api.profile.email + ')');
  }
})();
