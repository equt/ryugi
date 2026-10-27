import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(testDir, '../..')
const pluginPath = join(repoRoot, '.dsh/index.js')
const patchPath = join(repoRoot, '.dsh/cordis.patch.yml')
const toolsPath = join(repoRoot, 'skills/using-ryugi/references/dsh-tools.md')

const BOOTSTRAP_MARKER = 'You have Ryugi.'

async function loadPlugin() {
  const mod = await import(`${pathToFileURL(pluginPath).href}?cachebust=${Date.now()}-${Math.random()}`)
  return mod
}

function createAgent(id, { visibleBootstrap = false } = {}) {
  const events = []
  const injected = []
  if (visibleBootstrap) {
    events.push({
      seq: 0,
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: `${BOOTSTRAP_MARKER}\n` }], source: { kind: 'ryugi' } },
    })
  }
  const agent = {
    id,
    injected,
    session: {
      id,
      surface: { nodes: events.map((event) => event.seq) },
      snapshotEvents: () => events,
    },
    inject(message) {
      injected.push(message)
    },
  }
  return agent
}

function createHarness({ rootAgents = [] } = {}) {
  const handlers = new Map()
  const warnings = []
  const liveAgents = new Map()
  let providerFactory
  const ctx = {
    skills: {
      registerProvider(factory) {
        providerFactory = factory
        return () => {}
      },
    },
    agents: {
      roots: () => rootAgents,
      get: (id) => liveAgents.get(id),
    },
    on(event, handler) {
      assert.equal(handlers.has(event), false, `duplicate ${event} handler`)
      handlers.set(event, handler)
    },
    logger: {
      warn(message) {
        warnings.push(message)
      },
    },
  }
  return {
    ctx,
    handlers,
    warnings,
    liveAgents,
    getProvider() {
      assert.equal(typeof providerFactory, 'function', 'plugin should register a skill provider')
      return providerFactory({ signal: new AbortController().signal, invalidate() {} })
    },
  }
}

