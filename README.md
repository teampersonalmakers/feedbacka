# Personalmakers AI 코치

커밍쏜 수강생 미션 피드백 / 콘텐츠 기획 AI. Vercel 서버리스 + 정적 프론트엔드.

```
api/          Vercel 서버리스 함수
  _firestore.js  서버사이드 Firestore 데이터 레이어 (Admin SDK)
  feedback.js    RAG 검색 + Claude 피드백 생성 (SSE 스트리밍)
  embed.js       Gemini 임베딩
  ocr.js         Claude Vision 워크시트 OCR
  rate.js        평가 기록
  history.js     대화 자동 기록
  playbook.js    "AI 학습시키기" 검수 대기 등록
public/       정적 페이지
  index.html     메인 챗 (chat.html 과 동일 내용)
  chat.html      챗 UI
  classic.html   미션 피드백 2단 레이아웃
  creator.html   콘텐츠 기획 생성기
  member.html    경량 페이지 (디렉터 전용)
  firebase.js    인증 + Firestore + Storage 연동 레이어
scripts/
  migrate-notion-to-firestore.mjs   노션 → Firestore 데이터 이전
  directors.mjs                     디렉터 화이트리스트 관리
knowledge/    RAG 지식베이스 (base.json ~ base9.json, guidelines.json)
data/         영상 임베딩 / 자막
```

## 환경변수 (Vercel)

| 키 | 쓰는 곳 | 필수 |
|---|---|---|
| `CLAUDE_API_KEY` | feedback.js, ocr.js | ✅ |
| `GEMINI_API_KEY` | embed.js | ✅ |
| `FIREBASE_SERVICE_ACCOUNT` | api/_firestore.js — 서버에서 Firestore 읽기·쓰기 | ✅ |
| `NOTION_API_KEY` | 이전 경로 폴백 + 마이그레이션 | 이전 기간만 |
| `PLAYBOOK_DB_ID` / `RATE_DB_ID` / `NOTION_DB_ID` / `CASES_DB_ID` / `KB_DB_ID` | 마이그레이션 대상 노션 DB | 기본값 내장 |

`FIREBASE_SERVICE_ACCOUNT` 는 서비스 계정 JSON 원문 또는 base64 둘 다 받습니다.
Vercel UI 는 개행 처리가 까다로우니 base64 를 권장합니다.

```bash
base64 -w0 serviceAccountKey.json    # 리눅스
base64 -i  serviceAccountKey.json    # macOS
```

> ⚠️ 서비스 계정 JSON 은 절대 커밋하지 마세요. `.gitignore` 에 이미 막아뒀습니다.
> 웹 앱 config(`public/firebase.js` 상단)는 성격이 다릅니다 — 브라우저에 그대로
> 내려가는 공개 식별자라 저장소에 있어도 됩니다.

---

## 데이터베이스: 노션 → Firebase

**이전에는** 노션이 실시간 DB 였습니다. `api/feedback.js` 가 매 요청마다 노션을
읽어 지침·플레이북·수강생 이력을 가져왔습니다(5분 캐시).

**지금은** Firestore 가 정본입니다. 노션은 폴백으로만 남아 있습니다.

| 노션 DB | Firestore 컬렉션 | 쓰임 |
|---|---|---|
| 피드백 가이드라인 | `guidelines` | 페르소나·철학·말투·카테고리별 지침 |
| 팀 퍼메스 Q&A 플레이북 | `playbook` | 승인된 Q&A + 수강생 상담 이력 |
| 디렉팅 사례 아카이브 | `cases` | 컨설팅 내용 (`AI반영` 켜진 것만 AI 에 반영) |
| 지식베이스 소스 관리 | `kbSources` | 자료 목록 (book/ebook/youtube/consulting/faq) |
| 답변 품질 로그 | `ratings` | 평가 기록 |
| (신규) | `history` | 대화 자동 기록 |

읽기 우선순위는 **Firestore → 노션 → `knowledge/guidelines.json`** 입니다.
서비스 계정을 안 넣어도 앱은 예전처럼 노션으로 굴러갑니다.

### 마이그레이션 실행

```bash
npm install
export NOTION_API_KEY='secret_...'
export FIREBASE_SERVICE_ACCOUNT="$(cat serviceAccountKey.json)"

npm run migrate:dry     # 읽기만 — 건수 확인
npm run migrate         # 실제 반영
```

