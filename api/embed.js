export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { texts, taskType = 'RETRIEVAL_DOCUMENT' } = req.body;
  if (!texts || !Array.isArray(texts)) return res.status(400).json({ error: 'texts array required' });

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  try {
    const embeddings = [];
    for (const text of texts) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'models/gemini-embedding-001',
            content: { parts: [{ text }] },
            taskType,
          }),
        }
      );
      const data = await response.json();
      if (data.error) throw new Error('Gemini: ' + data.error.message);
      embeddings.push(data.embedding.values);
    }
    return res.status(200).json({ embeddings });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
