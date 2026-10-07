# SYNTHETIC demo consultation audio for the Doctor App's "Play demo consultation" (docs/adr/0022). Computer voices, not a real consultation:
# Windows' built-in text-to-speech (System.Speech) reads a short scripted consultation about a fictional adult patient (Ramesh Kumar, the
# primary patient of `npm run demo:jury`), one WAV file per utterance, with one installed voice for the doctor and another for the patient. No person
# is recorded and nothing is downloaded.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/demo-audio.ps1                     (writes apps/web/public/demo/consultation/)
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/demo-audio.ps1 -OutDir <folder>
#   node scripts/demo-audio.mjs                                                                     (runs this, then checks every file)
#
# Output: 01-doctor.wav ... 08-patient.wav (16 kHz, mono, 16-bit PCM, a plain 44-byte header, a short silence before and after the speech) and
# manifest.json (order, speaker role, voice, the script text, duration, size, SHA-256). Nothing in the output depends on the time it was made, so
# the same machine and voices give the same bytes; another Windows build may voice the text differently, which is why the files are committed and
# the manifest records their hashes. The script text in the manifest is documentation and test data only: what the application shows is what the
# speech model transcribes from the audio, never this text.
param(
  [string]$OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'apps\web\public\demo\consultation')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

# One voice per role. Both are installed with Windows (en-US); a missing one is an error, never a silent substitute.
$Voices = [ordered]@{ doctor = 'Microsoft Zira Desktop'; patient = 'Microsoft David Desktop' }
$Lines = @(
  @{ speaker = 'doctor'; text = 'Good morning, Mr. Kumar. What brings you in today?' },
  @{ speaker = 'patient'; text = 'Doctor, I have had a fever for three days and a mild cough.' },
  @{ speaker = 'doctor'; text = 'Any breathlessness or chest pain?' },
  @{ speaker = 'patient'; text = 'No chest pain. Slight breathlessness when I climb stairs.' },
  @{ speaker = 'doctor'; text = 'Are you taking your regular medicines?' },
  @{ speaker = 'patient'; text = 'Yes, I take my diabetes and blood pressure medicines regularly.' },
  @{ speaker = 'doctor'; text = 'Do you have any allergies to medicines?' },
  @{ speaker = 'patient'; text = 'Yes, I am allergic to penicillin. I get a rash.' }
)
$SampleRate = 16000
$BytesPerSample = 2
# Silence around each utterance (zero samples), so that one line does not run into the next when they are played in turn.
$LeadMs = 250
$TailMs = 500