function textOf(message) {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

test('manifest declares a DeepSeek Harness bundle whose patch inserts the plugin', async () => {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
  assert.equal(pkg.dsh.bundle.patch, './.dsh/cordis.patch.yml')
  assert.equal(existsSync(patchPath), true)

  const patch = await readFile(patchPath, 'utf8')
  assert.match(patch, /id: ryugi/)
  assert.match(patch, /name: \.\/index\.js/)
  assert.equal(existsSync(pluginPath), true)
})

test('plugin registers the skill provider and both lifecycle listeners', async () => {
  const mod = await loadPlugin()
  assert.equal(mod.name, 'ryugi')
  assert.deepEqual(mod.inject, ['skills', 'agents'])

  const harness = createHarness()
  mod.apply(harness.ctx)

  assert.deepEqual([...harness.handlers.keys()].sort(), ['agent/created', 'session/event'])
  assert.equal(harness.getProvider().name, 'ryugi')
  assert.deepEqual(harness.warnings, [])
})

test('provider lists every bundled Ryugi skill and loads bodies without frontmatter', async () => {
  const mod = await loadPlugin()
  const harness = createHarness()
  mod.apply(harness.ctx)
  const provider = harness.getProvider()

  const candidates = await provider.list()
  const names = candidates.map((candidate) => candidate.name).sort()
  assert.deepEqual(names, [
    'artifacts',
    'brainstorming',
    'executing-specs',
    'systematic-debugging',
    'test-driven-development',
    'using-git-worktrees',
    'using-ryugi',
    'verifying-ui',
  ])

  for (const candidate of candidates) {
    assert.equal(candidate.provider, 'ryugi')
    assert.equal(candidate.source, 'bundled')
    assert.equal(candidate.rank, 600)
    assert.match(candidate.description, /\S/)
    assert.equal(candidate.invocation.modelInvocable, true)
    assert.equal(candidate.invocation.userInvocable, true)
    assert.equal(candidate.resourceBase.kind, 'directory')
  }

  const brainstorming = candidates.find((candidate) => candidate.name === 'brainstorming')
  const loaded = await provider.get(brainstorming)
  assert.equal(loaded.name, 'brainstorming')
  assert.match(loaded.content, /^# Brainstorming/m)
  assert.doesNotMatch(loaded.content, /^---$/m)
  assert.match(loaded.content, /finding out what they actually want/)
})

test('startup root session receives one bootstrap user message with the DSH mapping', async () => {
  const mod = await loadPlugin()
  const agent = createAgent('root-session')
  const harness = createHarness({ rootAgents: [agent] })
  mod.apply(harness.ctx)

  harness.handlers.get('agent/created')({ agent, source: 'startup' })

  assert.equal(agent.injected.length, 1)
  const message = agent.injected[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'ryugi')
  assert.equal(message.source.form, 'instructions')
  const text = textOf(message)
  assert.match(text, /^<EXTREMELY_IMPORTANT>/)
  assert.match(text, /You have Ryugi\./)
  assert.match(text, /DeepSeek Harness Tool Mapping/)
  assert.match(text, /`skill` with `name: "<skill-name>"`/)
  assert.match(text, /`subagent`/)
  assert.match(text, /`todo_write`/)
  assert.match(text, /## Platform Adaptation/)
  assert.match(text, /<\/EXTREMELY_IMPORTANT>$/)
})

test('a failed bootstrap injection is logged and does not fail session creation', async () => {
  const mod = await loadPlugin()
  const agent = createAgent('failing-inject')
  agent.inject = () => {
    throw new Error('inbox unavailable')
  }
  const harness = createHarness({ rootAgents: [agent] })
  mod.apply(harness.ctx)

  assert.doesNotThrow(() => {
    harness.handlers.get('agent/created')({ agent, source: 'startup' })
  })
  assert.equal(harness.warnings.length, 1)
  assert.match(harness.warnings[0], /could not inject the session bootstrap/)
  assert.match(harness.warnings[0], /inbox unavailable/)
})

test('subagent creation does not receive the bootstrap', async () => {
  const mod = await loadPlugin()
  const child = createAgent('child-session')
  const harness = createHarness({ rootAgents: [] })
  harness.liveAgents.set(child.id, child)
  mod.apply(harness.ctx)

  harness.handlers.get('agent/created')({ agent: child, source: 'startup' })

  assert.equal(child.injected.length, 0)
})

test('resume and startup skip an already-visible bootstrap', async () => {
  const mod = await loadPlugin()
  const agent = createAgent('resumed-session', { visibleBootstrap: true })
  const harness = createHarness({ rootAgents: [agent] })
  mod.apply(harness.ctx)

  harness.handlers.get('agent/created')({ agent, source: 'resume' })
  harness.handlers.get('agent/created')({ agent, source: 'startup' })

  assert.equal(agent.injected.length, 0)
})

test('compaction re-injects the bootstrap, then dedupes once it is visible', async () => {
  const mod = await loadPlugin()
  const agent = createAgent('compacted-session')
  const harness = createHarness({ rootAgents: [agent] })
  harness.liveAgents.set(agent.id, agent)
  mod.apply(harness.ctx)

  // The real `session/event` dispatch runs inside an open append boundary;
  // injecting synchronously would reenter it and be rejected. Keep the boundary
  // "open" until after the handler returns, then flip it and drain microtasks.
  let appendBoundaryOpen = true
  agent.inject = (message) => {
    assert.equal(appendBoundaryOpen, false, 'bootstrap injection must not reenter the session append')
    agent.injected.push(message)
  }

  harness.handlers.get('session/event')(agent.session, { type: 'compaction/end', data: {} })
  assert.equal(agent.injected.length, 0, 'injection is deferred past the append boundary')
  appendBoundaryOpen = false
  await Promise.resolve()
  assert.equal(agent.injected.length, 1)

  agent.session.snapshotEvents = () => [
    {
      seq: 0,
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: BOOTSTRAP_MARKER }], source: { kind: 'ryugi' } },
    },
  ]
  agent.session.surface.nodes = [0]

  harness.handlers.get('session/event')(agent.session, { type: 'compaction/end', data: {} })
  await Promise.resolve()
  assert.equal(agent.injected.length, 1, 'a visible bootstrap must not be duplicated')
})

test('compaction skips a session whose agent was disposed before the microtask', async () => {
  const mod = await loadPlugin()
  const agent = createAgent('disposed-compaction')
  const harness = createHarness({ rootAgents: [agent] })
  harness.liveAgents.set(agent.id, agent)
  mod.apply(harness.ctx)

  harness.handlers.get('session/event')(agent.session, { type: 'compaction/end', data: {} })
  harness.liveAgents.delete(agent.id)
  await Promise.resolve()

  assert.equal(agent.injected.length, 0)
})

test('failed compaction does not inject', async () => {
  const mod = await loadPlugin()
  const agent = createAgent('failed-compaction')
  const harness = createHarness({ rootAgents: [agent] })
  harness.liveAgents.set(agent.id, agent)
  mod.apply(harness.ctx)

  harness.handlers.get('session/event')(agent.session, {
    type: 'compaction/end',
    data: { error: 'cancelled' },
  })
  await Promise.resolve()

  assert.equal(agent.injected.length, 0)
})

test('the DSH tool mapping covers the actions Ryugi skills name', async () => {
  assert.equal(existsSync(toolsPath), true)
  const text = await readFile(toolsPath, 'utf8')
  for (const tool of ['skill', 'read', 'write', 'edit', 'bash', 'grep', 'glob', 'web_fetch', 'web_search', 'subagent', 'subagent_fork', 'todo_write', 'ask_user_question']) {
    assert.match(text, new RegExp(`\`${tool}\``), `mapping should name ${tool}`)
  }
  assert.match(text, /skill\(\{ name: "brainstorming" \}\)/)
})

test('the bootstrap skill points DeepSeek Harness at the mapping reference', async () => {
  const skill = await readFile(join(repoRoot, 'skills/using-ryugi/SKILL.md'), 'utf8')
  assert.match(skill, /- DeepSeek Harness: `references\/dsh-tools\.md`/)
})
