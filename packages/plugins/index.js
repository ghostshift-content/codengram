// @codengram/plugins — M2: the plugin CONTRACT + registry (BLUEPRINT §9).
//
// Language/framework logic lives BEHIND this interface from the start, so the recon engine never hardcodes a stack.
// A plugin declares what it handles (`detect`) and how it reads the source deterministically (`inventory`). Later
// milestones fill the optional hooks (parse/emitGraph/featureTemplate) — declared here so the shape is stable, but
// M2 only requires detect + inventory. Adding Django/Spring/etc. is a new plugin, never a core edit.
import { INVENTORY_FILES } from '../schemas/index.js'

export const INVENTORY_KEYS = Object.freeze(INVENTORY_FILES.map((f) => f.replace(/^\d+_/, ''))) // routes_endpoints, …

// A plugin is a plain object; definePlugin validates + freezes it (fail fast on a malformed plugin).
export function definePlugin(spec) {
  const p = spec || {}
  if (!p.id || typeof p.id !== 'string') throw new Error('plugin needs a string id')
  if (!Array.isArray(p.langs) || !p.langs.length) throw new Error(`plugin ${p.id}: langs must be a non-empty array`)
  if (typeof p.detect !== 'function') throw new Error(`plugin ${p.id}: detect(profile) must be a function`)
  if (typeof p.inventory !== 'function') throw new Error(`plugin ${p.id}: inventory(ctx) must be a function`)
  return Object.freeze({ schema_compat: '0.3.0', ...p })
}

export class Registry {
  constructor() { this._plugins = [] }
  register(plugin) { this._plugins.push(definePlugin(plugin)); return this }
  all() { return this._plugins.slice() }
  // Every plugin whose detect() says yes for this repo profile. Deterministic order = registration order.
  match(profile) { return this._plugins.filter((p) => { try { return !!p.detect(profile) } catch { return false } }) }
}
