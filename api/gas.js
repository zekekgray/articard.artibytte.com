/* === START: GAS PROXY === */
export default async function handler(req, res) {
  const GAS = process.env.GAS_URL;
  if (!GAS) return res.status(500).json({ success: false, error: 'GAS_URL not set' });
  try {
    let r;
    if (req.method === 'GET') {
      const qs = new URLSearchParams(req.query).toString();
      r = await fetch(GAS + '?' + qs, { redirect: 'follow' });
    } else if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
      r = await fetch(GAS, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body,
        redirect: 'follow'
      });
    } else {
      return res.status(405).json({ success: false, error: 'Method not allowed' });
    }
    const text = await r.text();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(text);
  } catch (e) {
    return res.status(502).json({ success: false, error: 'Backend unreachable' });
  }
}
/* === END: GAS PROXY === */
