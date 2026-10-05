import { filterRows } from '@/api/local-service'
import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, PageResult } from '@/data/types'

// 泵组检修期限口径集中在这里：检修类别 → 检修周期 + 允许顺延天数。
// 页面与通用动作不做业务判断，全部走本文件的函数。

export const MODULE_KEY = 'pumpmaint'

/** 泵组检修状态只能单向：待开工 → 检修中 → 已完工。 */
export const MAINT_STATUSES = ['待开工', '检修中', '已完工'] as const
const FINAL_STATUS = '已完工'

/** 开工动作允许的来源状态。 */
const START_FROM = '待开工'
/** 完工动作允许的来源状态。 */
const FINISH_FROM = '检修中'

export type MaintCategory = {
  /** 检修类别名称，如「日常保养」。 */
  name: string
  /** 检修周期（天）：也是该类别一次检修的标准工期口径。 */
  cycleDays: number
  /** 允许顺延的天数：超期宽限与工期上浮都取这个值。 */
  graceDays: number
}

export type MaintDraft = {
  检修编号: string
  泵组编号: string
  检修类别: string
  检修班组: string
  计划开工日期: string
  计划完工日期: string
}

export type HistoryVersion = {
  version: number
  changedAt: string
  检修编号: string
  泵组编号: string
  检修类别: string
  检修班组: string
  计划开工日期: string
  计划完工日期: string
  status: string
}

const RULES_STORAGE_KEY = 'drainage-pump:pumpmaint-rules'
const DAY_MS = 24 * 60 * 60 * 1000

/** 默认期限口径，后续可在页面上调整并持久化。 */
const DEFAULT_CATEGORIES: MaintCategory[] = [
  { name: '日常保养', cycleDays: 30, graceDays: 3 },
  { name: '常规检修', cycleDays: 90, graceDays: 7 },
  { name: '大修', cycleDays: 365, graceDays: 15 },
]

// ---------- 日期与工期工具 ----------

function parseDate(value: string): Date | null {
  if (!value) {
    return null
  }
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!matched) {
    return null
  }
  const date = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

/** 工期按首尾两天都算的自然日天数（开工当天即第 1 天）。 */
export function spanDays(start: string, end: string): number | null {
  const s = parseDate(start)
  const e = parseDate(end)
  if (!s || !e || e.getTime() < s.getTime()) {
    return null
  }
  return Math.round((e.getTime() - s.getTime()) / DAY_MS) + 1
}

/** 该类别计划工期允许的上限天数 = 检修周期 + 允许顺延天数。 */
export function durationLimit(rule: MaintCategory): number {
  return rule.cycleDays + rule.graceDays
}

/** 按周期折算的一年检修参考次数。 */
export function timesPerYear(rule: MaintCategory): number {
  return Math.max(1, Math.floor(365 / rule.cycleDays))
}

function todayText(): string {
  return toDateText(new Date())
}

