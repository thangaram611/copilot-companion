// heartbeat.mjs
// Pure selector for the daemon's host-liveness heartbeat scan. Extracted so
// the TTL boundary, freshest-of-many selection, and stale-cleanup predicate
// can be unit-tested without touching the filesystem. The daemon owns I/O
// (readdir/stat/unlink); this helper owns classification.
//
// See scripts/copilot-acp-daemon.mjs (_findLiveHeartbeat) for the wiring, and
// hooks/drain-completions.sh for the writer side.

// Classify a snapshot of heartbeat files into:
//   - liveSid:        the freshest sid still inside liveTtlMs, or null
//   - staleToUnlink:  filenames older than staleAfterMs, safe to remove
//
// `entries` is an array of { name, mtimeMs } objects. `name` should be the
// basename like "<sid>.heartbeat" (sids without that suffix are ignored, so
// stray files in the heartbeat dir don't confuse the scan). `nowMs`,
// `liveTtlMs`, and `staleAfterMs` are explicit so tests can pin time.
//
// Invariant: liveTtlMs < staleAfterMs. The caller's defaults (30 min / 24h)
// satisfy this; a misconfigured call where they cross would mean "stale"
// entries could still be considered live. We don't enforce — keep the helper
// pure and let the daemon's constants be the source of truth.
export function selectLiveHeartbeat({ entries, nowMs, liveTtlMs, staleAfterMs }) {
  let liveSid = null;
  let liveMtime = -Infinity;
  const staleToUnlink = [];
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string') continue;
    if (!entry.name.endsWith('.heartbeat')) continue;
    const mtimeMs = entry.mtimeMs;
    if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) continue;
    const age = nowMs - mtimeMs;
    if (age > staleAfterMs) {
      staleToUnlink.push(entry.name);
      continue;
    }
    if (age <= liveTtlMs && mtimeMs > liveMtime) {
      liveMtime = mtimeMs;
      liveSid = entry.name.replace(/\.heartbeat$/, '');
    }
  }
  return { liveSid, staleToUnlink };
}
