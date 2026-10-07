// The tool guard's classifier seam. A classifier sees only the tool's name,
// its arguments and the user's last prompt, never the transcript. It answers
// `deny` (refuse the call), `allow` (no objection) or `ask` (no opinion:
// leave the call to Claude Code's own permission flow). Neither `allow` nor
// `ask` overrides that flow; only `deny` changes what happens.

export type ClassifierInput = {
  tool: string
  input: Readonly<Record<string, unknown>>
  /** The user's last prompt as the turn started with it; '' when there was none. */
  lastPrompt: string
}

export type ClassifierVerdict = { decision: 'allow' | 'deny' | 'ask'; reason?: string }

export type Classifier = (call: ClassifierInput) => Promise<ClassifierVerdict>

/** The classifier cockpit ships: it has no opinion on any call. */
export const stubClassifier: Classifier = async () => ({ decision: 'ask' })