function Get-Silence([int]$ms) { New-Object byte[] ([int]($SampleRate * $BytesPerSample * $ms / 1000)) }
function ConvertTo-JsonString([string]$s) { '"' + ($s -replace '\\', '\\' -replace '"', '\"') + '"' }
function Get-Sha256Hex([byte[]]$bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
}

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$entries = @()
try {
  $installed = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name })
  foreach ($v in $Voices.Values) {
    if ($installed -notcontains $v) { throw "The voice '$v' is not installed on this computer (installed: $($installed -join ', ')). Nothing was written." }
  }
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo($SampleRate, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.Rate = 0
  $synth.Volume = 100
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  $lead = Get-Silence $LeadMs
  $tail = Get-Silence $TailMs
  for ($i = 0; $i -lt $Lines.Count; $i++) {
    $line = $Lines[$i]
    $voice = $Voices[$line.speaker]
    $synth.SelectVoice($voice)
    if ($synth.Voice.Name -ne $voice) { throw "Asked for the voice '$voice' and got '$($synth.Voice.Name)'. Nothing more was written." }
    # Raw PCM in the requested format (an audio stream has no header); the WAV header is written below, so every file has the same plain layout.
    $pcm = New-Object System.IO.MemoryStream
    $synth.SetOutputToAudioStream($pcm, $format)
    $synth.Speak($line.text)
    $synth.SetOutputToNull()
    $raw = $pcm.ToArray()
    if ([System.Text.Encoding]::ASCII.GetString($raw, 0, 4) -eq 'RIFF') { throw 'The synthesizer wrote a WAV header into the audio stream; expected raw PCM.' }
    # The voices put a varying stretch of exact digital silence (zero samples) before and after the speech; it is cut, and the fixed silence
    # below is put in its place, so every line has the same spacing. Only zero samples are removed, never sound.
    $start = 0
    while ($start -lt $raw.Length - 1 -and $raw[$start] -eq 0 -and $raw[$start + 1] -eq 0) { $start += $BytesPerSample }
    $end = $raw.Length
    while ($end -gt $start + 1 -and $raw[$end - 2] -eq 0 -and $raw[$end - 1] -eq 0) { $end -= $BytesPerSample }
    if ($end - $start -lt $SampleRate * $BytesPerSample / 2) { throw "The voice produced less than half a second of sound for line $($i + 1)." }
    $speech = New-Object byte[] ($end - $start)
    [System.Array]::Copy($raw, $start, $speech, 0, $end - $start)
    $dataLength = $lead.Length + $speech.Length + $tail.Length

    $wav = New-Object System.IO.MemoryStream
    $w = New-Object System.IO.BinaryWriter($wav)
    $w.Write([System.Text.Encoding]::ASCII.GetBytes('RIFF'))
    $w.Write([uint32](36 + $dataLength))
    $w.Write([System.Text.Encoding]::ASCII.GetBytes('WAVEfmt '))
    $w.Write([uint32]16)
    $w.Write([uint16]1)
    $w.Write([uint16]1)
    $w.Write([uint32]$SampleRate)
    $w.Write([uint32]($SampleRate * $BytesPerSample))
    $w.Write([uint16]$BytesPerSample)
    $w.Write([uint16]16)
    $w.Write([System.Text.Encoding]::ASCII.GetBytes('data'))
    $w.Write([uint32]$dataLength)
    $w.Write($lead)
    $w.Write($speech)
    $w.Write($tail)
    $w.Flush()
    $bytes = $wav.ToArray()
    $w.Dispose()

    $file = '{0:D2}-{1}.wav' -f ($i + 1), $line.speaker
    [System.IO.File]::WriteAllBytes((Join-Path $OutDir $file), $bytes)
    $entries += [pscustomobject]@{
      index = $i + 1
      file = $file
      speaker = $line.speaker
      voice = $voice
      text = $line.text
      durationMs = [int][math]::Round($dataLength * 1000 / ($SampleRate * $BytesPerSample))
      bytes = $bytes.Length
      sha256 = Get-Sha256Hex $bytes
    }
  }
} finally {
  $synth.Dispose()
}

# The manifest is written by hand (two-space JSON, LF, UTF-8 without a byte order mark) so that it is the same on every run and reads the same in
# Node and in the browser. The label's dash is made from its code point, so that this file stays plain ASCII for Windows PowerShell.
$total = ($entries | Measure-Object -Property durationMs -Sum).Sum
$u = $entries | ForEach-Object {
  '    { "index": ' + $_.index + ', "file": ' + (ConvertTo-JsonString $_.file) + ', "speaker": ' + (ConvertTo-JsonString $_.speaker) + ', "voice": ' + (ConvertTo-JsonString $_.voice) +
  ', "text": ' + (ConvertTo-JsonString $_.text) + ', "durationMs": ' + $_.durationMs + ', "bytes": ' + $_.bytes + ', "sha256": ' + (ConvertTo-JsonString $_.sha256) + ' }'
}
$json = @(
  '{'
  '  "kind": "adaxai-demo-consultation-audio",'
  '  "version": 1,'
  '  "synthetic": true,'
  '  "label": "SYNTHETIC AUDIO ' + [char]0x2014 + ' computer voices, not a real consultation",'
  '  "about": "Windows text-to-speech reading a scripted consultation about a fictional adult patient (Ramesh Kumar, the primary patient of npm run demo:jury). No person was recorded. The text below is the script, for documentation and tests; the application shows only what the speech model transcribes from the audio.",'
  '  "generator": "scripts/demo-audio.ps1 (Windows System.Speech text-to-speech)",'
  '  "format": { "container": "wav", "codec": "pcm_s16le", "sampleRateHz": ' + $SampleRate + ', "channels": 1, "bitsPerSample": 16, "leadSilenceMs": ' + $LeadMs + ', "tailSilenceMs": ' + $TailMs + ' },'
  '  "voices": { "doctor": ' + (ConvertTo-JsonString $Voices.doctor) + ', "patient": ' + (ConvertTo-JsonString $Voices.patient) + ' },'
  '  "totalDurationMs": ' + $total + ','
  '  "utterances": ['
  ($u -join ",`n")
  '  ]'
  '}'
) -join "`n"
[System.IO.File]::WriteAllText((Join-Path $OutDir 'manifest.json'), $json + "`n", (New-Object System.Text.UTF8Encoding $false))
Write-Output ("[demo-audio] wrote {0} utterances ({1:N1} s of synthetic audio) and manifest.json to {2}" -f $entries.Count, ($total / 1000), $OutDir)
