export default function handler(req, res) {
  res.status(200).json({ ok: true, configured: Boolean(process.env.UPSTOX_ACCESS_TOKEN) });
}
