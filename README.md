# Personalmakers AI 코치

커밍쏜 수강생 미션 피드백 / 콘텐츠 기획 AI. Vercel 서버리스 + 정적 프론트엔드로 돌아갑니다.

```
api/          Vercel 서버리스 함수
  feedback.js   RAG 검색 + Claude 피드백 생성 (SSE 스트리밍)
  embed.js      Gemini 임베딩
  ocr.js        Claude Vision 워크시트 OCR
  rate.js       👍👎 평가 → Notion
  history.js    자동 대화 기록 → Notion
  playbook.js   "AI 학습시키기" → Notion 검수 대기
public/       정적 페이지
  index.html    메인 챗 (chat.html 과 동일 내용)
  chat.html     챗 UI
  classic.html  미션 피드백 2단 레이아웃
  creator.html  콘텐츠 기획 생성기
  member.html   수강생용 경량 페이지
  firebase.js   Firestore + Storage 연동 레이어
knowledge/    RAG 지식베이스 (base.json ~ base9.json, guidelines.json)
data/         영상 임베딩 / 자막
```

## 환경변수 (Vercel)

| 키 | 쓰는 곳 | 필수 |
|---|---|---|
| `CLAUDE_API_KEY` | feedback.js, ocr.js | ✅ |
| `GEMINI_API_KEY` | embed.js | ✅ |
| `NOTION_API_KEY` | rate.js, history.js, playbook.js | 선택 |
| `PLAYBOOK_DB_ID` | history.js, playbook.js | 선택 (기본값 내장) |
| `RATE_DB_ID` | rate.js | 선택 (기본값 내장) |

---

## Firebase 연동 (Firestore + Storage)

**무엇이 바뀌나**

| | 이전 | 지금 |
|---|---|---|
| 대화 기록 (`chat`/`index`) | 브라우저 localStorage 만 | Firestore — 기기 간 동기화 |
| 피드백 기록 (`classic`) | 브라우저 localStorage 만 | Firestore — 기기 간 동기화 |
| 워크시트 캡처본 | OCR 후 버려짐 | Cloud Storage 보관, 카드에서 원본 다시 열람 |

localStorage 는 **즉시 렌더용 캐시**로 그대로 남습니다. Firebase 가 없거나 실패해도
페이지는 예전과 똑같이 동작합니다 (`window.PMFire` 가 `null` 이 될 뿐).

### 콘솔에서 켜야 하는 것 (3개)

프로젝트: **`personalmakers-ai`**

1. **Authentication → Sign-in method → 익명(Anonymous) 사용 설정**
   화면에 로그인 UI 가 생기지는 않습니다. 보안 규칙에서 쓸 `uid` 를 발급받기
   위한 것으로, 이게 꺼져 있으면 Firestore/Storage 저장이 전부 실패합니다.
2. **Firestore Database 만들기** (프로덕션 모드, 리전은 `asia-northeast3` 권장)
3. **Storage 시작하기** (같은 리전)

### 보안 규칙 배포

```bash
npm i -g firebase-tools
firebase login
firebase deploy --only firestore:rules,storage:rules
```

규칙 요약 — 자기 `uid` 폴더 밖은 **읽기·쓰기 전부 차단**입니다.

```
users/{uid}                     본인만
users/{uid}/convs/{convId}      대화 메타 (제목, 수강생, 시각)
users/{uid}/convs/{id}/turns/*  대화 턴 (질문/답변) — 문서 1MiB 제한 회피용 서브컬렉션
users/{uid}/records/{recordId}  classic.html 피드백 기록
Storage: users/{uid}/uploads/** 이미지 10MB 이하만
```

### 웹 config

`public/firebase.js` 상단 `firebaseConfig` 에 들어 있습니다. 이 값들은 브라우저에
그대로 내려가는 **공개 식별자**라 저장소에 있어도 괜찮습니다. 실제 보호는
`firestore.rules` / `storage.rules` 가 합니다.

> ⚠️ 서비스 계정 JSON (`serviceAccountKey.json` 등)은 성격이 완전히 다릅니다.
> 절대 커밋하지 마세요 — `.gitignore` 에 이미 막아뒀습니다.

### 알아둘 점

- **익명 uid 는 브라우저마다 다릅니다.** 같은 사람이 노트북과 폰에서 접속하면
  서로 다른 uid → 기록이 공유되지 않습니다. 사람 단위로 묶으려면 이메일/구글
  로그인을 붙이고 `linkWithCredential` 로 익명 계정을 승격시켜야 합니다.
- 브라우저 데이터를 지우면 익명 uid 도 사라져 이전 기록에 접근할 수 없습니다.
- 현재 비밀번호 게이트(`0630`)는 HTML 에 하드코딩돼 있어 소스만 보면 뚫립니다.
  Firestore 규칙은 uid 로 데이터를 격리할 뿐, 페이지 접근 자체를 막지는 않습니다.
- `public/firebase.js` 는 Firebase JS SDK **12.18.0** 을 gstatic CDN 에서
  ESM 으로 불러옵니다. 버전은 파일 맨 위 `SDK` 상수 한 줄로 바꿀 수 있습니다.
