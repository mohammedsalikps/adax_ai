import type { EvidenceTrust, ManaSourceItem, ManaToolName, ManaToolSummary, PlannedCall } from '@adaxai/contracts'
import type { Permission } from '../../auth/permissions.ts'
import type { SessionUser } from '../../auth/sessions.ts'
import type { Config } from '../../config.ts'
import type { Db } from '../../db/client.ts'
import type { DenialAudit } from '../../http/errors.ts'
import type { AppSettings } from '../../settings/schema.ts'
import type { EntityBook } from './entities.ts'

/** What a conversation was opened in: "this patient" means the patient of that consultation. */
export interface ConversationScope {
  encounterId: string | null
  patientId: string | null
}

/**
 * What every tool gets: who is asking (already authenticated, with the permissions of their role), where, and the patients this conversation has shown.
 * A tool receives nothing else: no facility id to choose, no raw query. Whatever it reads is read for this doctor in this clinic.
 */
export interface ManaCtx {
  db: Db
  me: SessionUser
  settings: AppSettings
  scope: ConversationScope
  book: EntityBook
  today: string
  timeZone: string
  now: Date
  /** Whether the model that writes the answer runs on this computer (a hosted one needs the patient's consent for AI record summaries). */
  modelIsLocal: boolean
  /** Patients whose identity this turn showed the doctor (for the audit). */
  disclosed: Set<string>
  /** Patients whose free text (a reason for a visit) a list showed: their consent is looked at again before the answer is kept. */
  textShown: Set<string>
  /** Lookups that were refused as "not found" but that the audit log must tell apart (a patient of another clinic): the caller writes them. */
  denials: DenialAudit[]
  /**
   * The deployment's configuration, for the consultation context (it reads one thing from it: whether a simulator may post here). Without it the context is
   * built as for a deployment where none may, the strictest reading.
   */
  config?: Config | undefined
}

/** One thing a tool established, in a sentence the model may copy from, and the records it rests on. The patient is a handle, never a name. */
export interface ToolFact {
  text: string
  patient: string | null
  items: ManaSourceItem[]
  /**
   * How far what it says can be trusted, in the consultation context's words (D2): set by the consultation tool only. The answer checks then hold a statement
   * that restates it to its trust: a device reading stays "unverified", a recording "not analysed", AI output says it is AI's (answer.ts).
   */
  trust?: EvidenceTrust | null
}

/** What the explicit rules found (a conflict, something old, something not recorded): shown to the doctor whatever the model writes. */
export interface ToolFinding {
  kind: 'conflict' | 'outdated' | 'absent'
  text: string
  /** The records the rule looked at. */
  items: ManaSourceItem[]
}

export interface ToolOutcome {
  status: ManaToolSummary['status']
  /** A short account for the tool's line in the details (counts and categories, never clinical text). */
  detail: string
  facts: ToolFact[]
  findings: ToolFinding[]
  /** Several patients matched a name: their handles (the doctor chooses; nothing is guessed). */
  candidates: string[]
  /** The patient this call was about, when it was about one. */
  patientId: string | null
}

export const outcome = (status: ToolOutcome['status'], detail: string, rest: Partial<ToolOutcome> = {}): ToolOutcome => ({ status, detail, facts: [], findings: [], candidates: [], patientId: null, ...rest })

export interface ToolDef {
  name: ManaToolName
  /** Permissions of the platform's own matrix, all of which the caller's role must hold: Mana grants nobody anything. */
  needs: readonly Permission[]
  run(ctx: ManaCtx, call: PlannedCall): Promise<ToolOutcome>
}
