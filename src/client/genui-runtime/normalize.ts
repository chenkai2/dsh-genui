/** Deterministic GenUI alias and structural normalization. */
import { COMPONENT_SCHEMAS } from './schema.ts'
import { isComponentRoot } from '../spec.ts'
import type { GenuiDiagnostic } from './diagnostics.ts'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function isNode(value: unknown): value is Record<string, unknown> {
  const candidate = record(value)
  return candidate !== undefined && typeof candidate.type === 'string'
}

/** Fields a `stat` keeps when a metric record is folded into its own node. */
const STAT_METRIC_FIELDS = ['label', 'value', 'delta', 'spark', 'size'] as const

/**
 * Normalize one metric record of a stat group into a single-metric `stat`
 * node, or null when the entry is not a metric at all.
 */
function statMetricsOf(
  entries: readonly unknown[],
  path: string,
  normalizeChild: (child: unknown, childPath: string) => unknown,
): unknown[] | null {
  if (entries.length === 0) return null
  const metrics: unknown[] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    const metric = record(entry)
    if (metric === undefined) return null
    // An entry that is already a node passes through: the model enumerated
    // its own components instead of bare metrics.
    if (isNode(entry)) {
      metrics.push(normalizeChild(entry, `${path}.items[${index}]`))
      continue
    }
    if (typeof metric.label !== 'string' && typeof metric.value !== 'string') return null
    const stat: Record<string, unknown> = { type: 'stat' }
    for (const field of STAT_METRIC_FIELDS) {
      if (metric[field] !== undefined) stat[field] = metric[field]
    }
    metrics.push(stat)
  }
  return metrics
}

function normalizeAliasFields(value: Record<string, unknown>, path: string, type: string, warnings: GenuiDiagnostic[]): Record<string, unknown> {
  const definition = COMPONENT_SCHEMAS[type]
  if (definition === undefined) return value
  const out: Record<string, unknown> = { ...value }
  for (const [alias, canonical] of Object.entries(definition.aliases)) {
    if (!(alias in out)) continue
    const aliasPath = `${path}.${alias}`
    const keptCanonical = canonical in out
    if (!keptCanonical) out[canonical] = out[alias]
    delete out[alias]
    warnings.push({
      kind: 'alias',
      path: aliasPath,
      message: keptCanonical
        ? `${aliasPath} is ignored because canonical field '${canonical}' is present`
        : `${aliasPath} normalized/adopted as '${canonical}'`,
      type,
      field: alias,
      canonical,
    })
  }
  return out
}

