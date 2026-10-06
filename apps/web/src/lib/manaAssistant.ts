import type { AskManaAssistantRequest, ManaActionDecision, ManaActionDecisionResult, ManaConversationState, ManaMessage, ManaQuestion, ManaVoiceTranscript, OpenManaConversationRequest } from '@adaxai/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { newIdempotencyKey } from './ai.ts'
import { api } from './api.ts'

/** What a conversation was opened for: a consultation, a patient's record, or the clinic in general. */
export interface ManaScope {
  encounterId?: string | undefined
  patientId?: string | undefined
}

export const manaConversationKey = (scope: ManaScope) => ['mana-assistant', scope.encounterId ?? scope.patientId ?? 'clinic'] as const

const openBody = (scope: ManaScope, fresh = false): OpenManaConversationRequest => ({ ...(scope.encounterId && { encounterId: scope.encounterId }), ...(!scope.encounterId && scope.patientId && { patientId: scope.patientId }), ...(fresh && { fresh: true }) })

/** The message being answered now, if any. */
export const pendingMessage = (s: ManaConversationState | undefined): ManaMessage | null => s?.messages.find((m) => m.role === 'mana' && m.status === 'pending') ?? null

/**
 * The doctor's conversation. It is opened (or continued) only when the panel is opened, never in the background. While an answer is being made the screen
 * asks the conversation again every two seconds; while the model is not there, every five (asking the model server itself, not what it said a moment
 * ago), so that the panel comes back by itself when the model does.
 */
export function useManaConversation(scope: ManaScope, enabled: boolean) {
  const qc = useQueryClient()
  const key = manaConversationKey(scope)
  return useQuery({
    queryKey: key,
    enabled,
    queryFn: () => {
      const known = qc.getQueryData<ManaConversationState>(key)
      return known ? api<ManaConversationState>(`/mana-assistant/conversations/${known.conversation.id}`, { query: { fresh: known.status.available ? undefined : 1 } }) : api<ManaConversationState>('/mana-assistant/conversations', { method: 'POST', body: openBody(scope) })
    },
    refetchInterval: (q) => (pendingMessage(q.state.data) ? 2000 : q.state.data && !q.state.data.status.available ? 5000 : false),
    // Nothing the doctor asked is kept in the browser: the server holds the conversation, and this is read again whenever the panel is opened.
    gcTime: 0,
  })
}

const conversationId = (qc: ReturnType<typeof useQueryClient>, scope: ManaScope): string => {
  const s = qc.getQueryData<ManaConversationState>(manaConversationKey(scope))
  if (!s) throw new Error('The conversation is not open')
  return s.conversation.id
}

export function useAskMana(scope: ManaScope) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Omit<AskManaAssistantRequest, 'idempotencyKey'>) => api<ManaConversationState>(`/mana-assistant/conversations/${conversationId(qc, scope)}/messages`, { method: 'POST', body: { ...body, idempotencyKey: newIdempotencyKey() } }),
    onSuccess: (s) => qc.setQueryData(manaConversationKey(scope), s),
    // A refusal (the model is not there, another question is still being answered) leaves the conversation as it is: read it again.
    onError: () => void qc.invalidateQueries({ queryKey: manaConversationKey(scope) }),
  })
}

export function useSelectManaPatient(scope: ManaScope) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (alias: string) => api<ManaConversationState>(`/mana-assistant/conversations/${conversationId(qc, scope)}/select`, { method: 'POST', body: { alias, idempotencyKey: newIdempotencyKey() } }),
    onSuccess: (s) => qc.setQueryData(manaConversationKey(scope), s),
    onError: () => void qc.invalidateQueries({ queryKey: manaConversationKey(scope) }),
  })
}

export function useCancelMana(scope: ManaScope) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (messageId: string) => api<ManaConversationState>(`/mana-assistant/messages/${messageId}/cancel`, { method: 'POST' }),
    onSuccess: (s) => qc.setQueryData(manaConversationKey(scope), s),
    onError: () => void qc.invalidateQueries({ queryKey: manaConversationKey(scope) }),
  })
}

/** A new conversation: what was said before is not "earlier" any more (it stays on the server, but is not shown or used). */
export function useNewManaConversation(scope: ManaScope) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<ManaConversationState>('/mana-assistant/conversations', { method: 'POST', body: openBody(scope, true) }),
    onSuccess: (s) => qc.setQueryData(manaConversationKey(scope), s),
  })
}

/**
 * HERO final: the doctor's Approve or Cancel on a medicine Mana proposed. The server records the decision only; the caller adds an approved medicine to
 * the draft through lib/draftBridge (the doctor's act). The conversation is read again afterwards (it shows the decision).
 */
export function useManaDecision(scope: ManaScope) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { messageId: string; decision: ManaActionDecision }) => api<ManaActionDecisionResult>(`/mana-assistant/messages/${v.messageId}/decision`, { method: 'POST', body: { decision: v.decision } }),
    onSettled: () => void qc.invalidateQueries({ queryKey: manaConversationKey(scope) }),
  })
}

/**
 * HERO final: one spoken question to the local speech model (transcribed in memory on the server, never stored). The text fields go before the file,
 * as the server reads them. In a consultation's conversation the server requires the patient's recording consent.
 */
export function transcribeVoice(clip: Blob, o: { type: string; name: string; conversationId?: string | undefined; durationMs: number; signal?: AbortSignal }): Promise<ManaVoiceTranscript> {
  const fd = new FormData()
  if (o.conversationId) fd.append('conversationId', o.conversationId)
  fd.append('durationMs', String(Math.max(0, Math.round(o.durationMs))))
  fd.append('file', new File([clip], o.name, { type: o.type }))
  return api<ManaVoiceTranscript>('/mana-assistant/voice', { method: 'POST', body: fd, ...(o.signal && { signal: o.signal }) })
}

export type { ManaQuestion }