문서 ID 로 노션 페이지 ID 를 그대로 씁니다. 여러 번 돌려도 덮어쓰기만 되고
중복이 생기지 않습니다. 일부만 다시 옮기려면:

```bash
node scripts/migrate-notion-to-firestore.mjs --only=guidelines,cases
```

### 이전 대비 달라진 점

- **디렉팅 사례가 처음으로 AI 에 연결됐습니다.** `AI반영` 체크된 34건이 있는데
  기존 코드에는 이 사례들을 읽는 경로가 아예 없었습니다. 이제 질문과 겹치는
  키워드로 상위 3건을 골라 시스템 프롬프트에 넣습니다 (커밍쏜 컴펌 건 우선).
- 노션 API 왕복(DB 쿼리 + 페이지별 블록 조회)이 사라져 응답이 빨라집니다.
- 노션의 초당 3요청 제한에 걸리지 않습니다.

---

## 접근 통제: 구글 로그인 + 디렉터 화이트리스트

비밀번호 게이트(`0630` / `0730`)는 **제거**했습니다. 소스만 보면 뚫리는 구조였습니다.

이제 **5개 페이지 전부**(`index` / `chat` / `classic` / `creator` / `member`)가
구글 로그인을 거치고, `directors/{이메일}` 문서가 있는 계정만 통과합니다.
화이트리스트는 보안 규칙에서 클라이언트 쓰기가 **전면 차단**돼 있어 아무나
가입할 수 없습니다.

로그인 후 닉네임이 없으면 설정 화면이 먼저 뜹니다. 닉네임은 헤더의 `👤` 배지를
눌러 언제든 바꿀 수 있고, 피드백 기록에 작성자로 남습니다.

> `member.html` 은 `/api/feedback` 에 `isPublic: true` 를 보냅니다. 이 플래그는
> "지금 대화하는 상대는 멤버십 회원입니다" 라는 지시를 프롬프트에 넣습니다.
> 디렉터 전용이 된 지금은 말투가 어긋날 수 있으니, 디렉터 톤으로 바꾸려면
> `public/member.html` 의 `isPublic: true` 를 빼면 됩니다.

### 소유자 부트스트랩

화이트리스트가 비어 있으면 아무도(소유자 포함) 로그인할 수 없습니다. 그래서
소유자 계정 하나를 **보안 규칙에 직접 박아** 두었습니다.

```
firestore.rules   isOwnerAccount()  → 'comingssoni@gmail.com'
storage.rules     isDirector()      → 같은 이메일
public/firebase.js OWNER_EMAILS     → 같은 이메일
```

이 계정은 `directors` 문서가 없어도 항상 통과하고 `admin` 권한을 갖습니다.
규칙에 있으므로 서버에서 강제되며 클라이언트 조작으로는 뚫리지 않습니다.
**바꾸려면 위 세 곳을 함께 수정해야 합니다.**

### 디렉터 등록

**방법 1 — 브라우저 (서비스 계정 키 불필요)**
admin 계정으로 로그인 → 헤더의 `👤` 배지 클릭 → `디렉터 관리` → 이메일·이름 입력.

**방법 2 — CLI**
```bash
export FIREBASE_SERVICE_ACCOUNT="$(cat serviceAccountKey.json)"

node scripts/directors.mjs add heidi@example.com --name 헤이디
node scripts/directors.mjs list
node scripts/directors.mjs disable heidi@example.com   # 접근만 차단, 기록은 보존
```

### 보안 규칙 테스트

규칙은 에뮬레이터로 검증합니다 (Java 필요, 테스트 도구는 그때만 내려받아 씁니다).

```bash
npm run test:rules
```

소유자 부트스트랩 / 화이트리스트 / 남의 데이터 격리 / 임의 가입 차단 /
팀 지식 컬렉션 차단 / 입력 검증까지 24개 케이스를 확인합니다.

---

## Firebase 콘솔 설정 (프로젝트: `personalmakers-ai`)

1. **Authentication → Sign-in method → Google 사용 설정**
2. **Authentication → Settings → 승인된 도메인**에 배포 도메인 추가
   (`localhost` 와 Vercel 도메인). 빠지면 `auth/unauthorized-domain` 이 납니다.
3. **Firestore Database 만들기** (프로덕션 모드, 리전 `asia-northeast3` 권장)
4. **Storage 시작하기** (같은 리전) — **선택**. 아래 "Storage 없이 쓰기" 참고
5. **프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성** → `FIREBASE_SERVICE_ACCOUNT`

