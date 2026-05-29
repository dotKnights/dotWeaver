import { describe, it, expect, vi } from 'vitest'

vi.mock('@sveltejs/kit', () => ({
  redirect: vi.fn((status, url) => {
    const error = new Error(`Redirect to ${url}`)
    ;(error as any).status = status
    ;(error as any).location = url
    throw error
  }),
}))

const { load } = await import('./+layout.server')

describe('(app) layout guard', () => {
  it('redirects to /login when no session', async () => {
    const event = { locals: { session: null, user: null } } as any
    await expect(load(event)).rejects.toThrow('Redirect to /login')
  })

  it('returns user when session exists', async () => {
    const user = { id: '1', name: 'Jane', email: 'jane@example.com' }
    const event = { locals: { session: { id: 'sess1' }, user } } as any
    const result = await load(event)
    expect(result).toEqual({ user })
  })
})
