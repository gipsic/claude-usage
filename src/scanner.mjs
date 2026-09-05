import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { costOf, weightOf, normalizeModel } from './pricing.mjs';

/** Recursively list *.jsonl transcripts under a Claude config dir's projects/ folder. */
export function listTranscripts(configDir) {
  const root = path.join(configDir, 'projects');
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root);
  return out;
}

function projectName(rec, file) {
  if (rec.cwd) {
    const base = path.basename(rec.cwd);
    return base && base !== '/' ? base : rec.cwd;
  }
  // Fall back to the encoded directory name (-Users-me-Projects-foo -> foo).
  const dir = path.basename(path.dirname(file));
  const parts = dir.split('-').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : dir;
}

/** Parse one transcript line into an event row, or null if it carries no usage. */
function parseLine(line, file, account) {
  if (line.length < 40 || line.indexOf('"usage"') === -1) return null;
  let rec;
  try { rec = JSON.parse(line); } catch { return null; }
  if (rec.type !== 'assistant') return null;
  const msg = rec.message;
  const u = msg?.usage;
  if (!u) return null;
  const model = normalizeModel(msg.model);
  if (!model) return null; // skips <synthetic> local-only messages

  const key = `${rec.requestId || 'noreq'}|${msg.id || rec.uuid}`;
  const cc = u.cache_creation || {};
  const st = u.server_tool_use || {};
  const ev = {
    key,
    ts: Date.parse(rec.timestamp),
    account,
    model,
    project: projectName(rec, file),
    session_id: rec.sessionId || null,
    git_branch: rec.gitBranch || null,
    effort: rec.effort || null,
    speed: u.speed || null,
    service_tier: u.service_tier || null,
    inference_geo: u.inference_geo && u.inference_geo !== 'not_available' ? u.inference_geo : null,
    is_sidechain: rec.isSidechain ? 1 : 0,
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    thinking: u.output_tokens_details?.thinking_tokens || 0,
    cache_read: u.cache_read_input_tokens || 0,
    cache_creation: u.cache_creation_input_tokens || 0,
    cache_5m: cc.ephemeral_5m_input_tokens || 0,
    cache_1h: cc.ephemeral_1h_input_tokens || 0,
    web_search: st.web_search_requests || 0,
    web_fetch: st.web_fetch_requests || 0,
  };
  if (!Number.isFinite(ev.ts)) return null;
  ev.cost = costOf(ev);
  ev.weight = weightOf(ev);
  return ev;
}

const COLS = ['key','ts','account','model','project','session_id','git_branch','effort','speed','service_tier',
  'inference_geo','is_sidechain','input','output','thinking','cache_read','cache_creation','cache_5m','cache_1h',
  'web_search','web_fetch','cost','weight'];

/**
 * Scan every transcript for an account, inserting only new usage records.
 * Files are resumed from the byte offset reached last time; a file that shrank
 * or whose mtime moved backwards is re-read from the start.
 */
export function scan(db, { configDir, account = 'default', full = false, onProgress } = {}) {
  configDir = configDir || path.join(os.homedir(), '.claude');
  const files = listTranscripts(configDir);
  const getFile = db.prepare('SELECT size, mtime, offset FROM files WHERE path = ?');
  const putFile = db.prepare(
    'INSERT INTO files(path,size,mtime,offset,scanned) VALUES(?,?,?,?,?) ' +
    'ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime, offset=excluded.offset, scanned=excluded.scanned'
  );
  const ins = db.prepare(
    `INSERT INTO events(${COLS.join(',')}) VALUES(${COLS.map(() => '?').join(',')}) ON CONFLICT(key) DO NOTHING`
  );

  let inserted = 0, filesRead = 0, i = 0;
  db.exec('BEGIN');
  try {
    for (const file of files) {
      i++;
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const prev = full ? null : getFile.get(file);
      let start = 0;
      if (prev && st.size >= prev.size && Math.floor(st.mtimeMs) >= prev.mtime) {
        if (st.size === prev.size && Math.floor(st.mtimeMs) === prev.mtime) {
          continue; // untouched since last scan
        }
        start = prev.offset;
      }

      const fd = fs.openSync(file, 'r');
      let consumed = start;
      try {
        const CHUNK = 4 << 20;
        let carry = '';
        let pos = start;
        const buf = Buffer.allocUnsafe(CHUNK);
        while (pos < st.size) {
          const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, st.size - pos), pos);
          if (n <= 0) break;
          pos += n;
          const text = carry + buf.toString('utf8', 0, n);
          const lastNl = text.lastIndexOf('\n');
          if (lastNl === -1) { carry = text; continue; }
          carry = text.slice(lastNl + 1);
          for (const line of text.slice(0, lastNl).split('\n')) {
            const ev = parseLine(line, file, account);
            if (!ev) continue;
            const r = ins.run(...COLS.map((c) => ev[c]));
            inserted += r.changes;
          }
        }
        // An unterminated tail is usually a record still being written, so it is
        // held back for the next scan - unless it already parses as complete JSON,
        // in which case the writer simply never added the final newline.
        if (carry.trim()) {
          const ev = parseLine(carry, file, account);
          if (ev) {
            inserted += ins.run(...COLS.map((c) => ev[c])).changes;
            carry = '';
          } else {
            try { JSON.parse(carry); carry = ''; } catch { /* genuinely partial: keep it */ }
          }
        }
        consumed = st.size - Buffer.byteLength(carry, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      filesRead++;
      putFile.run(file, st.size, Math.floor(st.mtimeMs), consumed, Date.now());
      if (onProgress && i % 25 === 0) onProgress({ i, total: files.length, inserted });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { files: files.length, filesRead, inserted };
}
