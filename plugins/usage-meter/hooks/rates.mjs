// Public API list prices, shared by scan.mjs (run by node) and register.tsx.

// Sonnet 5.5 cache reads dropped from $0.20 to $0.10 on 2026-10-07.
const SONNET_55_CUT = Date.UTC(2026, 9, 7)

// $ per million tokens; mirrors ClaudeMeter's Pricing.rate(for:). `prompt` is the request's
// input + cache tokens (Haiku 5.5 has a higher rate card above 100k); `t` is when it ran.
export const rate = (model, prompt, t) => {
  const m = model.toLowerCase()
  // Mythos Preview (Project Glasswing) has its own rate; Mythos 5/5.1 share Fable's
  // rate cards, including 5.1's cache-read discount.
  if (m.includes('mythos-preview')) return { i: 25, o: 125, r: 0.1, known: true }
  if (m.includes('fable') || m.includes('mythos')) return { i: 10, o: 50, r: m.includes('5-1') ? 0.025 : 0.1, known: true }
  if (m.includes('opus')) {
    if (['opus-4-0', 'opus-4-1', 'opus-4-2025', '3-opus'].some(s => m.includes(s))) return { i: 15, o: 75, r: 0.1, known: true }
    return m.includes('opus-5-5') ? { i: 4, o: 20, r: 0.05, known: true } : { i: 5, o: 25, r: 0.1, known: true }
  }
  if (m.includes('sonnet-5-5')) return { i: 2, o: 10, r: t >= SONNET_55_CUT ? 0.05 : 0.1, known: true }
  if (m.includes('sonnet')) return m.includes('sonnet-5') ? { i: 2, o: 10, r: 0.1, known: true } : { i: 3, o: 15, r: 0.1, known: true }
  if (m.includes('haiku')) {
    if (m.includes('haiku-5')) return prompt > 100_000 ? { i: 0.5, o: 2.5, r: 0.1, known: true } : { i: 0.1, o: 0.5, r: 0.1, known: true }
    if (m.includes('haiku-4')) return { i: 1, o: 5, r: 0.1, known: true }
    if (m.includes('3-5-haiku')) return { i: 0.8, o: 4, r: 0.1, known: true }
    return { i: 0.25, o: 1.25, r: 0.1, known: true }
  }
  return { i: 3, o: 15, r: 0.1, known: false }
}