function normalizeNode(value: unknown, path: string, warnings: GenuiDiagnostic[]): unknown {
  if (!isNode(value)) return value
  const type = value.type as string
  const definition = COMPONENT_SCHEMAS[type]
  // Custom nodes are opaque by contract: don't inspect or rewrite their data.
  if (definition === undefined) return value
  const out = normalizeAliasFields(value, path, type, warnings)
  const normalizeNodeValue = (child: unknown, childPath: string): unknown => normalizeNode(child, childPath, warnings)
  const normalizeNodeArray = (children: unknown, childPath: string): unknown => Array.isArray(children)
    ? children.map((child, index) => normalizeNodeValue(child, `${childPath}[${index}]`))
    : children

  if (type === 'stat' && Array.isArray(out.items) && out.label === undefined && out.value === undefined) {
    // Model-side generalization: one `stat` carrying a metric list
    // ({type:'stat',items:[{label,value},…]}) means "these metrics, side by
    // side". Normalize it into a row of single-metric stats, the documented
    // multi-stat idiom (SKILL.md), instead of letting repair drop the node and
    // reject the whole fence (issue #172, case A). A group that also declares
    // `label`/`value` is a single stat with stray fields and stays untouched.
    const metrics = statMetricsOf(out.items, path, normalizeNodeValue)
    if (metrics !== null) {
      warnings.push({
        kind: 'alias',
        path: `${path}.items`,
        message: `${path}.items normalized into a row of 'stat' nodes`,
        type,
        field: 'items',
        canonical: 'row',
      })
      return { type: 'row', items: metrics, ...(out.span !== undefined ? { span: out.span } : {}) }
    }
  }

  if (type === 'row' || type === 'col' || type === 'grid' || type === 'card' || type === 'file-tree' || type === 'timeline' || type === 'breadcrumb') {
    if (type !== 'file-tree' && type !== 'timeline' && type !== 'breadcrumb') out.items = normalizeNodeArray(out.items, `${path}.items`)
  } else if (type === 'list' && Array.isArray(out.items)) {
    // List items are a union (string | {title,desc} | nested node), and models
    // routinely dump 1×N / N×1 table cells in place of the item: `[["文本"]]`
    // renders as an EMPTY list and `{title, description}` loses its body
    // (repair reads `desc`). Both are pure shape defects — normalize them here
    // so validation, diagnostics, and repair all see the canonical item.
    out.items = out.items.map((child, index) => {
      if (isNode(child)) return normalizeNodeValue(child, `${path}.items[${index}]`)
      if (Array.isArray(child) && child.length === 1 && typeof child[0] === 'string') return child[0]
      const holder = record(child)
      if (holder === undefined || !('description' in holder)) return holder === undefined ? child : { ...holder }
      const normalizedHolder = { ...holder }
      const description = normalizedHolder.description
      delete normalizedHolder.description
      if (!('desc' in normalizedHolder) && typeof description === 'string') normalizedHolder.desc = description
      return normalizedHolder
    })
  } else if (type === 'keyvalue' && Array.isArray(out.pairs)) {
    // Pair-as-array (`[[key, value], …]` or `[[key], …]`) is what a model
    // writes when it treats keyvalue as a 2-column list. Canonicalize before
    // validation: the record validator rejects every array entry ("must be an
    // object"), and those errors take the whole fence down even though repair
    // could read the data.
    if (out.pairs.length > 0 && out.pairs.every(pair => Array.isArray(pair))) {
      out.pairs = out.pairs.map(pair => {
        const cells = pair as unknown[]
        return { key: cells[0], value: cells.length > 1 ? cells[1] : '' }
      })
    }
  } else if (type === 'tabs' && Array.isArray(out.tabs)) {
    out.tabs = out.tabs.map((tab, index) => {
      const holder = record(tab)
      if (holder === undefined) return tab
      const normalizedHolder = { ...holder }
      if ('content' in normalizedHolder) {
        const tabPath = `${path}.tabs[${index}].content`
        const hasItems = 'items' in normalizedHolder
        if (!hasItems) normalizedHolder.items = normalizedHolder.content
        delete normalizedHolder.content
        warnings.push({
          kind: 'alias',
          path: tabPath,
          message: hasItems
            ? `${tabPath} is ignored because canonical field 'items' is present`
            : `${tabPath} normalized/adopted as 'items'`,
          type,
          field: 'content',
          canonical: 'items',
        })
      }
      normalizedHolder.items = Array.isArray(normalizedHolder.items)
        ? normalizedHolder.items.map((child, childIndex) => normalizeNodeValue(child, `${path}.tabs[${index}].items[${childIndex}]`))
        : normalizedHolder.items === undefined
          ? normalizedHolder.items
          : [normalizeNodeValue(normalizedHolder.items, `${path}.tabs[${index}].items[0]`)]
      return normalizedHolder
    })
  } else if (type === 'accordion' && Array.isArray(out.items)) {
    out.items = out.items.map((item, index) => {
      const holder = record(item)
      if (holder === undefined) return item
      return { ...holder, items: Array.isArray(holder.items) ? holder.items.map((child, childIndex) => normalizeNodeValue(child, `${path}.items[${index}].items[${childIndex}]`)) : holder.items }
    })
  }
  return out
}

/**
 * Normalize a raw GenUI value into canonical field names.
 *
 * Only deterministic aliases and structural aliases are changed. Resource
 * limits, type repair, security filtering, and semantic validation remain in
 * the guard layer. Unknown component types are returned opaque.
 *
 * @param value - Raw GenUI spec or bare native component.
 * @returns Canonical value and stable alias diagnostics.
 */
export function normalizeGenuiSpec(value: unknown): { value: unknown; warnings: GenuiDiagnostic[] } {
  const warnings: GenuiDiagnostic[] = []
  const root = record(value)
  if (root === undefined) return { value, warnings }
  const out = { ...root }
  // A bare component root is normalized as a node, not as an envelope whose
  // `items` are its children: for a data component (steps/list/timeline/…)
  // `items` is the record list and its aliases must still apply (issue #172).
  if (isComponentRoot(out)) {
    return { value: normalizeNode(out, 'spec', warnings), warnings }
  }
  if (Array.isArray(out.items)) {
    out.items = out.items.map((item, index) => normalizeNode(item, `items[${index}]`, warnings))
  }
  return { value: out, warnings }
}
