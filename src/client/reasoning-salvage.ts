/**
 * 从思考块抢救界面（salvage）。
 *
 * 模型的退化形态：把**完整的 `dsh-ui` 围栏写进 reasoning 块**，然后在正文里不输出
 * 任何内容就结束本轮。`fence-feedback` 会在同一轮内最多纠正两次，但真实会话里出现过
 * 「收到纠正后逐字节重放同一段 reasoning」——纠正消息确实进了上下文（`inputTokens`
 * 从 189 涨到 1016），模型仍然零 token 正文。那种情况下回合内任何重试都不会有结果。
 *
 * 这个兜底不依赖模型：宿主的 ChatSnapshot 把 reasoning 也作为 assistant block 暴露，
 * 所以客户端能确定性读到那份围栏正文并解析出 spec。当**正文里没有可渲染的围栏**、
 * 而 reasoning 里有完整且可渲染的一份时，把同一份 spec 发布到会话面板 dock（并在顶部
 * 标注来源），用户至少不会丢界面。
 *
 * 刻意保守，避免与正常渲染抢位置：
 * - 只在 assistant step `settled` / `interrupted` 之后动作，流式中绝不触发；
 * - 正文里只要有一份能渲染的围栏就完全不动（那是正常路径的产物）；
 * - 面板里已经有内容时不覆盖（那是模型或用户自己发布的）；
 * - 每个 assistant step 只评估一次，发布后按 `session:nodeKey` 记录，刷新回来也不会重复。
 *
 * @module @changfenhuang/dsh-genui/client/reasoning-salvage
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AssistantBlock, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { resolveFence } from '../shared/fence-resolve.ts'
import { t } from './i18n/index.ts'
import { getPanelSpec, requestPanelExpand, setLocalPanel } from './panel-store.ts'
import { resolveViewedSessionId } from './session-resolver.ts'
import { sourceFencesOfAssistant, sourceFencesOfReasoning, type SourceFence } from './source-fence.ts'
import type { GenuiSpec } from './spec.ts'

/** 围栏语言：只有这一种会被抢救（svg 围栏不在此列）。 */
const FENCE_LANG = 'dsh-ui'

/** Assistant step 的状态（宿主 ChatSnapshot 的子集）。 */
export type SalvageStatus = 'running' | 'settled' | 'interrupted'

/** 一次抢救的产物：已经带上来源标注、可直接发布的面板 spec。 */
export interface SalvagePlan {
  /** 面板标题。 */
  readonly title: string
  /** 已标注来源、可直接 `setLocalPanel` 的 spec。 */
  readonly spec: GenuiSpec
}

/** 最后一份**能渲染**的 dsh-ui 围栏（从后往前找，最近的一份优先）。 */
function renderableFenceOf(fences: readonly SourceFence[]): { spec: GenuiSpec; raw: string } | null {
  for (let index = fences.length - 1; index >= 0; index -= 1) {
    const fence = fences[index]
    if (fence === undefined) continue
    if (fence.lang !== FENCE_LANG) continue
    // 围栏开头那一行还没写完 → 流式半截，不是一个可用的正文。
    if (!fence.openingLineComplete) continue
    const resolution = resolveFence(fence.value, { settled: true })
    if (resolution.spec !== null) return { spec: resolution.spec, raw: fence.value }
  }
  return null
}

/** 在抢救出来的 spec 顶部加一条来源标注（面板里要能看出这不是模型正常发的）。 */
function withProvenance(spec: GenuiSpec): GenuiSpec {
  return {
    ...spec,
    items: [
      { type: 'callout', tone: 'warning', title: t('salvage.title'), content: t('salvage.body') },
      ...spec.items,
    ],
  }
}

/**
 * 纯决策：这一轮 assistant step 是否该被抢救，以及发布什么。
 *
 * @param input - 状态、内容块、以及两个去重/让位信号。
 * @returns 需要发布的 spec；不该动作时返回 null。
 */
