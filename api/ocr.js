import { claudeHeaders, claudeBody, pickText } from './_claude.js';
// api/ocr.js — Image OCR (Claude Vision API)
// Receives base64 image from client, extracts text and returns it

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
  if (!CLAUDE_API_KEY) return res.status(500).json({ error: 'CLAUDE_API_KEY not configured' });

  try {
    const { image, mediaType } = req.body;
    if (!image) return res.status(400).json({ error: 'No image data provided.' });

    const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    const mType = mediaType || 'image/png';
    if (!validTypes.includes(mType)) {
      return res.status(400).json({ error: 'Unsupported image format. (JPG, PNG, WebP, GIF only)' });
    }

    // Claude Vision API call
    // 이미지 + 지시문을 user 턴 하나로. 추출 작업이라 effort 는 low.
    const content = [
      { type: 'image', source: { type: 'base64', media_type: mType, data: image } },
      { type: 'text', text: `Extract all text from this image.

Rules:
1. Extract every text visible in the image without omission.
2. If there are tables/forms, maintain structure as ItemName: Content format.
3. Recognize handwriting as best as possible.
4. Preserve original line breaks and separations naturally.
5. Return only the extracted text. Do not add explanations.
6. If the image is a worksheet/mission submission, clearly separate each item (channel name, target, concept, etc.).` },
    ];
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: claudeHeaders(CLAUDE_API_KEY),
      body: claudeBody(null, content, { maxTokens: 4000, effort: 'low' }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Claude Vision API error:', response.status, errText);
      return res.status(500).json({ error: 'Claude Vision API call failed: ' + response.status });
    }

    const data = await response.json();
    // 사고가 켜져 있으면 content[0] 이 thinking 블록일 수 있다 — 텍스트 블록만 모은다.
    const extractedText = pickText(data);
    if (!extractedText && !(data.content && data.content.length)) {
      console.error('Unexpected Claude response:', JSON.stringify(data).substring(0, 200));
      return res.status(500).json({ error: 'Claude Vision API response format is invalid.' });
    }

    return res.status(200).json({
      text: extractedText,
      usage: data.usage || {},
    });

  } catch (e) {
    console.error('OCR handler error:', e);
    return res.status(500).json({ error: 'Error during text extraction: ' + e.message });
  }
}
