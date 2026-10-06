import type { ConsultationAi, ConsultDraft, ReviewConsultItemRequest } from '@adaxai/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { newIdempotencyKey } from './ai.ts'
import { api } from './api.ts'

export const consultKey = (encounterId: string) => ['encounter', encounterId, 'consultation-ai'] as const

/** One draft as polled while it is being made (GET /consultation-ai/drafts/:id): its phase and the model's progress, read about every second. */
export const draftPollKey = (draftId: string | null) => ['consultation-draft', draftId] as const

/** How often a draft being made is read again: the model's progress is reported at most every 500 ms; the read is cheap and not audited. */
export const DRAFT_POLL_MS = 1000

/**
 * The consultation's AI draft state: the local model's status, the consent, the newest draft with its statements and sources, and whether the
 * record moved since. While a draft is being made the screen asks the draft itself again every second (a cheap read that does not touch the
 * record, and carries how far the model has got), and when its phase or status changes the whole state is read again.
 */
export function useConsultationAi(encounterId: string) {
  const qc = useQueryClient()
  const state = useQuery({
    queryKey: consultKey(encounterId),
    // Always asks the model server now, not what it said a few seconds ago: what the screen says about the model is what is true.
    queryFn: () => api<ConsultationAi>(`/encounters/${encounterId}/consultation-ai`, { query: { fresh: 1 } }),
    // While the local model is not there the screen looks again every few seconds, so the draft button comes back by itself when it is.
    refetchInterval: (q) => (q.state.data && !q.state.data.status.available ? 5000 : false),
  })
  const generating = state.data?.draft?.status === 'generating' ? state.data.draft.id : null
  useQuery({
    queryKey: draftPollKey(generating),
    enabled: !!generating,
    refetchInterval: DRAFT_POLL_MS,
    queryFn: async () => {
      const d = await api<ConsultDraft>(`/consultation-ai/drafts/${generating}`)
      if (d.status !== 'generating' || d.phase !== state.data?.draft?.phase) await qc.invalidateQueries({ queryKey: consultKey(encounterId) })
      return d
    },
  })
  return state
}

export function useGenerateDraft(encounterId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<ConsultDraft>(`/encounters/${encounterId}/consultation-ai/drafts`, { method: 'POST', body: { idempotencyKey: newIdempotencyKey() } }),
    onSettled: () => qc.invalidateQueries({ queryKey: consultKey(encounterId) }),
  })
}

export function useCancelDraft(encounterId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (draftId: string) => api<ConsultDraft>(`/consultation-ai/drafts/${draftId}/cancel`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: consultKey(encounterId) }),
  })
}

export function useReviewConsultItem(encounterId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ReviewConsultItemRequest }) => api<ConsultationAi>(`/consultation-ai/items/${id}/review`, { method: 'POST', body }),
    onSuccess: (d) => qc.setQueryData(consultKey(encounterId), d),
  })
}
