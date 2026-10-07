// The mod's userConfig values, read once per load. Claude Code fills in the
// manifest's defaults; the fallbacks here only cover a value of the wrong type.

import type { PluginOptions } from 'claude-code'

export type CockpitConfig = {
  roundTrace: boolean
  roundTraceMaxTools: number
  timeline: boolean
  editedFiles: boolean
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function number(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

export function readConfig(options: PluginOptions): CockpitConfig {
  return {
    roundTrace: flag(options.roundTrace, true),
    roundTraceMaxTools: number(options.roundTraceMaxTools, 5, 1, 20),
    timeline: flag(options.timeline, true),
    editedFiles: flag(options.editedFiles, true),
  }
}
