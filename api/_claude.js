// ─────────────────────────────────────────────────────────────────────────────
// api/_claude.js — Claude 호출 공통
//
// 모델·헤더·요청 본문 형태를 한곳에서 관리한다. 세 군데(feedback/ocr/kb-clean)가
// 각자 다른 모양으로 호출하던 것을 통일했다.
//
// - 모델: claude-opus-5. 사고(thinking)가 기본으로 켜져 있어 "왜 이 방향인가"를
//   파고드는 코칭 피드백에 맞다. effort 로 깊이를 조절한다.
// - 프롬프트 캐싱: system 을 [고정 블록(cache_control)] + [가변 블록] 배열로 넘긴다.
//   고정 블록(지침·플레이북)은 요청마다 같아서 두 번째 요청부터 10% 가격.
// - fallbacks "default": 안전 분류기가 요청을 거절하면 서버가 대체 모델로 같은
//   요청을 다시 돌린다. 코칭 피드백에서 거절이 날 일은 드물지만 안전망으로 둔다.
// ─────────────────────────────────────────────────────────────────────────────

export const CLAUDE_MODEL = 'claude-opus-5';

export function claudeHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'server-side-fallback-2026-07-01',
  };
}

// system: 문자열 또는 [{ type:'text', text, cache_control? }] 블록 배열
// user  : 문자열 또는 콘텐츠 블록 배열(이미지 등)
export function claudeBody(system, user, opts = {}) {
  const { stream = false, maxTokens = 12000, effort = 'medium', model = CLAUDE_MODEL } = opts;
  return JSON.stringify({
    model,
    max_tokens: maxTokens,
    stream,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: user }],
    thinking: { type: 'adaptive' },
    output_config: { effort },
    fallbacks: 'default',
  });
}

// 고정 블록에 캐시 마커. TTL 1시간 — 디렉터 사용이 하루 중 띄엄띄엄이라
// 5분짜리는 세션 사이에 자주 만료된다. 쓰기 비용 차이는 요청당 1센트 미만.
export function cachedBlock(text) {
  return { type: 'text', text, cache_control: { type: 'ephemeral', ttl: '1h' } };
}

// 사고가 켜져 있으면 content[0] 이 thinking 블록일 수 있다. 텍스트 블록을 찾는다.
export function pickText(data) {
  if (data && data.stop_reason === 'refusal' && data.stop_details) {
    throw new Error('Claude 가 요청을 거절했습니다: ' + (data.stop_details.explanation || data.stop_details.category || 'refusal'));
  }
  const blocks = (data && data.content) || [];
  return blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('');
}
