// ──────────────────────────────────────────────
// Context Budget split — pure presentation helper
// ──────────────────────────────────────────────
// Maps a session's cumulative usage object into three semantic buckets:
//
//   memory   = what the model has to keep "in mind" about this conversation
//              (net new input + short-lived ephemeral cache + cache reads)
//   skills   = stable long-lived material reused across turns
//              (long-lived ephemeral cache: system prompt, tool specs, skill bodies)
//   reasoning = what the model produced (output tokens)
//
// The split leans on Anthropic's own cache TTL semantics, which are
// surfaced in message.usage.cache_creation.{ephemeral_1h,ephemeral_5m}.
// If those fields are absent (legacy sessions persisted before this
// feature, or hook-handlers on old machines), we fall back to a "legacy
// mode" that still produces a coherent total but assigns nothing to
// the skills bucket — the dashboard renders this in grayscale with a
// CTA subtitle so the user knows it's expected historical behavior.
//
// Pure function. No I/O, no module state, safe to call any number of
// times per session.
// ──────────────────────────────────────────────

function nonNeg(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function computeBudget(usage) {
  if (!usage || typeof usage !== "object") {
    return { memory: 0, skills: 0, reasoning: 0, total: 0, cacheRead: 0, hasBreakdown: false };
  }

  const cacheRead = nonNeg(usage.cache_read_input_tokens);
  const breakdown = usage._breakdown && typeof usage._breakdown === "object" ? usage._breakdown : null;

  let skills, memory;
  if (breakdown) {
    // Modern path: trust Anthropic's own TTL split.
    const ephemeral1h = nonNeg(breakdown.ephemeral_1h);
    const ephemeral5m = nonNeg(breakdown.ephemeral_5m);
    skills = ephemeral1h;
    memory = nonNeg(usage.input_tokens) + ephemeral5m + cacheRead;
  } else {
    // Legacy path: no TTL breakdown available. Lump all cache_creation
    // into memory rather than guessing — keeps skills honestly empty
    // and the dashboard surfaces the legacy state explicitly.
    skills = 0;
    memory =
      nonNeg(usage.input_tokens) +
      nonNeg(usage.cache_creation_input_tokens) +
      cacheRead;
  }

  const reasoning = nonNeg(usage.output_tokens);
  const total = memory + skills + reasoning;

  return {
    memory,
    skills,
    reasoning,
    total,
    cacheRead,
    hasBreakdown: !!breakdown,
  };
}

// Convenience: ratios for the stacked bar. Returns 0 for every bucket
// when total is 0 (rather than NaN from division by zero) so the UI
// doesn't have to special-case empty sessions.
function computeRatios(budget) {
  if (!budget || !budget.total) return { memory: 0, skills: 0, reasoning: 0 };
  return {
    memory: budget.memory / budget.total,
    skills: budget.skills / budget.total,
    reasoning: budget.reasoning / budget.total,
  };
}

module.exports = {
  computeBudget,
  computeRatios,
};
