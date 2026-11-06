// Simple request log (memory + data/requests.json). This is the ONLY source for dashboard counts.
import fs from 'node:fs';
const FILE = new URL('../data/requests.json', import.meta.url);
const map = new Map();
try { for (const r of JSON.parse(fs.readFileSync(FILE, 'utf8'))) map.set(r.id, r); } catch { /* first run */ }
const persist = () => { try { fs.writeFileSync(FILE, JSON.stringify([...map.values()], null, 1)); } catch { /* read-only disk */ } };
export const put = (r) => { map.set(r.id, r); persist(); return r; };
export const get = (id) => map.get(id);
export const list = () => [...map.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
export function stats() {
  const all = list(), by = (c) => all.filter((r) => r.category === c).length;
  return { total: all.length, leave: by('LEAVE'), expense: by('EXPENSE'), it: by('IT_SUPPORT'), other: by('OTHER'),
    humanReview: all.filter((r) => r.needsHuman).length, saveFailed: all.filter((r) => !r.save.ok).length };
}
