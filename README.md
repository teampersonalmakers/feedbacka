# Personalmakers AI 코치

커밍쏜 수강생 미션 피드백 / 콘텐츠 기획 AI. Vercel 서버리스 + 정적 프론트엔드.

```
api/          Vercel 서버리스 함수
  _firestore.js  서버사이드 Firestore 데이터 레이어 (Admin SDK)
  _auth.js       Firebase ID 토큰 검증 (소유자 전용 API 보호)
  feedback.js    RAG 검색 + Claude 피드백 생성 (SSE 스트리밍)
  kb-clean.js    유튜브 자막 오타·문장부호 교정 (커밍쏜 전용)
  embed.js       Gemini 임베딩
  ocr.js         Claude Vision 워크시트 OCR
  rate.js        평가 기록
  history.js     대화 자동 기록
  playbook.js    👍 좋아요 → 플레이북 승인 후보 등록
public/       정적 페이지
  index.html     메인 챗 (chat.html 과 동일 내용)
  chat.html      챗 UI
  classic.html   미션 피드백 2단 레이아웃
  creator.html   콘텐츠 기획 생성기
  playbook.html  플레이북 — 디렉터가 Q&A 작성, 커밍쏜이 승인
  settings.html  설정 — AI 지침·디렉팅 사례 편집 (커밍쏜 전용)
  insight.html   설정 › 지식베이스 — 자막·녹취 원문 (커밍쏜 전용)
  firebase.js    인증 + Firestore + Storage 연동 레이어
scripts/
  migrate-notion-to-firestore.mjs   노션 → Firestore 데이터 이전
  directors.mjs                     디렉터 화이트리스트 관리
  build-chunks.mjs                  지식베이스 청크 → Firestore chunks (벡터 검색용)
  deploy-rules.mjs                  보안 규칙 배포 (서비스 계정)
knowledge/    이월 지식베이스 원본 (base.json ~ base9.json) — 인덱스 없을 때 폴백용
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

## 플레이북 — 팀 Q&A 자산 쌓기

`/playbook.html` (헤더의 `📒 플레이북`). 노션 "팀 퍼스널메이커스_플레이북" DB 를
앱 안으로 옮겨온 화면입니다.

```
디렉터가 질문·답변 작성  →  상태: 답변작성
        ↓
커밍쏜이 검수 / 답변 조정  →  ✅ 승인
        ↓
api/feedback.js 가 시스템 프롬프트에 주입  →  AI 피드백 정확도 상승
```

승인된 Q&A 만 AI 가 참고합니다. 반영까지 최대 5분(캐시 TTL).

### 승인 권한이 곧 AI 제어권

승인된 답변은 **시스템 프롬프트에 그대로 들어갑니다.** 그래서 승인은 `admin`
전용이고, 보안 규칙에서 강제합니다 — UI 를 우회해도 뚫리지 않습니다.

| | 일반 디렉터 | 커밍쏜 (admin) |
|---|---|---|
| 목록 읽기 | ✅ | ✅ |
| 초안 작성·수정 | ✅ | ✅ |
| 승인 상태로 생성 | ❌ | ✅ |
| 초안 → 승인 전환 | ❌ | ✅ |
| **승인된 항목 수정** | ❌ | ✅ |
| 삭제 | ❌ | ✅ |

`npm run test:rules` 가 이 표를 그대로 검증합니다(39 케이스).

### 필드

노션 스키마를 그대로 맞췄습니다. 마이그레이션 시 같은 문서로 병합됩니다.

| 필드 | 값 |
|---|---|
| `question` | 질문 (제목) |
| `originalQuestion` | 수강생이 실제로 한 표현 (보존용) |
| `answer` | 답변 본문 — 승인 시 프롬프트에 들어가는 내용 |
| `status` | 대기 · 답변작성 · 승인 · 보류 · 자동기록 |
| `category` | 유튜브 브랜딩(로드맵) · 채널운영(콘텐츠관점) · 광고&협업(외부 상품) · 수익화(본인 상품) · 팀퍼메스운영 |
| `director` / `student` | 작성 디렉터 / 수강생 |
| `approvedBy` / `approvedAtMs` | 승인자와 시각 |

---

## 설정 — AI 지침·디렉팅 사례 (커밍쏜 전용)

`/settings.html` (헤더의 `⚙️ 설정`). 세 탭이 있습니다.

| 탭 | 내용 | 저장 위치 | AI 반영 |
|---|---|---|---|
| 🧭 AI 지침 | 페르소나·핵심 철학·말투·**피드백 순서**·추가 지침·절대 하지 말 것·카테고리별 지침 | `guidelines` | 저장 후 1분 안 |
| 📁 디렉팅 사례 | 컨설팅·코칭에서 나온 판단 기준. **AI 반영** 토글 | `cases` | 저장 후 1분 안 |
| 📚 지식베이스 | 유튜브 자막·녹취 원문 (아래 절) | `kbSources` → `chunks` | 저장 즉시 |

AI 지침 탭의 내용이 그대로 시스템 프롬프트의 고정 블록이 됩니다. 페이지 아래
**프롬프트 미리보기**가 서버와 같은 순서로 조립해 보여줍니다.
`피드백 순서`(section `format`)는 이번에 추가된 항목으로, 비워두면 프롬프트에 들어가지 않습니다.
두 컬렉션은 `firestore.rules` 에서 소유자 계정만 읽고 씁니다(admin 디렉터도 차단).

## 설정 › 지식베이스 — 자막·녹취 원문

`/insight.html` (설정 › 📚 지식베이스). AI 가 참고하는 모든 소스의 원문을
모아 보는 화면입니다. **커밍쏜 계정만** 들어갑니다 — `admin` 역할을 가진 디렉터도
차단됩니다. `firestore.rules` 의 `isOwnerOnly()` 가 강제합니다.

### 유튜브 자막 넣는 법

유튜브는 **데이터센터 IP 를 차단**합니다. 서버(Vercel 서버리스)에서 자막을 긁으면
`LOGIN_REQUIRED` 로 막히고, 이 저장소의 어떤 코드도 자막을 자동으로 받아올 수
없습니다. 대신 **브라우저에서는 잘 됩니다.**

```
유튜브 영상 → 설명 아래 [스크립트 표시] → 패널 전체 복사
        ↓
