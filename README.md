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
  member.html    수강생/멤버십 회원용 경량 페이지
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

이제 `index` / `chat` / `classic` / `creator` 는 구글 로그인을 거치고,
`directors/{이메일}` 문서가 있는 계정만 통과합니다. 화이트리스트는 보안 규칙에서
클라이언트 쓰기가 **전면 차단**돼 있어 아무나 가입할 수 없습니다.

로그인 후 닉네임이 없으면 설정 화면이 먼저 뜹니다. 닉네임은 헤더의 `👤` 배지를
눌러 언제든 바꿀 수 있고, 피드백 기록에 작성자로 남습니다.

> `member.html` 은 수강생·멤버십 회원용이라 기존 비밀번호 게이트를 유지했습니다.
> 여기도 디렉터 전용으로 잠그려면 알려주세요.

### 디렉터 등록

```bash
export FIREBASE_SERVICE_ACCOUNT="$(cat serviceAccountKey.json)"

node scripts/directors.mjs add comingssoni@gmail.com --name 커밍쏜 --role admin
node scripts/directors.mjs add heidi@example.com     --name 헤이디
node scripts/directors.mjs list
node scripts/directors.mjs disable heidi@example.com   # 접근만 차단, 기록은 보존
```

---

## Firebase 콘솔 설정 (프로젝트: `personalmakers-ai`)

1. **Authentication → Sign-in method → Google 사용 설정**
2. **Authentication → Settings → 승인된 도메인**에 배포 도메인 추가
   (`localhost` 와 Vercel 도메인). 빠지면 `auth/unauthorized-domain` 이 납니다.
3. **Firestore Database 만들기** (프로덕션 모드, 리전 `asia-northeast3` 권장)
4. **Storage 시작하기** (같은 리전)
5. **프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성** → `FIREBASE_SERVICE_ACCOUNT`

### 보안 규칙 배포

```bash
npm i -g firebase-tools
firebase login
firebase deploy --only firestore:rules,storage:rules
```

```
directors/{이메일}              본인 항목 읽기만. 쓰기는 Admin SDK 전용
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
