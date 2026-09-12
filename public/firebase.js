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

// ⚠️ 소유자 계정 — firestore.rules / storage.rules 의 값과 반드시 동일하게 유지.
// 화이트리스트가 비어 있어도 이 계정은 통과한다(최초 부트스트랩 / 잠금 해제용).
// 실제 강제는 보안 규칙이 하고, 여기 목록은 화면 흐름을 맞추기 위한 것이다.
const OWNER_EMAILS = ['comingssoni@gmail.com'];

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
.pmauth { background:#fff; border:1px solid #e5e8ee; border-radius:16px;
  padding:34px 32px; width:min(360px,calc(100vw - 40px)); text-align:center;
  font-family:'Pretendard',-apple-system,BlinkMacSystemFont,'Segoe UI','Apple SD Gothic Neo',sans-serif;
  box-shadow:0 12px 40px rgba(16,24,40,.10); }
.pmauth h2 { color:#1a1d23; font-size:17px; margin:0 0 6px; font-weight:800; letter-spacing:-.2px; }
.pmauth p { color:#4a5160; font-size:12.5px; margin:0 0 20px; line-height:1.65; }
.pmauth-btn { width:100%; border:0; border-radius:10px; padding:12px;
  font-size:13.5px; font-weight:700; cursor:pointer; font-family:inherit;
  display:flex; align-items:center; justify-content:center; gap:9px; transition:all .15s; }
.pmauth-btn:disabled { opacity:.5; cursor:not-allowed; }
.pmauth-google { background:#2f6bff; color:#fff; }
.pmauth-google:hover:not(:disabled) { background:#2358e0; }
.pmauth-ghost { background:none; color:#4a5160; border:1px solid #e5e8ee; margin-top:10px; }
.pmauth-ghost:hover:not(:disabled) { color:#2f6bff; border-color:#2f6bff; }
.pmauth-input { width:100%; border:1px solid #e5e8ee; background:#fff; color:#1a1d23;
  border-radius:10px; padding:12px 14px; font-size:14.5px; text-align:center;
  font-family:inherit; margin-bottom:12px; box-sizing:border-box; }
.pmauth-input:focus { outline:none; border-color:#2f6bff; box-shadow:0 0 0 3px rgba(47,107,255,.12); }
.pmauth-msg { font-size:11.5px; min-height:16px; margin-top:10px; line-height:1.5; }
.pmauth-err { color:#d0453d; }
.pmauth-ok { color:#8a91a0; }
.pmauth-who { color:#8a91a0; font-size:11px; margin-top:14px; word-break:break-all; }
.pmauth-spin { width:24px; height:24px; margin:0 auto; border:2.5px solid #e5e8ee; border-top-color:#2f6bff; border-radius:50%; animation:pmspin .8s linear infinite; }
@keyframes pmspin { to { transform:rotate(360deg); } }

.pmmenu { position:absolute; z-index:99997; min-width:230px; background:#fff; border:1px solid #e5e8ee;
  border-radius:12px; padding:6px; box-shadow:0 12px 40px rgba(16,24,40,.14);
  font-family:'Pretendard',-apple-system,BlinkMacSystemFont,'Segoe UI','Apple SD Gothic Neo',sans-serif; }
.pmmenu .who { padding:8px 10px 10px; border-bottom:1px solid #e5e8ee; margin-bottom:4px; }
.pmmenu .who b { display:block; color:#1a1d23; font-size:13px; }
.pmmenu .who span { display:block; color:#8a91a0; font-size:11px; margin-top:2px; word-break:break-all; }
.pmmenu button, .pmmenu a { display:flex; align-items:center; gap:8px; width:100%; text-align:left; border:0; background:transparent;
  color:#1a1d23; font-size:13px; padding:9px 10px; border-radius:8px; cursor:pointer; font-family:inherit; text-decoration:none; }
.pmmenu button:hover, .pmmenu a:hover { background:#eef3ff; color:#2f6bff; }
.pmmenu .danger { color:#d0453d; }
.pmmenu .danger:hover { background:#fdeceb; color:#d0453d; }
.pmadmin input.pmnick { width:100%; box-sizing:border-box; background:#fff; border:1px solid #e5e8ee; border-radius:10px;
  padding:12px 14px; color:#1a1d23; font-size:15px; font-family:inherit; outline:none; }
.pmadmin input.pmnick:focus { border-color:#2f6bff; box-shadow:0 0 0 3px rgba(47,107,255,.12); }
.pmadmin-back { position:fixed; inset:0; z-index:99998; background:rgba(26,29,35,.45);
  display:flex; align-items:center; justify-content:center; padding:20px; }
.pmadmin { background:#fff; border:1px solid #e5e8ee; border-radius:16px;
  width:min(430px,100%); max-height:82vh; overflow:auto; padding:26px 24px;
  font-family:'Pretendard',-apple-system,BlinkMacSystemFont,'Segoe UI','Apple SD Gothic Neo',sans-serif;
  box-shadow:0 24px 70px rgba(16,24,40,.22); }
.pmadmin h3 { color:#1a1d23; font-size:15.5px; margin:0 0 4px; font-weight:800; }
.pmadmin .sub { color:#4a5160; font-size:12px; margin:0 0 18px; line-height:1.6; }
.pmadmin-row { display:flex; align-items:center; gap:8px; padding:9px 10px;
  border:1px solid #e5e8ee; border-radius:9px; margin-bottom:6px; }
.pmadmin-row .nm { color:#1a1d23; font-size:12.5px; font-weight:600; flex-shrink:0; }
.pmadmin-row .em { color:#8a91a0; font-size:11px; flex:1; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.pmadmin-row .tag { font-size:9.5px; font-weight:700; color:#2f6bff;
  background:#eef3ff; border-radius:4px; padding:2px 6px; flex-shrink:0; }
.pmadmin-row .del { background:none; border:0; color:#8a91a0; cursor:pointer;
  font-size:13px; padding:2px 4px; flex-shrink:0; }
.pmadmin-row .del:hover { color:#d0453d; }
.pmadmin-grid { display:grid; grid-template-columns:1fr 110px; gap:8px; margin-top:14px; }
.pmadmin input { border:1px solid #e5e8ee; background:#fff; color:#1a1d23;
  border-radius:9px; padding:10px 12px; font-size:13px; font-family:inherit;
  width:100%; box-sizing:border-box; }
.pmadmin input:focus { outline:none; border-color:#2f6bff; box-shadow:0 0 0 3px rgba(47,107,255,.12); }
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

// 페이지를 열 때마다 잠깐 보이는 화면. 로그인은 브라우저에 저장돼 있으므로(브라우저 로컬
// 지속) 대개 1~2초 안에 자동으로 통과한다. 이 동안 로그인 버튼을 보여주면 "또 로그인해야
// 하나" 하고 누르게 되므로, 버튼 대신 확인 중 표시만 둔다.
function gateChecking(msg) {
  return renderGate(`
    <div class="pmauth">
      <div class="pmauth-spin"></div>
      <p style="margin:14px 0 0">${msg || '로그인 상태 확인 중…'}</p>
    </div>`);
}

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
    const id = emailKey(email);
    const owner = OWNER_EMAILS.includes(id);

    let d = null;
    try {
      const snap = await F.getDoc(F.doc(db, 'directors', id));
      if (snap.exists()) d = snap.data() || {};
    } catch (e) {
      // 소유자는 문서를 못 읽어도 통과시킨다. 그 외에는 에러를 그대로 올린다.
      if (!owner) throw e;
    }

    if (owner) return Object.assign({ name: '커밍쏜', role: 'admin' }, d || {}, { role: 'admin' });
    if (!d || d.active === false) return null;
    return d;
  }

  let PMFire = null;

  const cut = (v, n) => (typeof v === 'string' ? v.slice(0, n) : v);

  function buildApi(user, director, profile) {
    const uid = user.uid;
    const convCol = () => F.collection(db, 'users', uid, 'convs');
    const convDoc = (id) => F.doc(db, 'users', uid, 'convs', String(id));
    const turnCol = (id) => F.collection(db, 'users', uid, 'convs', String(id), 'turns');
    const recCol = () => F.collection(db, 'users', uid, 'records');
    const turnId = (seq) => 't' + String(seq).padStart(6, '0');

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

      // ── 디렉터 화이트리스트 관리 (admin 전용) ───────────────────────────
      // 규칙이 admin 만 허용하므로, 권한이 없으면 서버가 거부한다.
      isAdmin: () => (director.role || 'director') === 'admin',

      async listDirectors() {
        const snap = await F.getDocs(F.collection(db, 'directors'));
        return snap.docs
          .map((d) => Object.assign({ id: d.id }, d.data()))
          .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ko'));
      },

      async addDirector(email, name, role) {
        const id = String(email || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id)) throw new Error('이메일 형식이 올바르지 않습니다');
        const nm = String(name || '').trim().slice(0, 30);
        if (!nm) throw new Error('이름을 입력해주세요');
        await F.setDoc(F.doc(db, 'directors', id), {
          email: id,
          name: nm,
          role: role === 'admin' ? 'admin' : 'director',
          active: true,
          updatedAt: F.serverTimestamp(),
        }, { merge: true });
        return id;
      },

      async removeDirector(email) {
        await F.deleteDoc(F.doc(db, 'directors', String(email || '').trim().toLowerCase()));
      },

      async setNickname(nickname) {
        const n = String(nickname || '').trim().slice(0, 20);
        if (!n) throw new Error('닉네임을 입력해주세요');
        await F.setDoc(F.doc(db, 'users', uid), { nickname: n, updatedAt: F.serverTimestamp() }, { merge: true });
        this.profile.nickname = n;
        window.dispatchEvent(new CustomEvent('pmfire:profile', { detail: { nickname: n } }));
        return n;
      },

      // ── 지식베이스 원문 (내부 인사이트) — 커밍쏜 전용 ────────────────────
      // firestore.rules 가 소유자 계정만 허용한다. 디렉터는 여기 못 들어온다.
      isOwner: () => OWNER_EMAILS.includes(String(user.email || '').toLowerCase()),

      // /api/kb-clean 호출용. 서버가 이 토큰으로 본인 확인을 한다.
      idToken: () => user.getIdToken(),

      async listKb(max = 500) {
        const snap = await F.getDocs(F.query(F.collection(db, 'kbSources'), F.limit(max)));
        return snap.docs
          .map((d) => Object.assign({ id: d.id }, d.data()))
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      },

      async getKb(id) {
        const d = await F.getDoc(F.doc(db, 'kbSources', id));
        return d.exists() ? Object.assign({ id: d.id }, d.data()) : null;
      },

      async saveKb(id, data) {
        const t = String(data.transcript || '');
        const payload = {
          name: cut(String(data.name || '').trim(), 300),
          type: data.type || 'youtube',
          category: data.category || 'general',
          status: data.status || '완료',
          link: cut(data.link || '', 500),
          memo: cut(data.memo || '', 2000),
          tags: (data.tags || []).slice(0, 10),
          transcript: t,
          transcriptChars: t.length,
          transcriptTruncated: false,
          updatedAtMs: Date.now(),
          updatedAt: F.serverTimestamp(),
        };
        if (!payload.name) throw new Error('소스명을 입력해주세요');
        if (id) { await F.setDoc(F.doc(db, 'kbSources', id), payload, { merge: true }); return id; }
        const ref = F.doc(F.collection(db, 'kbSources'));
        await F.setDoc(ref, Object.assign({
          createdAt: Date.now(), source: 'app', sourceId: String(Date.now()), chunks: 0,
        }, payload));
        return ref.id;
      },

      async deleteKb(id) { await F.deleteDoc(F.doc(db, 'kbSources', id)); },

      // ── AI 지침 (설정 페이지) — 커밍쏜 전용. 내용이 곧 시스템 프롬프트다. ──
      async listGuidelines() {
        const snap = await F.getDocs(F.collection(db, 'guidelines'));
        return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()))
          .sort((a, b) => (a.order || 0) - (b.order || 0));
      },
      async saveGuideline(id, data) {
        const body = (data.body || []).map((x) => cut(String(x).trim(), 2000)).filter(Boolean).slice(0, 60);
        const payload = {
          section: data.section, category: data.category || '', name: cut(data.name || '', 100),
          body, active: data.active !== false, order: Number(data.order) || 0,
          updatedAt: Date.now(), updatedBy: user.email,
        };
        const ref = F.doc(db, 'guidelines', id);
        await F.setDoc(ref, payload, { merge: true });
        return ref.id;
      },
      async deleteGuideline(id) { await F.deleteDoc(F.doc(db, 'guidelines', id)); },

      // ── 디렉팅 사례 (설정 페이지) — aiApplied 가 켜진 것만 AI 가 참고한다. ──
      async listCases() {
        const snap = await F.getDocs(F.collection(db, 'cases'));
        return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()))
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      },
      async saveCase(id, data) {
        const payload = {
          summary: cut(String(data.summary || '').trim(), 300),
          body: cut(String(data.body || ''), 20000),
          cohort: cut(data.cohort || '', 30), round: cut(data.round || '', 30),
          director: cut(data.director || '', 50), participants: cut(data.participants || '', 200),
          // 판단 카드 구조 (녹취 증류 결과·직접 입력). 비어 있으면 body 만 쓴다.
          situation: cut(data.situation || '', 2000), diagnosis: cut(data.diagnosis || '', 2000),
          prescription: cut(data.prescription || '', 3000), reasoning: cut(data.reasoning || '', 2000),
          quote: cut(data.quote || '', 1000), tags: (data.tags || []).slice(0, 5).map((t) => cut(String(t), 20)),
          status: cut(data.status || (data.aiApplied ? 'approved' : 'inactive'), 20),
          confirmed: data.confirmed !== false, aiApplied: !!data.aiApplied,
          updatedAt: Date.now(), updatedBy: user.email,
        };
        if (!payload.summary) throw new Error('요약(제목)을 입력해주세요');
        if (id) { await F.setDoc(F.doc(db, 'cases', id), payload, { merge: true }); return id; }
        const ref = F.doc(F.collection(db, 'cases'));
        await F.setDoc(ref, Object.assign({ createdAt: Date.now(), source: 'app' }, payload));
        return ref.id;
      },
      async deleteCase(id) { await F.deleteDoc(F.doc(db, 'cases', id)); },

      // ── 플레이북 ────────────────────────────────────────────────────────
      // 디렉터가 초안을 쓰고, 커밍쏜(admin)이 승인한다.
      // 승인된 Q&A 만 api/feedback.js 가 시스템 프롬프트에 넣는다.
      // 여기서 막아도 진짜 강제는 firestore.rules 가 한다.
      async listPlaybook(max = 300) {
        const snap = await F.getDocs(F.query(F.collection(db, 'playbook'), F.limit(max)));
        return snap.docs
          .map((d) => Object.assign({ id: d.id }, d.data()))
          .sort((a, b) => (b.updatedAtMs || b.createdAt || 0) - (a.updatedAtMs || a.createdAt || 0));
      },

      async savePlaybook(id, data) {
        const now = Date.now();
        const payload = {
          question: cut(String(data.question || '').trim(), 500),
          originalQuestion: cut(data.originalQuestion || '', 60000),
          answer: cut(data.answer || '', 200000),
          status: data.status || '답변작성',
          category: cut(data.category || '', 100),
          student: cut(data.student || '', 100),
          cohort: cut(data.cohort || '', 10),
          consultDate: cut(data.consultDate || '', 10),   // YYYY-MM-DD, 질문을 실제로 받은 날
          director: cut(data.director || this.profile.nickname || '', 50),
          type: data.type || '수동등록',
          updatedAtMs: now,
          updatedBy: cut(this.profile.nickname || '', 50),
          updatedAt: F.serverTimestamp(),
        };
        if (!payload.question) throw new Error('질문을 입력해주세요');
        if (data.status === '승인') {
          payload.approvedBy = cut(this.profile.nickname || '', 50);
          payload.approvedAtMs = now;
        }
        if (id) {
          await F.setDoc(F.doc(db, 'playbook', id), payload, { merge: true });
          return id;
        }
        const ref = F.doc(F.collection(db, 'playbook'));
        await F.setDoc(ref, Object.assign({ createdAt: now, source: 'app' }, payload));
        return ref.id;
      },

      async deletePlaybook(id) {
        await F.deleteDoc(F.doc(db, 'playbook', id));
      },

      // ── 대화 ────────────────────────────────────────────────────────────
      async listConvs(max = 60) {
        const snap = await F.getDocs(F.query(convCol(), F.orderBy('ts', 'desc'), F.limit(max)));
        return snap.docs.map((d) => {
          const v = d.data() || {};
          return { id: d.id, title: v.title || '', student: v.student || '', cohort: v.cohort || '', ts: v.ts || 0, turnCount: v.turnCount || 0 };
        });
      },

      async loadTurns(convId) {
        const snap = await F.getDocs(F.query(turnCol(convId), F.orderBy('seq', 'asc')));
        return snap.docs.map((d) => {
          const v = d.data() || {};
          return {
            q: v.q || '', a: v.a == null ? null : v.a, ts: v.ts || 0,
            att: !!v.att, attUrl: v.attUrl || '', attName: v.attName || '',
            sources: v.sources || [],
            evidence: v.evidence || null,
          };
        });
      },

      async saveConvMeta(conv) {
        await F.setDoc(convDoc(conv.id), {
          title: cut(conv.title || '', 200),
          student: cut(conv.student || '', 100),
          cohort: cut(conv.cohort || '', 10),
          ts: conv.ts || Date.now(),
          turnCount: (conv.turns || []).length,
          updatedAt: F.serverTimestamp(),
        }, { merge: true });
      },

      async saveTurn(convId, seq, turn) {
        await F.setDoc(F.doc(turnCol(convId), turnId(seq)), {
          seq,
          ts: Number(turn.ts) || 0,
          q: cut(turn.q || '', 60000),
          a: turn.a == null ? null : cut(turn.a, 200000),
          att: !!turn.att,
          attUrl: turn.attUrl || '',
          attName: cut(turn.attName || '', 300),
          sources: (turn.sources || []).slice(0, 20).map((s) => ({
            docName: cut((s && (s.docName || s.name)) || String(s), 200),
          })),
          // 답변 근거(🔍 근거 보기). 다른 기기에서 열어도 보이도록 짧게 보관한다.
          evidence: turn.evidence ? {
            sources: (turn.evidence.sources || []).slice(0, 8).map((x) => ({
              docName: cut(x.docName || '', 200), docType: cut(x.docType || '', 40), score: Number(x.score) || 0, text: cut(x.text || '', 400),
            })),
            cases: (turn.evidence.cases || []).slice(0, 4).map((c) => ({
              summary: cut(c.summary || '', 300), cohort: cut(c.cohort || '', 40), text: cut(c.text || '', 400),
            })),
            playbook: Number(turn.evidence.playbook) || 0,
            studentMemory: !!turn.evidence.studentMemory,
          } : null,
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

  // 디렉터 관리 모달 (admin 전용)
  function openNickname(api) {
    const back = document.createElement('div');
    back.className = 'pmadmin-back';
    back.innerHTML = `
      <div class="pmadmin">
        <h3>닉네임 변경</h3>
        <p class="sub">플레이북과 상담 기록에 이 이름으로 남습니다. 최대 20자.</p>
        <input class="pmnick" id="pmnickInput" maxlength="20" placeholder="닉네임" autocomplete="off">
        <button class="pmauth-btn pmauth-google" id="pmnickSave" style="margin-top:12px">저장</button>
        <div class="pmauth-msg pmauth-err" id="pmnickMsg"></div>
        <button class="pmauth-btn pmauth-ghost" id="pmnickClose">닫기</button>
      </div>`;
    document.body.appendChild(back);
    const input = back.querySelector('#pmnickInput');
    const msg = back.querySelector('#pmnickMsg');
    input.value = api.profile.nickname || '';
    const close = () => back.remove();
    back.querySelector('#pmnickClose').onclick = close;
    back.onclick = (e) => { if (e.target === back) close(); };
    const save = async () => {
      const v = input.value.trim();
      if (!v) { msg.textContent = '닉네임을 입력해주세요'; return; }
      try { await api.setNickname(v); close(); } catch (e) { msg.textContent = e.message; }
    };
    back.querySelector('#pmnickSave').onclick = save;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    setTimeout(() => input.focus(), 0);
  }

  async function openAdmin(api) {
    const back = document.createElement('div');
    back.className = 'pmadmin-back';
    back.innerHTML = `
      <div class="pmadmin">
        <h3>디렉터 관리</h3>
        <p class="sub">등록된 구글 계정만 이 앱에 로그인할 수 있습니다.</p>
        <div id="pmadminList" style="color:#8a91a0;font-size:12px">불러오는 중…</div>
        <div class="pmadmin-grid">
          <input id="pmadminEmail" type="email" placeholder="구글 계정 이메일" autocomplete="off">
          <input id="pmadminName" maxlength="30" placeholder="이름">
        </div>
        <button class="pmauth-btn pmauth-google" id="pmadminAdd" style="margin-top:8px">추가하기</button>
        <div class="pmauth-msg pmauth-err" id="pmadminMsg"></div>
        <button class="pmauth-btn pmauth-ghost" id="pmadminClose">닫기</button>
      </div>`;
    document.body.appendChild(back);

    const listEl = back.querySelector('#pmadminList');
    const msg = back.querySelector('#pmadminMsg');
    const close = () => back.remove();
    back.querySelector('#pmadminClose').onclick = close;
    back.onclick = (e) => { if (e.target === back) close(); };

    async function refresh() {
      try {
        const rows = await api.listDirectors();
        if (!rows.length) {
          listEl.innerHTML = '<div style="color:#6f6a63;font-size:12px;padding:8px 0">' +
            '아직 등록된 디렉터가 없습니다. 소유자 계정은 목록과 무관하게 로그인됩니다.</div>';
          return;
        }
        listEl.innerHTML = '';
        rows.forEach((r) => {
          const row = document.createElement('div');
          row.className = 'pmadmin-row';
          row.innerHTML =
            `<span class="nm"></span><span class="em"></span>` +
            (r.role === 'admin' ? '<span class="tag">ADMIN</span>' : '') +
            '<button class="del" title="삭제">✕</button>';
          row.querySelector('.nm').textContent = r.name || '(이름 없음)';
          row.querySelector('.em').textContent = r.email || r.id;
          row.querySelector('.del').onclick = async () => {
            if (!confirm((r.name || r.id) + ' 님의 접근 권한을 삭제할까요?\n(기록은 그대로 보존됩니다)')) return;
            try { await api.removeDirector(r.id); await refresh(); }
            catch (e) { msg.textContent = '삭제 실패: ' + e.message; }
          };
          listEl.appendChild(row);
        });
      } catch (e) {
        listEl.innerHTML = '<div style="color:#e07b6f;font-size:12px">목록을 불러오지 못했습니다: ' + e.message + '</div>';
      }
    }

    const emailEl = back.querySelector('#pmadminEmail');
    const nameEl = back.querySelector('#pmadminName');
    const addBtn = back.querySelector('#pmadminAdd');
    addBtn.onclick = async () => {
      msg.textContent = '';
      addBtn.disabled = true;
      try {
        await api.addDirector(emailEl.value, nameEl.value);
        emailEl.value = ''; nameEl.value = '';
        await refresh();
      } catch (e) {
        msg.textContent = e.message;
      }
      addBtn.disabled = false;
    };
    nameEl.onkeydown = (e) => { if (e.key === 'Enter') addBtn.click(); };

    refresh();
  }

  // 헤더에 닉네임 배지를 붙인다. 클릭하면 메뉴가 열린다.
  function mountBadge(api) {
    if (document.getElementById('pmauthBadge')) return;
    const host = document.querySelector('header, .top-bar, .header');
    if (!host) return;

    // 내비게이션 — 현재 페이지에 해당하는 링크는 띄우지 않는다.
    // '설정'(AI 지침·디렉팅 사례·지식베이스)은 소유자 계정에만 보인다(규칙에서도 막혀 있다).
    const links = [
      { id: 'pmNavPlaybook', href: '/playbook.html', label: '📒 플레이북', match: /\/playbook(\.html)?$/, show: true },
      { id: 'pmNavInsight', href: '/settings.html', label: '⚙️ 설정', match: /\/(settings|insight)(\.html)?$/, show: api.isOwner() },
    ];
    let first = true;
    for (const l of links) {
      if (!l.show || l.match.test(location.pathname)) continue;
      const nav = document.createElement('a');
      nav.id = l.id;
      nav.href = l.href;
      nav.textContent = l.label;
      nav.style.cssText =
        (first ? 'margin-left:auto;' : '') +
        'background:#fff;border:1px solid #e5e8ee;' +
        'color:#4a5160;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;' +
        'cursor:pointer;font-family:inherit;white-space:nowrap;text-decoration:none;margin-right:8px;';
      host.appendChild(nav);
      first = false;
    }
    const b = document.createElement('button');
    b.id = 'pmauthBadge';
    b.type = 'button';
    b.style.cssText =
      (document.getElementById('pmNavPlaybook') || document.getElementById('pmNavInsight') ? '' : 'margin-left:auto;') +
      'background:#eef3ff;border:1px solid #c9d8ff;' +
      'color:#2f6bff;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:700;' +
      'cursor:pointer;font-family:inherit;white-space:nowrap;';
    const paint = () => { b.textContent = '👤 ' + (api.profile.nickname || '닉네임 설정'); };
    paint();
    window.addEventListener('pmfire:profile', paint);

    // 드롭다운 메뉴. 예전엔 prompt() 에 번호를 치게 했다.
    let menu = null;
    const closeMenu = () => { if (menu) { menu.remove(); menu = null; } };
    b.onclick = (e) => {
      e.stopPropagation();
      if (menu) return closeMenu();
      menu = document.createElement('div');
      menu.className = 'pmmenu';
      const item = (label, fn, cls) => {
        const el = document.createElement('button'); el.type = 'button';
        el.textContent = label; if (cls) el.className = cls;
        el.onclick = () => { closeMenu(); fn(); };
        menu.appendChild(el);
      };
      const who = document.createElement('div'); who.className = 'who';
      who.innerHTML = '<b></b><span></span>';
      who.querySelector('b').textContent = api.profile.nickname || '닉네임 미설정';
      who.querySelector('span').textContent = api.profile.email + (api.isAdmin() ? ' · 관리자' : '');
      menu.appendChild(who);
      item('✏️ 닉네임 변경', () => openNickname(api));
      if (api.isAdmin()) item('👥 디렉터 관리', () => openAdmin(api));
      if (api.isOwner() && !/\/(settings|insight)(\.html)?$/.test(location.pathname)) item('⚙️ 설정 (AI 지침·사례·지식베이스)', () => { location.href = '/settings.html'; });
      if (!/\/playbook(\.html)?$/.test(location.pathname)) item('📒 플레이북', () => { location.href = '/playbook.html'; });
      item('🚪 로그아웃', () => { if (confirm('로그아웃할까요?')) api.signOut(); }, 'danger');
      document.body.appendChild(menu);
      const r = b.getBoundingClientRect();
      menu.style.top = (window.scrollY + r.bottom + 8) + 'px';
      menu.style.right = Math.max(8, document.documentElement.clientWidth - r.right - window.scrollX) + 'px';
      const onDoc = (ev) => { if (menu && !menu.contains(ev.target)) { closeMenu(); document.removeEventListener('click', onDoc); } };
      setTimeout(() => document.addEventListener('click', onDoc), 0);
      document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') { closeMenu(); document.removeEventListener('keydown', esc); } });
    };
    host.appendChild(b);
  }

  // ─── 인증 상태 ─────────────────────────────────────────────────────────────
  // 저장된 로그인이 있으면 onAuthStateChanged 가 곧바로 user 를 준다. 그때까지는
  // 로그인 버튼이 아니라 '확인 중' 만 보여준다 (페이지 이동마다 재로그인처럼 보이던 문제).
  gateChecking();

  A.onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.PMFire = null;
      PMFire = null;
      gateLogin('');
      wireLogin();
      return;
    }

    gateChecking('디렉터 확인 중…');
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