설정 › 지식베이스 → [＋ 자막 추가] → 붙여넣기   (타임스탬프 자동 제거)
        ↓
[✨ 오타 교정]  → Claude 가 문장부호·고유명사 정리
        ↓
[저장]  → Firestore kbSources
```

`0:00 지금 저는…` 같은 타임스탬프는 붙여넣는 즉시 걷어냅니다.

교정은 `api/kb-clean.js` 가 처리합니다. 긴 자막은 문장 경계로 나눠 순차 처리하며,
요약하지 않고 모든 발화를 보존합니다.

### 저장하면 AI 검색에 바로 반영됩니다

[저장] 직후 `api/kb-embed.js` 가 자막을 약 1,500자 단위 청크로 잘라 Gemini 로
임베딩하고 Firestore `chunks` 컬렉션에 씁니다. 다음 질문부터 검색에 잡힙니다.
상세 화면의 **[AI 반영]** 버튼으로 언제든 다시 만들 수 있고, 소스를 지우면
청크도 같이 지웁니다.

### 지식베이스 검색 구조 (Firestore 벡터 검색)

AI 가 검색하는 곳은 `chunks` 컬렉션 하나입니다.

| origin      | 출처                                    | 건수   |
|-------------|-----------------------------------------|--------|
| `knowledge` | `knowledge/base*.json` (이월 자산, 282문서) | 2,344 |
| `kbSources` | 내부 인사이트에서 새로 넣은 자막            | 저장할 때마다 |

- 예전엔 요청마다 80MB JSON 을 파싱해 콜드스타트가 6.8초였습니다. 이제 `findNearest`
  로 상위 6건만 가져옵니다.
- 벡터는 **1536차원**입니다. Firestore 인덱스 상한(2048)에 맞춰 Gemini 3072차원의
  앞 1536을 잘라 정규화합니다. 기존 벡터 대비 상위 6건 일치율 98% (`npm run chunks:check`).
- 이월 자산 업로드: `npm run chunks` (재임베딩 없음, 여러 번 실행해도 안전)
- **벡터 인덱스는 한 번 직접 만들어야 합니다.** 콘솔 UI 로는 만들 수 없고,
  firebase-adminsdk 서비스 계정에는 인덱스 생성 권한이 없습니다.

```
gcloud firestore indexes composite create --project=personalmakers-ai \
  --collection-group=chunks --query-scope=COLLECTION \
  --field-config=vector-config='{"dimension":"1536","flat":"{}"}',field-path=embedding
```

  인덱스가 없는 동안에는 `FAILED_PRECONDITION` 이 나고 `api/feedback.js` 가 자동으로
  파일 검색(예전 방식)으로 폴백합니다. `GET /api/feedback` 의 `source.chunks` 가
  `firestore` 면 벡터 검색이 살아 있는 것입니다.

---

## 접근 통제: 구글 로그인 + 디렉터 화이트리스트

비밀번호 게이트(`0630` / `0730`)는 **제거**했습니다. 소스만 보면 뚫리는 구조였습니다.

이제 **모든 페이지**(`index` / `chat` / `classic` / `creator` / `playbook` / `settings` / `insight`)가
구글 로그인을 거치고, `directors/{이메일}` 문서가 있는 계정만 통과합니다.
화이트리스트는 보안 규칙에서 클라이언트 쓰기가 **전면 차단**돼 있어 아무나
가입할 수 없습니다.

로그인 후 닉네임이 없으면 설정 화면이 먼저 뜹니다. 닉네임은 헤더의 `👤` 배지를
눌러 언제든 바꿀 수 있고, 피드백 기록에 작성자로 남습니다.

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
