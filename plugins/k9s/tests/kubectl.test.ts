import type { On } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

import { KUBECTL_DENY, invokesKubectl } from '../hooks/register'

tier('user')

const INVOCATIONS = [
  'kubectl get pods -n kube-system',
  'cat x | kubectl apply -f -',
  'sudo kubectl get ns',
  'KUBECONFIG=~/.kube/dev kubectl get ns',
  'echo $(kubectl get pods)',
  'ls && kubectl get pods',
  'ls || kubectl get pods',
  '/usr/local/bin/kubectl get pods',
  'cd /tmp\nkubectl get pods',
  'watch kubectl get pods',
  'kubectl',
  'for n in a b; do kubectl get pods -n $n; done',
]

const MENTIONS = [
  'ls',
  'cat ~/notes/kubectl-cheatsheet.md',
  "printf '%s\\n' '- [kubectl blocked](x.md) - foo' >> MEMORY.md",
  'grep -r kubectl ~/.claude/hooks',
  'echo "use kubectl later"',
  'brew info kubectl',
  'which kubectl',
  'cat > f <<EOF\nkubectl-ish text\nEOF',
]

/** A tmux beneath the plugin: every call succeeds, has-session says yes, capture answers the given rows. */
function liveTmux(on: On, rows: string[]) {
  on('process.run', ($, e) => {
    const line = e.argv.join(' ')
    const stdout = line.includes('capture-pane') ? `3 1 100 ${rows.length} 0  0\n${rows.join('\n')}\n` : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

/** No tmux server: every call fails as tmux does with no server. */
function deadTmux(on: On) {
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'no server running', isStdoutTruncated: false, isStderrTruncated: false } }))
}

describe('kubectl guard', () => {
  test('recognises kubectl in command position and nothing else', () => {
    for (const c of INVOCATIONS) expect([c, invokesKubectl(c)]).toEqual([c, true])
    for (const c of MENTIONS) expect([c, invokesKubectl(c)]).toEqual([c, false])
  })

  test('passes kubectl through while k9s is not running', async ($, on) => {
    deadTmux(on)
    const ran: string[] = []
    on('tool.call', { tool: 'Bash' }, ($, e) => {
      ran.push(e.command)
      return { result: 'ran' }
    })
    const seen = await $.tool.call({ tool: 'Bash', command: 'kubectl get pods' })
    expect(ran).toEqual(['kubectl get pods'])
    expect(JSON.stringify(seen)).not.toMatch(/k9s pane is open/)
  })

  test('refuses kubectl while k9s runs, and only kubectl', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-09T12:00:00Z') })
    liveTmux(on, ['nginx-1   1/1   Running'])
    const ran: string[] = []
    on('tool.call', { tool: 'Bash' }, ($, e) => {
      ran.push(e.command)
      return { result: 'ran' }
    })

    const starting = $.tool.call({ tool: 'mcp__k9s__screen' })
    await clock.advance(1000)
    expect(JSON.stringify(await starting)).toMatch(/nginx-1/)

    const refused = await $.tool.call({ tool: 'Bash', command: 'kubectl get pods -A' })
    expect(JSON.stringify(refused)).toMatch(/k9s pane is open/)
    expect(JSON.stringify(refused)).toContain(KUBECTL_DENY.slice(0, 40))
    expect(ran).toEqual([])

    await $.tool.call({ tool: 'Bash', command: 'echo "use kubectl later"' })
    expect(ran).toEqual(['echo "use kubectl later"'])
  })
})
