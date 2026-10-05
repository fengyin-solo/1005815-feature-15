// 泵组检修期限口径：按检修类别配置检修周期、允许顺延天数与计划工期上限。
// 页面不做业务判断，所有口径计算集中在这里，local-service / pumpmaint-service 统一调用。

export const PUMPMAINT_KEY = 'pumpmaint'

// 检修记录只能单向走：待开工 → 检修中 → 已完工，没有往回的动作。
export const MAINT_STATUSES = ['待开工', '检修中', '已完工'] as const
export type MaintStatus = (typeof MAINT_STATUSES)[number]
export const MAINT_START_ACTION = '提交开工'
export const MAINT_FINISH_ACTION = '确认完工'
const MAINT_ACTION_FLOW: Record<string, MaintStatus> = {
  [MAINT_START_ACTION]: '检修中',
  [MAINT_FINISH_ACTION]: '已完工',
}

// 泵组检修表的字段口径（同时驱动通用 CSV 导出与列展示）。
export const MAINT_FIELDS = [
  '检修编号',
  '泵组编号',
  '检修类别',
  '检修班组',
  '计划开工',
  '计划工期',
  '计划完工',
  '完成日期',
  '更换部件',
  '检修状态',
]

export type MaintCategoryRule = {
  /** 检修类别名称，如 日常保养 / 定期检修 / 大修 */
  category: string
  /** 检修周期（天）：同一台泵同一类别相邻两次检修的基准间隔 */
  cycleDays: number
  /** 允许顺延天数：计划完工后宽限这么多天不算超期 */
  graceDays: number
  /** 计划工期上限（天）：登记的计划工期超过它不允许落库 */
  maxDurationDays: number
}

export type MaintPolicy = {
  /** 口径版本，每次保存 +1，便于追溯是按哪版口径判的 */
  version: number
  updatedAt: string
  rules: MaintCategoryRule[]
}

export const MAINT_POLICY_KV_KEY = 'pumpmaint:policy'

// 现行默认口径：班长不再各自拿捏，登记/超期都按这张表走。
export const DEFAULT_MAINT_POLICY: MaintPolicy = {
  version: 1,
  updatedAt: '',
  rules: [
    { category: '日常保养', cycleDays: 90, graceDays: 7, maxDurationDays: 3 },
    { category: '定期检修', cycleDays: 180, graceDays: 15, maxDurationDays: 7 },
    { category: '大修', cycleDays: 365, graceDays: 30, maxDurationDays: 30 },
  ],
}

// 登记提交上来的草稿（计划完工由开工日期+工期推导，不接受手填）。
export type MaintDraft = {
  检修编号: string
  泵组编号: string
  检修类别: string
  检修班组: string
  计划开工: string
  计划工期: number
}

export type ValidationResult = { ok: boolean; message: string }

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isValidISODate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) {
    return false
  }
  const parsed = parseISODate(value)
  return parsed !== null && toISODate(parsed) === value
}

export function toISODate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function todayISO(): string {
  return toISODate(new Date())
}

export function parseISODate(value: string): Date | null {
  const match = ISO_DATE_RE.exec(value.trim())
  if (!match) {
    return null
  }
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return Number.isNaN(date.getTime()) ? null : date
}

export function addDaysISO(iso: string, days: number): string {
  const date = parseISODate(iso)
  if (!date) {
    return iso
  }
  date.setDate(date.getDate() + days)
  return toISODate(date)
}

/** to - from 的整天差；任一日期非法返回 null。 */
export function diffDays(fromISO: string, toISO: string): number | null {
  const from = parseISODate(fromISO)
  const to = parseISODate(toISO)
  if (!from || !to) {
    return null
  }
  const ms = to.getTime() - from.getTime()
  return Math.round(ms / 86_400_000)
}

export function ruleFor(policy: MaintPolicy, category: string): MaintCategoryRule | undefined {
  return policy.rules.find((rule) => rule.category === category)
}

/** 该类别一年该检修几次：365 / 周期，保留一位小数。 */
export function annualTimes(rule: MaintCategoryRule): number {
  return Math.round((365 / rule.cycleDays) * 10) / 10
}

/** 动作是否合法、目标状态是什么。 */
export function maintActionTarget(action: string): MaintStatus | null {
  return MAINT_ACTION_FLOW[action] ?? null
}

/**
 * 单向流转校验：只有 待开工→检修中、检修中→已完工 两类，
 * 已完工或跨阶段（如待开工直接完工）一律拒绝。
 */
export function validateMaintTransition(status: string, action: string): ValidationResult {
  const target = maintActionTarget(action)
  if (!target) {
    return { ok: false, message: `泵组检修没有登记「${action}」这个动作` }
  }
  if (status === '已完工') {
    return { ok: false, message: '该检修已完工，记录只能单向流转，不能再操作' }
  }
  if (action === MAINT_START_ACTION && status !== '待开工') {
    return { ok: false, message: `只有「待开工」的检修能提交开工，当前是「${status}」` }
  }
  if (action === MAINT_FINISH_ACTION && status !== '检修中') {
    return { ok: false, message: `只有「检修中」的检修能确认完工，当前是「${status}」` }
  }
  return { ok: true, message: '' }
}

/** 两个[起, 止]日期区间是否叠在一起（起止日当天也算占用，按闭区间判）。 */
export function rangesOverlap(
  startA: string,
  endA: string,
  startB: string,
  endB: string,
): boolean {
  return startA <= endB && startB <= endA
}

/**
 * 超期判定：在挂记录（待开工/检修中）计划完工日 + 允许顺延天数 仍早于今天即超期。
 * 返回超期天数；0 表示未超期。日期非法时不判超期。
 */
export function overdueDays(
  plannedFinish: string,
  category: string,
  policy: MaintPolicy,
  today: string = todayISO(),
): number {
  const rule = ruleFor(policy, category)
  if (!rule) {
    return 0
  }
  const delta = diffDays(addDaysISO(plannedFinish, rule.graceDays), today)
  return delta !== null && delta > 0 ? delta : 0
}

/** 口径保存前的合法性校验：周期/顺延/工期上限都得是正整数，且工期上限至少为 1。 */
export function validatePolicyRules(rules: MaintCategoryRule[]): ValidationResult {
  if (rules.length === 0) {
    return { ok: false, message: '至少要保留一类检修口径' }
  }
  const names = new Set<string>()
  for (const rule of rules) {
    const category = rule.category.trim()
    if (!category) {
      return { ok: false, message: '检修类别名称不能为空' }
    }
    if (names.has(category)) {
      return { ok: false, message: `检修类别「${category}」重复了` }
    }
    names.add(category)
    if (!Number.isInteger(rule.cycleDays) || rule.cycleDays <= 0) {
      return { ok: false, message: `「${category}」的检修周期必须是正整数天数` }
    }
    if (!Number.isInteger(rule.graceDays) || rule.graceDays < 0) {
      return { ok: false, message: `「${category}」的允许顺延天数必须是不小于 0 的整数` }
    }
    if (!Number.isInteger(rule.maxDurationDays) || rule.maxDurationDays <= 0) {
      return { ok: false, message: `「${category}」的计划工期上限必须是正整数天数` }
    }
  }
  return { ok: true, message: '' }
}
