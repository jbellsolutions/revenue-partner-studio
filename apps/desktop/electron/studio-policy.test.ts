import { describe, it, expect, beforeEach } from 'vitest'
import { guardStudioOrgoRequest, requireStudioComputer, configureStudioBinding } from './studio-policy'

const STUDIO_COMPUTER_ID = '11111111-1111-4111-8111-111111111111'
describe('dedicated Studio target', () => {
  beforeEach(() => configureStudioBinding(() => STUDIO_COMPUTER_ID))
  it('supports a second installation without permitting the first computer', () => {
    const other = '22222222-2222-4222-8222-222222222222'
    configureStudioBinding(() => other)
    expect(() => requireStudioComputer(other)).not.toThrow()
    expect(() => requireStudioComputer(STUDIO_COMPUTER_ID)).toThrow()
    configureStudioBinding(() => '')
    expect(() => requireStudioComputer(other)).toThrow()
  })
  it('permits the dedicated computer and read-only inventory', () => {
    expect(() => guardStudioOrgoRequest('/workspaces')).not.toThrow()
    expect(() => guardStudioOrgoRequest(`/computers/${STUDIO_COMPUTER_ID}/bash`, 'POST')).not.toThrow()
  })
  it('refuses every unbound computer before making a request', () => {
    for (const id of ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', 'other']) {
      expect(() => requireStudioComputer(id)).toThrow()
      expect(() => guardStudioOrgoRequest(`/computers/${id}/bash`, 'POST')).toThrow()
    }
  })
  it('cannot provision account resources', () => {
    expect(() => guardStudioOrgoRequest('/computers', 'POST')).toThrow()
    expect(() => guardStudioOrgoRequest('/workspaces', 'POST')).toThrow()
  })
})
