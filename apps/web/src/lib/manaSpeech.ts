import { useCallback, useEffect, useState } from 'react'
import { pickLocalVoice } from './manaGlobal.ts'

/** Whether the doctor turned "Speak answers" on (off by default). Kept in this browser only; a browser that keeps nothing simply starts with it off. */
const KEY = 'adaxai.mana.speakAnswers'
export function readSpeakAnswers(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}
export function writeSpeakAnswers(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    // Not kept: it is off again next time, which is the safe default.
  }
}

/**
 * Reading Mana's answers aloud with a voice that runs ON THIS COMPUTER only (`voice.localService === true`): the browser's network voices would send
 * the answer, and so the patient's record, to another company. No such voice: `voice` stays null and the screen says "No voice on this computer".
 * Mounted only while Mana is open; speech stops when it closes.
 */
export function useLocalSpeech(lang = 'en') {
  const [voice, setVoice] = useState<SpeechSynthesisVoice | null>(null)
  const [checked, setChecked] = useState(false)
  useEffect(() => {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') {
      setChecked(true)
      return
    }
    // The list of voices often arrives a moment later (voiceschanged).
    const read = () => {
      setVoice(pickLocalVoice(synth.getVoices(), lang))
      setChecked(true)
    }
    read()
    synth.addEventListener('voiceschanged', read)
    return () => {
      synth.removeEventListener('voiceschanged', read)
      synth.cancel()
    }
  }, [lang])
  const speak = useCallback(
    (text: string) => {
      if (!voice || !text.trim()) return
      const synth = window.speechSynthesis
      synth.cancel()
      const u = new SpeechSynthesisUtterance(text)
      u.voice = voice
      u.lang = voice.lang
      synth.speak(u)
    },
    [voice],
  )
  const cancel = useCallback(() => {
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel()
  }, [])
  return { voice, checked, speak, cancel }
}
