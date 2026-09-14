import { describe, expect, it } from 'vitest'

import type { ToolPart } from '@/components/assistant-ui/tool/fallback-model'

import { shouldPresentProductTool } from './message-parts'

const tool = (overrides: Partial<ToolPart> = {}): ToolPart => ({
  args: {},
  result: { ok: true },
  toolCallId: 'tool-1',
  toolName: 'read_file',
  type: 'tool-call',
  ...overrides
})

describe('product tool presentation', () => {
  it('hides ordinary successful activity from the transcript', () => {
    expect(shouldPresentProductTool(tool())).toBe(false)
  })

  it('keeps genuine interventions visible', () => {
    expect(shouldPresentProductTool(tool({ result: undefined, toolName: 'clarify' }))).toBe(true)
  })

  it('keeps produced images but leaves recoverable tool failures in diagnostics', () => {
    expect(shouldPresentProductTool(tool({ toolName: 'image_generate' }))).toBe(true)
    expect(shouldPresentProductTool(tool({ isError: true, result: 'command failed', toolName: 'terminal' }))).toBe(
      false
    )
  })
})
