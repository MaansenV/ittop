// Admission policy v1: every durable-memory candidate passes one gate before
// it may enter the review queue — no path (MCP, UI, capture, import,
// promotion) bypasses it. The service NEVER writes to the vault itself; it
// produces verdicts + approved operations for later phases to execute.
//
// Two separated stages (never mixed):
//  1. STRUCTURAL eligibility (hard reject): missing fields, secrets, generic
//     triggers, trigger count outside 1..3, implemented shape violations,
//     global scope outside confirmed user preferences, empty/unknown category
//     handling. A structural failure can never become approve/review.
//  2. ROUTING score (approve/review/discard): deterministic rule-based
//     starting values, NOT probabilities: >= AUTO (0.95) → auto-candidate,
//     >= REVIEW (0.70) → human review, below → discard. Missing evidence or
//     conflicts force review regardless of score.
export const ADMISSION_POLICY_VERSION = 1
export const ADMISSION_AUTO_THRESHOLD = 0.95
export const ADMISSION_REVIEW_THRESHOLD = 0.7

export type AdmissionDecision = 'approve' | 'review' | 'reject'

/** Categories the policy knows. Unknown non-empty categories cap at review. */
export const KNOWN_CATEGORIES = ['decision', 'gotcha', 'procedure', 'implemented', 'preference'] as const

export interface AdmissionEvidence {
  /** Where this came from: hook payload, transcript span, user statement… */
  sourceRef: string
  /** Test/commit proof for implemented entries (commit proves neither test nor deploy). */
  testProof?: string
  commit?: string
  files?: string[]
  /** Explicit user confirmation (required for global scope). */
  confirmedByUser?: boolean
}

export interface AdmissionCandidate {
  db: string
  category: string
  key: string
  /** Atomic content. implemented: max 3 lines + separate metadata. */
  content: string
  /** Future benefit: why will this matter later? Mandatory. */
  futureUse: string
  evidence: AdmissionEvidence
  /** 1-3 specific recall_when situations. Generic triggers are rejected. */
  triggers: string[]
  status?: string
  implementedMeta?: ImplementedMeta
}

export interface AdmissionVerdict {
  decision: AdmissionDecision
  score: number
  reasons: string[]
  /** Present when secrets were found: redacted content to store instead. */
  redactedContent?: string
  /**
   * Hard blocks an approval override: missing user confirmation for global
   * scope or missing test proof for done implementations cannot be healed
   * by human override — only by resubmitting with the evidence.
   */
  nonOverridable?: string[]
}

export interface ConflictLookup {
  /** Existing live entries with the same (category, key) or same key. */
  findSameKey(db: string, category: string, key: string): Array<{ status: string; content: string }>
}

const GENERIC_TRIGGERS = [
  'beim programmieren',
  'when programming',
  'when coding',
  'beim coden',
  'immer',
  'always',
  'generell',
  'in general',
]

