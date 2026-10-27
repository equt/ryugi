/**
 * Ryugi plugin for DeepSeek Harness.
 *
 * Loaded as a bundle plugin through `.dsh/cordis.patch.yml`. It contributes two
 * things:
 *
 * - a skill provider over the bundled `skills/` directory, so every Ryugi
 *   skill appears in the session skill catalog and loads through the native
 *   `skill` tool;
 * - the `using-ryugi` bootstrap as a durable user-role message at session
 *   start, re-injected after compaction and skipped when the visible history
 *   already contains it.
 *
 * No external dependencies — only Node.js built-ins.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const skillsDir = join(packageRoot, 'skills')
const bootstrapSkillPath = join(skillsDir, 'using-ryugi', 'SKILL.md')
const toolMappingPath = join(skillsDir, 'using-ryugi', 'references', 'dsh-tools.md')

/** Provider name registered on `ctx.skills`. */
const PROVIDER_NAME = 'ryugi'
/** Bundled providers rank below project and custom roots, above nothing. */
const BUNDLED_SKILL_RANK = 600
/** Marker used to detect an already-injected bootstrap in visible history. */
const BOOTSTRAP_MARKER = 'You have Ryugi.'
/** Sessions with a compaction re-injection already queued for the next microtask. */
const compactionInjections = new WeakSet()

/**
 * Commit one bootstrap message for DeepSeek Harness.
 *
 * `source.kind` is a producer-owned value (the session format refuses the
 * retired shared `plugin` wrapper), and `form: 'instructions'` tells clients
 * this is workspace-style guidance rather than a notice or catalog.
 */
const SOURCE = Object.freeze({ kind: 'ryugi', form: 'instructions' })

/**
 * @typedef {object} SkillCandidate
 * @property {string} name
 * @property {string} description
 * @property {{ modelInvocable: boolean, userInvocable: boolean }} invocation
 * @property {string} source
 * @property {string} provider
 * @property {number} rank
 * @property {string} locator
 * @property {string} path
 * @property {{ kind: 'directory', path: string }} resourceBase
 */

/**
 * Split a skill file's YAML frontmatter from its body.
 *
 * Handles plain `key: value` lines, quoted values, YAML block scalar markers
 * with indented continuation lines, and CRLF endings. This is deliberately not
 * a full YAML parser: only `name` and `description` are consumed, and both are
 * single logical lines in Ryugi's own skills.
 *
 * @param {string} content - complete SKILL.md text.
 * @returns {{ frontmatter: Record<string, string>, content: string }}
 */