function nowText(): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const now = new Date()
  return `${toDateText(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

function toDateText(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

// ---------- 期限口径（检修类别规则） ----------

function cloneRules(rules: MaintCategory[]): MaintCategory[] {
  return rules.map((rule) => ({ ...rule }))
}

export function listCategories(): MaintCategory[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return cloneRules(DEFAULT_CATEGORIES)
  }
  const raw = window.localStorage.getItem(RULES_STORAGE_KEY)
  if (!raw) {
    return cloneRules(DEFAULT_CATEGORIES)
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return cloneRules(DEFAULT_CATEGORIES)
    }
    const rules = parsed
      .map((item) => normalizeCategory(item))
      .filter((item): item is MaintCategory => item !== null)
    return rules.length ? rules : cloneRules(DEFAULT_CATEGORIES)
  } catch {
    return cloneRules(DEFAULT_CATEGORIES)
  }
}

function normalizeCategory(item: unknown): MaintCategory | null {
  if (typeof item !== 'object' || item === null) {
    return null
  }
  const record = item as Record<string, unknown>
  const name = String(record.name ?? '').trim()
  const cycleDays = Number(record.cycleDays)
  const graceDays = Number(record.graceDays)
  if (!name || !Number.isInteger(cycleDays) || cycleDays <= 0) {
    return null
  }
  if (!Number.isInteger(graceDays) || graceDays < 0) {
    return null
  }
  return { name, cycleDays, graceDays }
}

export function findCategory(name: string): MaintCategory | undefined {
  return listCategories().find((rule) => rule.name === name)
}

export function saveCategories(input: MaintCategory[]): ActionResult {
  const rules: MaintCategory[] = []
  const names = new Set<string>()
  for (const raw of input) {
    const rule = normalizeCategory(raw)
    if (!rule) {
      return { ok: false, message: '每条类别都要填名称、正整数的检修周期和不小于 0 的顺延天数' }
    }
    if (names.has(rule.name)) {
      return { ok: false, message: `检修类别「${rule.name}」重复了` }
    }
    names.add(rule.name)
    rules.push(rule)
  }
  if (!rules.length) {
    return { ok: false, message: '至少要保留一条检修类别口径' }
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(RULES_STORAGE_KEY, JSON.stringify(rules))
  }
  // 口径调整后，正在挂着的检修记录按新口径重算一次超期标记。
  recalcOverdue()
  return { ok: true, message: `期限口径已保存，已按新口径重算 ${rules.length} 个类别的超期标记` }
}

export function resetCategories(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(RULES_STORAGE_KEY)
  }
  recalcOverdue()
}

// ---------- 超期计算 ----------

function asText(row: EntryRow, field: string): string {
  const value = row[field]
  return value === undefined || value === null ? '' : String(value)
}

/** 历史版本是唯一的数组型字段，在存储边界以 unknown 读出后再收窄。 */
function readHistory(row: EntryRow): HistoryVersion[] {
  const value = row['历史版本'] as unknown
  return Array.isArray(value) ? (value as HistoryVersion[]) : []
}

/** 一条挂着的检修记录相对今天超期多少天；未超期或已完工返回 0。 */
export function overdueDaysOf(row: EntryRow, today: Date = new Date()): number {
  if (String(row.status) === FINAL_STATUS) {
    return 0
  }
  const rule = findCategory(asText(row, '检修类别'))
  if (!rule) {
    return 0
  }
  const plannedEnd = parseDate(asText(row, '计划完工日期'))
  if (!plannedEnd) {
    return 0
  }
  // 计划完工日 + 允许顺延天数 之前都算按期；超过的整天数才是超期天数。
  const deadline = new Date(plannedEnd.getTime() + rule.graceDays * DAY_MS)
  const diff = Math.floor((getTime(today) - deadline.getTime()) / DAY_MS)
  return diff > 0 ? diff : 0
}

function getTime(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function applyOverdueMark(row: EntryRow, today: Date = new Date()): EntryRow {
  const days = overdueDaysOf(row, today)
  return {
    ...row,
    超期天数: days,
    超期: days > 0 ? '超期' : '正常',
    abnormal: days > 0,
  }
}

/**
 * 按当前口径重算所有「挂着」（未完工）记录的超期标记；
 * 已完工记录不参与重算，保持终态。口径调整、登记、开工后都会调用。
 */
export function recalcOverdue(): { checked: number; overdue: number } {
  const rows = listRows(MODULE_KEY)
  const today = new Date()
  let overdue = 0
  const next = rows.map((row) => {
    if (String(row.status) === FINAL_STATUS) {
      return row
    }
    const updated = applyOverdueMark(row, today)
    if (Number(updated.超期天数) > 0) {
      overdue += 1
    }
    return updated
  })
  saveRows(MODULE_KEY, next)
  return { checked: next.filter((row) => String(row.status) !== FINAL_STATUS).length, overdue }
}

// ---------- 查询 ----------

export function listMaint(filters: Record<string, string> = {}): PageResult {
  const today = new Date()
  const rows = listRows(MODULE_KEY).map((row) =>
    String(row.status) === FINAL_STATUS ? row : applyOverdueMark(row, today),
  )
  // 未完工排前面，并按计划完工日期升序，超期的自然顶到最前。
  rows.sort((a, b) => {
    const aDone = String(a.status) === FINAL_STATUS ? 1 : 0
    const bDone = String(b.status) === FINAL_STATUS ? 1 : 0
    if (aDone !== bDone) {
      return aDone - bDone
    }
    return asText(a, '计划完工日期').localeCompare(asText(b, '计划完工日期'))
  })
  const matched = filterRows(rows, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// ---------- 冲突检测：同一台泵、时间窗重叠 ----------

function overlaps(a: DateWindow, b: DateWindow): boolean {
  return !(b.计划完工日期 < a.计划开工日期 || b.计划开工日期 > a.计划完工日期)
}

// ---------- 冲突检测：同一台泵、时间窗重叠 ----------

type DateWindow = { 计划开工日期: string; 计划完工日期: string }

/**
 * 找同一台泵上时间窗叠在一起的、仍挂着的检修安排。
 * 被覆盖的旧版本不再占位，因此排除被覆盖记录自身（excludeId）；
 * 已完工记录也不再占用泵组档期。
 */
function findConflict(draft: MaintDraft, excludeId: number | null): EntryRow | null {
  return (
    listRows(MODULE_KEY).find((row) => {
      if (excludeId !== null && Number(row.id) === excludeId) {
        return false
      }
      if (String(row.status) === FINAL_STATUS) {
        return false
      }
      if (asText(row, '泵组编号') !== draft.泵组编号) {
        return false
      }
      const other: DateWindow = {
        计划开工日期: asText(row, '计划开工日期'),
        计划完工日期: asText(row, '计划完工日期'),
      }
      return overlaps(draft, other)
    }) ?? null
  )
}

// ---------- 登记 / 覆盖 ----------

function validateDraft(draft: MaintDraft): ActionResult | null {
  if (!draft.检修编号.trim()) {
    return { ok: false, message: '检修编号不能为空' }
  }
  if (!draft.泵组编号.trim()) {
    return { ok: false, message: '泵组编号不能为空' }
  }
  if (!draft.检修班组.trim()) {
    return { ok: false, message: '检修班组不能为空' }
  }
  const rule = findCategory(draft.检修类别)
  if (!rule) {
    return {
      ok: false,
      message: `检修类别「${draft.检修类别}」不在期限口径里，请先在「期限口径」中维护`,
    }
  }
  const days = spanDays(draft.计划开工日期, draft.计划完工日期)
  if (days === null) {
    return { ok: false, message: '计划开工/完工日期必须是合法日期，且完工日期不能早于开工日期' }
  }
  // 口径一：计划工期超过「周期 + 允许顺延」上限，不允许落库，退回时写清超了多少天。
  const limit = durationLimit(rule)
  if (days > limit) {
    return {
      ok: false,
      message:
        `「${rule.name}」计划工期上限为 ${limit} 天（周期 ${rule.cycleDays} 天 + 允许顺延 ${rule.graceDays} 天），` +
        `本次填报 ${days} 天，超出 ${days - limit} 天，不允许落库，请压缩工期或重排日期`,
    }
  }
  return null
}

/**
 * 登记一条检修安排，或对「检修编号 + 泵组编号」这一唯一对做最新版覆盖。
 * 旧版整体快照压入历史版本留查；工期超上限、时间窗冲突一律不入库。
 */
export function submitMaint(draft: MaintDraft, id?: number): ActionResult {
  const normalized: MaintDraft = {
    检修编号: draft.检修编号.trim(),
    泵组编号: draft.泵组编号.trim(),
    检修类别: draft.检修类别,
    检修班组: draft.检修班组.trim(),
    计划开工日期: draft.计划开工日期,
    计划完工日期: draft.计划完工日期,
  }
  const invalid = validateDraft(normalized)
  if (invalid) {
    return invalid
  }

  const rows = listRows(MODULE_KEY)
  const idIndex = typeof id === 'number' ? rows.findIndex((row) => Number(row.id) === id) : -1
  const samePairIndex = rows.findIndex(
    (row) =>
      asText(row, '检修编号') === normalized.检修编号 &&
      asText(row, '泵组编号') === normalized.泵组编号,
  )
  // 定位要落库的记录：传了 id 按 id 找；没传 id 时，同一唯一对的重复提交即覆盖目标。
  const editingIndex = idIndex >= 0 ? idIndex : samePairIndex

  // 改期时若把编号对改成了别的记录已占用的一对，拒绝。
  if (idIndex >= 0 && samePairIndex >= 0 && samePairIndex !== idIndex) {
    return {
      ok: false,
      message: `检修编号「${normalized.检修编号}」与泵组编号「${normalized.泵组编号}」这一对已被其它记录占用`,
    }
  }

  // 完工是终态，单向流转，不允许再改期覆盖。
  if (editingIndex >= 0 && String(rows[editingIndex].status) === FINAL_STATUS) {
    return { ok: false, message: '该检修已完工，状态单向不可回退，如需重新检修请另立检修编号' }
  }

  // 口径二：同一台泵两条安排时间叠在一起，后来的这条先解决冲突才让存。
  const excludeId = editingIndex >= 0 ? Number(rows[editingIndex].id) : null
  const conflict = findConflict(normalized, excludeId)
  if (conflict) {
    return {
      ok: false,
      message:
        `泵组「${normalized.泵组编号}」已有检修安排「${asText(conflict, '检修编号')}」` +
        `（${asText(conflict, '计划开工日期')} ~ ${asText(conflict, '计划完工日期')}，状态 ${String(
          conflict.status,
        )}）与本次时间窗重叠，` +
        `请先调整日期解决冲突后再提交`,
    }
  }

  const now = nowText()
  if (editingIndex >= 0) {
    const current = rows[editingIndex]
    const history = readHistory(current)
    const previousVersion = Number(current.版本) || 1
    const archived: HistoryVersion = {
      version: previousVersion,
      changedAt: asText(current, '更新时间') || now,
      检修编号: asText(current, '检修编号'),
      泵组编号: asText(current, '泵组编号'),
      检修类别: asText(current, '检修类别'),
      检修班组: asText(current, '检修班组'),
      计划开工日期: asText(current, '计划开工日期'),
      计划完工日期: asText(current, '计划完工日期'),
      status: String(current.status),
    }
    const updated: EntryRow = applyOverdueMark({
      ...current,
      ...normalized,
      版本: previousVersion + 1,
      更新时间: now,
      ...({ 历史版本: [archived, ...history] } as object),
    })
    const next = [...rows]
    next[editingIndex] = updated
    saveRows(MODULE_KEY, next)
    return {
      ok: true,
      message: `已按最新版覆盖保存（第 ${previousVersion + 1} 版），旧版已留档备查`,
    }
  }

  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const created: EntryRow = applyOverdueMark({
    id: nextId,
    status: '待开工',
    pending: true,
    abnormal: false,
    ...normalized,
    版本: 1,
    更新时间: now,
    完成日期: '',
    更换部件: '',
    ...({ 历史版本: [] } as object),
  })
  saveRows(MODULE_KEY, [...rows, created])
  return { ok: true, message: '检修安排已登记落库' }
}

// ---------- 状态单向流转 ----------

/** 待开工 → 检修中。 */
export function startMaint(id: number): ActionResult {
  const rows = listRows(MODULE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的泵组检修记录` }
  }
  const current = rows[index]
  const status = String(current.status)
  if (status === FINISH_FROM) {
    return { ok: false, message: '该检修已在检修中，不用重复开工' }
  }
  if (status === FINAL_STATUS) {
    return { ok: false, message: '该检修已完工，状态单向不可回退' }
  }
  if (status !== START_FROM) {
    return { ok: false, message: `只有「${START_FROM}」的检修才能开工，当前状态「${status}」` }
  }
  const updated: EntryRow = { ...current, status: FINISH_FROM, pending: true }
  const next = [...rows]
  next[index] = applyOverdueMark(updated)
  saveRows(MODULE_KEY, next)
  return { ok: true, message: '已提交开工，当前状态「检修中」' }
}