const NEGATION_PATTERNS = [
  /\bnot\s+(yet|fixed|done|implemented|resolved|working|tested|verified)\b/i,
  /\bkeine?\s+(Lösung|Fix|Behebung|Implementierung)\b/i,
  /\bnicht\s+(behoben|fertig|implementiert|getestet|gelöst|funktionsfähig)\b/i,
  /\boffen\b/i,
  /\b(todo|tbd|fixme)\b/i,
]

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Specific providers first: generic token patterns would eat their spans,
  // and redacted markers must never match again (values start alphanumeric).
  { name: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: 'aws-key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'private-key-partial', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----((?:\r?\n[^\r\n]*){0,200})/g },
  { name: 'bearer', re: /[Bb]earer\s+[A-Za-z0-9\-._~+/]+=*/gm },
  { name: 'password', re: /(password|passwd|pwd)["']?\s*[:=]\s*["']?\S+/gi },
  { name: 'api-token', re: /(api[_-]?key|token|secret)["']?\s*[:=]\s*['"]?[A-Za-z0-9]\S*/gi },
]

// Remainder check, applied ONLY after complete blocks were stripped:
// any header left is truncated by construction. Beyond 200 following lines
// the whole field goes, since trailing key material cannot be delimited.
const TRUNCATED_KEY_OVERFLOW = /-----BEGIN [A-Z ]*PRIVATE KEY-----((?:\r?\n[^\r\n]*){201,})/;

/** Every persisted field, joined — scanning content alone leaves leaks:
 * evidence testProof/commit, implementedMeta, db/category/status included. */
export function candidateText(candidate: AdmissionCandidate): string {
  return [
    candidate.content,
    candidate.futureUse,
    candidate.key,
    candidate.db,
    candidate.category,
    candidate.status ?? '',
    candidate.evidence?.sourceRef ?? '',
    candidate.evidence?.testProof ?? '',
    candidate.evidence?.commit ?? '',
    (candidate.triggers ?? []).join('\n'),
    (candidate.evidence?.files ?? []).join('\n'),
    JSON.stringify(candidate.implementedMeta ?? null),
  ].join('\n')
}

// Complete blocks stripped first (fresh literal: no shared lastIndex).
// Every header surviving this step is truncated by construction.
function stripCompleteBlocks(content: string): string {
  return content.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:private-key]')
}
export function scanSecrets(content: string): string[] {
  const hits = SECRET_PATTERNS.filter((p) => {
    p.re.lastIndex = 0
    return p.re.test(content)
  }).map((p) => p.name)
  if (TRUNCATED_KEY_OVERFLOW.test(stripCompleteBlocks(content))) hits.push('private-key-overflow')
  return hits
}

export function redactSecrets(content: string): string {
  // Complete blocks first (precise, unbounded): prose around them survives.
  // Only truncated remainders beyond the bounded partial rule nuke the field.
  let out = stripCompleteBlocks(content)
  if (TRUNCATED_KEY_OVERFLOW.test(out)) return '[REDACTED:private-key-overflow]'
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0
    out = out.replace(p.re, `[REDACTED:${p.name}]`)
  }
  return out
}

/** Recursively redacts every string in persisted structures (evidence,
 * implementedMeta, verdict reasons) — no raw secret survives in any field. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as unknown as T
  if (Array.isArray(value)) return value.map(redactDeep) as unknown as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[redactSecrets(k)] = redactDeep(v)
    return out as unknown as T
  }
  return value
}

function hasNegatedCompletion(content: string): boolean {
  return NEGATION_PATTERNS.some((re) => re.test(content))
}

function isGenericTrigger(trigger: string): boolean {
  const t = trigger.trim().toLowerCase()
  return t.length === 0 || GENERIC_TRIGGERS.some((g) => t === g || t.includes(g))
}

export interface ImplementedMeta {
  files?: string[]
  commit?: string
  testProof?: string
}

/**
 * Pure admission check. conflictLookup covers live vault state AND pending
 * review candidates (callers union both); identical (category, key) with
 * identical content is a no-op signal, anything else on the same key needs
 * review (update vs. contradiction decided there, never auto-merged).
 */