### Storage 없이 쓰기

Storage 를 활성화하지 않아도 앱은 정상 동작합니다.

- **OCR 은 그대로 작동합니다.** 이미지를 base64 로 `/api/ocr` 에 직접 보내므로
  Storage 와 무관합니다.
- 워크시트 **원본 보관 / 다시보기 링크**만 생기지 않습니다.
- 업로드 실패는 `public/chat.html`, `public/classic.html` 양쪽에서 `.catch` 로
  무시하고 진행합니다. 콘솔에 경고만 남습니다.

나중에 Storage 를 켜면 코드 수정 없이 바로 동작합니다 — `storage.rules` 만
추가로 배포하면 됩니다.

### 서비스 계정 키가 없으면

`FIREBASE_SERVICE_ACCOUNT` 없이도 로그인과 개인 기록(대화·피드백)은 브라우저
SDK 로 동작합니다. 다만 **서버가 Firestore 에 접근하지 못해** 아래가 노션 폴백으로
남습니다 — 즉 "노션 → Firebase DB 전환"이 일어나지 않습니다.

| | 키 없음 | 키 있음 |
|---|---|---|
| 구글 로그인 / 디렉터 관리 | ✅ | ✅ |
| 대화·피드백 기록 저장 | ✅ | ✅ |
| 지침·플레이북 읽기 | 노션 | Firestore |
| 평가·자동기록 쓰기 | 노션 | Firestore |
| 디렉팅 사례(컨설팅) AI 연결 | ❌ | ✅ |
| 노션 데이터 이전 | 실행 불가 | ✅ |

### 보안 규칙 배포

서비스 계정만 있으면 됩니다. `firebase login` 이 필요 없습니다.

```bash
export FIREBASE_SERVICE_ACCOUNT="$(cat serviceAccountKey.json)"

npm run deploy:rules                        # firestore 규칙
node scripts/deploy-rules.mjs --storage     # storage 규칙까지 (Storage 켠 경우)
node scripts/deploy-rules.mjs --check       # 배포 없이 차이만 확인
```

내용이 같으면 건너뛰고, 배포 후에는 되읽어서 실제 반영을 확인합니다.

> **왜 `firebase deploy` 를 안 쓰나**: firebase-tools 는 배포 전에
> `serviceusage.googleapis.com` 으로 API 활성화 여부를 확인하는데, 콘솔에서 받는
> `firebase-adminsdk` 서비스 계정에는 그 권한이 없어 403 으로 막힙니다.
> 위 스크립트는 Rules API 를 직접 호출해 그 사전 점검을 건너뜁니다.
> `firebase login` 을 한 사람은 `firebase deploy --only firestore:rules` 를 써도 됩니다
> (`--only` 를 빼면 `firebase.json` 의 storage 블록 때문에 실패합니다).

```
directors/{이메일}              본인 항목 읽기. 목록 조회·추가·삭제는 admin 만
users/{uid}                     디렉터 본인만
users/{uid}/convs/{id}/turns/*  대화 (문서 1MiB 제한 회피용 서브컬렉션)
users/{uid}/records/{id}        피드백 기록
guidelines · playbook · cases · kbSources · ratings · history
                                클라이언트 전면 차단 (서버 Admin SDK 만 접근)
Storage users/{uid}/uploads/**  디렉터 본인, 이미지 10MB 이하
```

Storage 규칙은 Firestore 의 화이트리스트를 교차 확인합니다(`firestore.exists`).
**규칙 배포 후 이미지 업로드가 되는지 한 번 확인해주세요** — 이 교차 확인이
프로젝트 설정에 따라 막히면 업로드가 실패할 수 있습니다.

### 알아둘 점

- 구글 로그인이라 uid 가 사람 단위로 고정됩니다. 노트북·폰에서 같은 계정으로
  로그인하면 대화와 기록이 그대로 이어집니다.
- localStorage 는 즉시 렌더용 캐시로 남아 있습니다. Firestore 가 정본이고,
  로컬에만 있던 기록은 로그인 후 자동으로 올라갑니다.
- `public/firebase.js` 는 Firebase JS SDK **12.18.0** 을 gstatic CDN 에서 ESM 으로
  불러옵니다. 버전은 파일 맨 위 `SDK` 상수 한 줄로 바꿉니다.