function extractAndStripFrontmatter(content) {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
	if (!match) return { frontmatter: {}, content }

	const frontmatter = {}
	let lastKey = null

	for (const rawLine of match[1].split('\n')) {
		const line = rawLine.replace(/\r$/, '')
		const colonIdx = line.indexOf(':')
		if (colonIdx > 0 && !/^\s/.test(line)) {
			const key = line.slice(0, colonIdx).trim()
			const value = line.slice(colonIdx + 1).trim()
			frontmatter[key] = /^(>[+-]?|\|[+-]?)$/.test(value) ? '' : value
			lastKey = key
		} else if (lastKey !== null && line.trim() !== '') {
			frontmatter[lastKey] = `${frontmatter[lastKey]} ${line.trim()}`.trim()
		}
	}

	for (const key of Object.keys(frontmatter)) {
		frontmatter[key] = frontmatter[key].replace(/^(["'])([\s\S]*)\1$/, '$2')
	}

	return { frontmatter, content: match[2] }
}

/**
 * Validate a skill name against the registry's public kebab-case grammar.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isSkillName(name) {
	return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
}

/**
 * Build the bundled skill provider.
 *
 * Discovery reads every `skills/<name>/SKILL.md` frontmatter on each catalog
 * read (cheap: the bundle ships eight skills), and loading re-reads the body so
 * edits are visible without a restart. A directory that cannot be read is
 * skipped rather than failing the whole catalog.
 *
 * @param {{ logger: { warn(message: string): void } }} ctx
 */
function createProvider(ctx) {
	return {
		name: PROVIDER_NAME,

		async list() {
			let entries
			try {
				entries = await readdir(skillsDir, { withFileTypes: true })
			} catch (error) {
				ctx.logger.warn(`ryugi: could not scan ${skillsDir}: ${String(error)}`)
				return []
			}

			const candidates = []
			for (const entry of entries) {
				if (!entry.isDirectory()) continue
				const skillDir = join(skillsDir, entry.name)
				const skillPath = join(skillDir, 'SKILL.md')
				let text
				try {
					text = await readFile(skillPath, 'utf8')
				} catch {
					continue
				}

				const { frontmatter } = extractAndStripFrontmatter(text)
				const name = (frontmatter.name ?? '').trim()
				const description = (frontmatter.description ?? '').trim()
				if (!isSkillName(name) || description === '') continue

				candidates.push({
					name,
					description,
					invocation: { modelInvocable: true, userInvocable: true },
					source: 'bundled',
					provider: PROVIDER_NAME,
					rank: BUNDLED_SKILL_RANK,
					locator: skillPath,
					path: skillPath,
					resourceBase: { kind: 'directory', path: skillDir },
				})
			}
			return candidates
		},

		async get(candidate) {
			const text = await readFile(candidate.locator, 'utf8')
			return {
				name: candidate.name,
				description: candidate.description,
				invocation: candidate.invocation,
				source: candidate.source,
				provider: candidate.provider,
				path: candidate.path,
				resourceBase: candidate.resourceBase,
				content: extractAndStripFrontmatter(text).content.trim(),
			}
		},
	}
}

/**
 * Read the bootstrap skill and the DeepSeek Harness tool mapping once.
 *
 * @param {{ logger: { warn(message: string): void } }} ctx
 * @returns {string | null} assembled bootstrap, or null when it cannot load.
 */
function loadBootstrap(ctx) {
	let skillText
	try {
		skillText = readFileSync(bootstrapSkillPath, 'utf8')
	} catch (error) {
		ctx.logger.warn(`ryugi: could not read ${bootstrapSkillPath}: ${String(error)}`)
		return null
	}

	let toolMapping
	try {
		toolMapping = readFileSync(toolMappingPath, 'utf8').trim()
	} catch (error) {
		ctx.logger.warn(`ryugi: could not read ${toolMappingPath}: ${String(error)}`)
		toolMapping = [
			'## DeepSeek Harness tool mapping',
			'',
			'Invoke skills with the native `skill` tool. Use `read`, `write`, `edit`, `bash`,',
			'`grep`, `glob`, `web_fetch`, `web_search`, `subagent`/`subagent_fork`, and',
			'`todo_write` for the actions Ryugi skills name.',
		].join('\n')
	}

	return [
		'<EXTREMELY_IMPORTANT>',
		BOOTSTRAP_MARKER,
		'',
		'The using-ryugi skill content is included below and is already loaded for this DeepSeek Harness session. Follow it now. Do not load using-ryugi again with the skill tool.',
		'',
		extractAndStripFrontmatter(skillText).content.trim(),
		'',
		toolMapping,
		'</EXTREMELY_IMPORTANT>',
	].join('\n')
}

/**
 * Deep-freeze the bootstrap message before handing it to the agent inbox.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
	if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value)
		for (const child of Object.values(value)) deepFreeze(child)
	}
	return value
}

/**
 * Create the durable user message that carries the bootstrap.
 *
 * @param {string} text
 */
function createBootstrapMessage(text) {
	return deepFreeze({
		id: randomUUID(),
		role: 'user',
		content: [{ type: 'text', text }],
		source: { ...SOURCE },
	})
}

/**
 * Collect the text blocks of one persisted message.
 *
 * @param {{ content?: unknown }} message
 * @returns {string}
 */
function messageText(message) {
	const content = message?.content
	if (typeof content === 'string') return content
	if (!Array.isArray(content)) return ''
	return content
		.filter((part) => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text)
		.join('\n')
}

/**
 * Whether the model-visible surface already contains a bootstrap message.
 *
 * Uses the session surface rather than the raw log: compaction shadows the
 * original message in the log but removes it from the surface, which is exactly
 * the case that needs re-injection. A resume keeps it on the surface, so it is
 * not duplicated.
 *
 * @param {{ surface: { nodes: readonly number[] }, snapshotEvents(): readonly any[] }} session
 * @returns {boolean}
 */
function hasVisibleBootstrap(session) {
	try {
		const visible = new Set(session.surface.nodes)
		return session.snapshotEvents().some((event) => {
			if (!visible.has(event.seq) || event.type !== 'user/message') return false
			return messageText(event.data).includes(BOOTSTRAP_MARKER)
		})
	} catch {
		// A missing or partially restored session should not block the bootstrap.
		return false
	}
}

/** Cordis plugin name. */
export const name = 'ryugi'
/** Services required before the plugin can activate. */
export const inject = ['skills', 'agents']

/**
 * Register the skill provider and the session-start / compaction injectors.
 *
 * @param {any} ctx - Cordis context with `skills`, `agents`, and `on`.
 */
export function apply(ctx) {
	const bootstrap = loadBootstrap(ctx)

	ctx.skills.registerProvider(() => createProvider(ctx))

	ctx.on('agent/created', ({ agent }) => {
		// Subagents get the SUBAGENT-STOP branch, not the bootstrap: only root
		// sessions need the skill-using contract.
		if (!ctx.agents.roots().includes(agent)) return
		if (bootstrap === null || hasVisibleBootstrap(agent.session)) return
		try {
			agent.inject(createBootstrapMessage(bootstrap))
		} catch (error) {
			// A bootstrap failure must not fail session creation.
			ctx.logger.warn(`ryugi: could not inject the session bootstrap: ${String(error)}`)
		}
	})

	ctx.on('session/event', (session, event) => {
		if (event.type !== 'compaction/end') return
		if (event.data?.error !== undefined) return
		if (compactionInjections.has(session)) return
		const agent = ctx.agents.get(session.id)
		if (agent === undefined || !ctx.agents.roots().includes(agent)) return
		if (bootstrap === null || hasVisibleBootstrap(session)) return
		compactionInjections.add(session)
		// `session/event` observers run while the append boundary is still open.
		// `agent.inject` appends an inbox splice to the same session, so injecting
		// synchronously would reenter the open append and be rejected. Defer to
		// the next microtask, after the boundary closes, then re-check visibility.
		queueMicrotask(() => {
			compactionInjections.delete(session)
			try {
				if (hasVisibleBootstrap(session)) return
				if (ctx.agents.get(session.id) !== agent) return
				agent.inject(createBootstrapMessage(bootstrap))
			} catch (error) {
				ctx.logger.warn(`ryugi: could not re-inject the bootstrap after compaction: ${String(error)}`)
			}
		})
	})
}