export function admit(
  candidate: AdmissionCandidate,
  lookup: ConflictLookup,
): AdmissionVerdict {
  const reasons: string[] = []
  const fail = (reason: string): AdmissionVerdict => ({ decision: 'reject', score: 0, reasons: [...reasons, reason] });

  // ---- Stage 1: structural eligibility (hard gates, no score involved) ----
  if (!candidate.content || candidate.content.trim().length === 0) return fail('empty content')
  if (!candidate.futureUse || candidate.futureUse.trim().length < 10) {
    return fail('missing concrete future benefit (min 10 chars)')
  }
  if (!candidate.evidence?.sourceRef) return fail('missing source reference')
  if (!candidate.db) return fail('missing scope (db)')
  if (!candidate.key) return fail('missing key')
  if (!candidate.category) return fail('missing category')

  const secrets = scanSecrets(candidateText(candidate))
  if (secrets.length > 0) {
    return {
      decision: 'reject',
      score: 0,
      reasons: [...reasons, `secrets detected (${secrets.join(',')})`],
      redactedContent: redactSecrets(candidate.content),
    }
  }

  if (!Array.isArray(candidate.triggers) || candidate.triggers.length === 0) {
    return fail('at least one recall_when trigger required')
  }
  if (candidate.triggers.length > 3) return fail('at most 3 triggers (keep the most specific)')
  const generic = candidate.triggers.filter(isGenericTrigger)
  if (generic.length > 0) {
    return fail(`generic triggers rejected: ${generic.join('; ')}`)
  }

  // Global scope holds ONLY confirmed user preferences — nothing else.
  if (candidate.db === 'global' && candidate.category !== 'preference') {
    return fail('global scope accepts only user preferences (keep project facts local or promote as preference)')
  }

  let score = 1.0
  if (!(KNOWN_CATEGORIES as readonly string[]).includes(candidate.category)) {
    reasons.push(`unknown category '${candidate.category}': capped at review`)
    score = Math.min(score, ADMISSION_REVIEW_THRESHOLD + 0.04)
  }

  if (candidate.category === 'implemented') {
    const structural = checkImplementedShape(candidate, reasons)
    if (!structural.ok) return fail(structural.reason)
    score = Math.min(score, structural.score)
    if (structural.blocks) {
      if (score >= ADMISSION_REVIEW_THRESHOLD) {
        return {
          decision: 'review',
          score: Math.max(0, Math.min(1, score)),
          reasons: [...reasons, 'below auto threshold'],
          nonOverridable: structural.blocks,
        }
      }
      return {
        decision: 'reject',
        score: Math.max(0, Math.min(1, score)),
        reasons: [...reasons, 'below review threshold'],
        nonOverridable: structural.blocks,
      }
    }
  } else if (hasNegatedCompletion(candidate.content)) {
    reasons.push('negated completion: review, not auto')
    score -= 0.25
  }

  const distinct = new Set(candidate.triggers.map((t) => t.trim().toLowerCase()))
  if (distinct.size !== candidate.triggers.length) {
    reasons.push('duplicate triggers')
    score -= 0.05
  }

  // ---- Stage 2: routing (conflicts + thresholds) ----
  const sameKey = lookup.findSameKey(candidate.db, candidate.category, candidate.key)
  const identical = sameKey.find((e) => e.content.trim() === candidate.content.trim())
  if (identical) {
    return { decision: 'reject', score, reasons: [...reasons, 'identical content on same key: no-op'] }
  }
  if (sameKey.length > 0) {
    reasons.push(`${sameKey.length} existing entit(ies) on same key: needs update-vs-contradiction review`)
    score = Math.min(score, ADMISSION_REVIEW_THRESHOLD + 0.04)
  }
  if (candidate.db === 'global' && candidate.evidence.confirmedByUser !== true) {
    reasons.push('global entries need explicit user confirmation: review at best')
    score = Math.min(score, ADMISSION_REVIEW_THRESHOLD + 0.04)
    return routed('review', ['global-confirmation'])
  }

  function routed(
    decision: AdmissionDecision,
    nonOverridable: string[] = [],
  ): AdmissionVerdict {
    const finalScore = Math.max(0, Math.min(1, score))
    if (decision === 'review' || finalScore < ADMISSION_AUTO_THRESHOLD) {
      const d: AdmissionDecision = finalScore >= ADMISSION_REVIEW_THRESHOLD ? 'review' : 'reject'
      const suffix = d === 'review' ? [...reasons, 'below auto threshold'] : [...reasons, 'below review threshold']
      return { decision: d, score: finalScore, reasons: suffix, nonOverridable }
    }
    return { decision: 'approve', score: finalScore, reasons, nonOverridable }
  }

  score = Math.max(0, Math.min(1, score))
  if (score >= ADMISSION_AUTO_THRESHOLD) return { decision: 'approve', score, reasons }
  if (score >= ADMISSION_REVIEW_THRESHOLD) {
    return { decision: 'review', score, reasons: [...reasons, 'below auto threshold'] }
  }
  return { decision: 'reject', score, reasons: [...reasons, 'below review threshold'] }
}

function checkImplementedShape(
  candidate: AdmissionCandidate,
  reasons: string[],
): { ok: boolean; reason: string; score: number; blocks?: string[] } {
  const lines = candidate.content.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length > 3) {
    return { ok: false, reason: 'implemented allows at most 3 content lines', score: 0 }
  }
  if (candidate.status !== 'done' && candidate.status !== 'reverted') {
    return { ok: false, reason: "implemented needs status 'done' or 'reverted'", score: 0 }
  }
  if (hasNegatedCompletion(candidate.content)) {
    reasons.push('negated completion reads as plan, not result')
    return { ok: true, reason: '', score: 0.65 }
  }
  if (!candidate.implementedMeta?.testProof && candidate.status === 'done') {
    reasons.push('implemented done without test proof stays in review')
    return { ok: true, reason: '', score: ADMISSION_REVIEW_THRESHOLD + 0.04, blocks: ['implemented-proof'] }
  }
  return { ok: true, reason: '', score: 1.0 }
}