/** 检修中 → 已完工，必须回填完成日期与更换部件。 */
export function finishMaint(
  id: number,
  payload: { 完成日期: string; 更换部件: string },
): ActionResult {
  const finishDate = payload.完成日期.trim()
  const parts = payload.更换部件.trim()
  if (!parseDate(finishDate)) {
    return { ok: false, message: '完工必须回填合法的完成日期' }
  }
  if (!parts) {
    return { ok: false, message: '完工必须回填本次更换的部件' }
  }
  const rows = listRows(MODULE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的泵组检修记录` }
  }
  const current = rows[index]
  const status = String(current.status)
  if (status === FINAL_STATUS) {
    return { ok: false, message: '该检修已完工，状态单向不可回退' }
  }
  if (status !== FINISH_FROM) {
    return { ok: false, message: `只有「${FINISH_FROM}」的检修才能确认完工，当前状态「${status}」` }
  }
  const updated: EntryRow = {
    ...current,
    status: FINAL_STATUS,
    pending: false,
    abnormal: false,
    完成日期: finishDate,
    更换部件: parts,
    超期: '正常',
    超期天数: 0,
  }
  const next = [...rows]
  next[index] = updated
  saveRows(MODULE_KEY, next)
  return { ok: true, message: `已确认完工，完成日期 ${finishDate}，更换部件已回填` }
}

// ---------- 历史版本 ----------

export function historyOf(row: EntryRow): HistoryVersion[] {
  const history = readHistory(row)
  const current: HistoryVersion = {
    version: Number(row.版本) || 1,
    changedAt: asText(row, '更新时间'),
    检修编号: asText(row, '检修编号'),
    泵组编号: asText(row, '泵组编号'),
    检修类别: asText(row, '检修类别'),
    检修班组: asText(row, '检修班组'),
    计划开工日期: asText(row, '计划开工日期'),
    计划完工日期: asText(row, '计划完工日期'),
    status: String(row.status),
  }
  return [current, ...history]
}

// ---------- 统计 ----------

export function maintStats(rows: EntryRow[]): { label: string; value: number | string }[] {
  const month = todayText().slice(0, 7)
  return [
    { label: '待开工检修', value: rows.filter((row) => String(row.status) === '待开工').length },
    { label: '检修中泵组', value: rows.filter((row) => String(row.status) === '检修中').length },
    { label: '超期未完工', value: rows.filter((row) => Number(row.超期天数) > 0).length },
    {
      label: '本月完工数',
      value: rows.filter(
        (row) => String(row.status) === FINAL_STATUS && asText(row, '完成日期').startsWith(month),
      ).length,
    },
  ]
}