export function planReasoningSalvage(input: {
  readonly status: SalvageStatus | undefined
  readonly blocks: readonly AssistantBlock[]
  readonly alreadySalvaged: boolean
  readonly panelTaken: boolean
}): SalvagePlan | null {
  if (input.alreadySalvaged || input.panelTaken) return null
  if (input.status !== 'settled' && input.status !== 'interrupted') return null
  // 正文里有能渲染的围栏 → 用户已经看到界面（正常路径），完全不动。
  if (renderableFenceOf(sourceFencesOfAssistant(input.blocks)) !== null) return null
  const salvaged = renderableFenceOf(sourceFencesOfReasoning(input.blocks))
  if (salvaged === null) return null
  return {
    title: typeof salvaged.spec.title === 'string' && salvaged.spec.title !== ''
      ? salvaged.spec.title
      : t('salvage.title'),
    spec: withProvenance(salvaged.spec),
  }
}

/** 读 `uiConversation` —— 可选服务，缺了就是没有抢救能力，绝不影响其余渲染。 */
function chatSourceOf(ctx: Context, sessionId: SessionId): { getSnapshot: () => ChatSnapshot | undefined } | undefined {
  try {
    if (typeof ctx.get !== 'function') return undefined
    const conversation = ctx.get('uiConversation', false) as Context['uiConversation'] | undefined
    const source = conversation?.binding(sessionId).target('chat')
    if (source === undefined) return undefined
    return {
      getSnapshot: () => {
        try {
          return source.getSnapshot()
        } catch {
          return undefined
        }
      },
    }
  } catch {
    return undefined
  }
}

/** 轮询间隔：与 DOM 通道的 sweep 同量级，抢救不需要更快。 */
const POLL_MS = 1000

/**
 * 安装抢救兜底。每 `POLL_MS` 检查一次当前会话**最后一个已结束**的 assistant step。
 *
 * @param ctx - 客户端 cordis 上下文。
 * @returns 卸载函数。
 */
export function installReasoningSalvage(ctx: Context): () => void {
  /** 已经评估过的 step（`session:nodeKey`）——一个 step 只解析一次。 */
  const considered = new Set<string>()

  const evaluate = (): void => {
    let sessionId: SessionId | undefined
    try {
      sessionId = resolveViewedSessionId(ctx.sessions.list.getSnapshot())
    } catch {
      return
    }
    if (sessionId === undefined) return
    const chat = chatSourceOf(ctx, sessionId)?.getSnapshot()
    if (chat === undefined) return
    let best: { key: string; status: SalvageStatus | undefined; blocks: readonly AssistantBlock[]; order: number } | undefined
    for (const node of chat.nodes.values()) {
      if (node.kind !== 'assistant-step') continue
      const data = node.data as { status?: SalvageStatus; turn?: number; step?: number; blocks?: readonly AssistantBlock[] }
      if (data.status === 'running') continue
      const order = (data.turn ?? 0) * 1000 + (data.step ?? 0)
      if (best === undefined || order >= best.order) {
        best = { key: node.key, status: data.status, blocks: data.blocks ?? [], order }
      }
    }
    if (best === undefined) return
    const marker = `${String(sessionId)}:${best.key}`
    if (considered.has(marker)) return
    considered.add(marker)
    let panelTaken = false
    try {
      panelTaken = getPanelSpec(sessionId) !== null
    } catch {
      panelTaken = true
    }
    const plan = planReasoningSalvage({
      status: best.status,
      blocks: best.blocks,
      alreadySalvaged: false,
      panelTaken,
    })
    if (plan === null) return
    try {
      setLocalPanel(sessionId, plan.spec)
      requestPanelExpand(sessionId)
    } catch (error) {
      console.warn(`[genui] reasoning salvage publish failed (${error instanceof Error ? error.message : String(error)})`)
      return
    }
    console.info(`[genui] recovered a reasoning-only fence from ${best.key} into the session panel`)
  }

  const timer = globalThis.setInterval(evaluate, POLL_MS)
  return () => {
    globalThis.clearInterval(timer)
  }
}
