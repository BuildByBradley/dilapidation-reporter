/** Thin wrapper over the browser's speech-to-text (Web Speech API). Not available in every browser. */
type RecognitionResult = { isFinal: boolean; 0: { transcript: string }; length: number };
type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> };
interface RecognitionLike {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
type RecognitionCtor = new () => RecognitionLike;

const ctor = (): RecognitionCtor | undefined => {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};
export const speechSupported = () => typeof window !== 'undefined' && !!ctor();

export type Recognizer = { start(): void; stop(): Promise<string>; abort(): void };

/** Create a recogniser that accumulates finished phrases. `onText` receives (final text so far, interim phrase). */
export function createRecognizer(onText: (finalText: string, interim: string) => void, onError: (code: string) => void, lang = 'en-ZA'): Recognizer | null {
  const C = ctor();
  if (!C) return null;
  const r = new C();
  r.lang = lang; r.continuous = true; r.interimResults = true;
  let finalText = '';
  let ended: (() => void) | null = null;
  r.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) finalText += `${res[0].transcript} `; else interim += res[0].transcript;
    }
    onText(finalText.trim(), interim.trim());
  };
  r.onerror = (e) => { if (e.error && e.error !== 'no-speech' && e.error !== 'aborted') onError(e.error); };
  r.onend = () => { ended?.(); ended = null; };
  return {
    start() { finalText = ''; try { r.start(); } catch { /* already started */ } },
    stop() {
      return new Promise<string>((resolve) => {
        const done = () => resolve(finalText.trim());
        ended = done;
        try { r.stop(); } catch { done(); }
        setTimeout(done, 1500); // some browsers never fire `end`
      });
    },
    abort() { ended = null; try { r.abort(); } catch { /* ignore */ } },
  };
}
