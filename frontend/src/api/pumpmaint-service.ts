import { getKv, listRows, nextRowId, saveRows, setKv } from '@/data/local-store'
import type { ActionResult, EntryRow, PageResult } from '@/data/types'
import {
  addDaysISO,
  annualTimes,
  DEFAULT_MAINT_POLICY,
  diffDays,
  isValidISODate,
  MAINT_FIELDS,
  MAINT_FINISH_ACTION,
  MAINT_POLICY_KV_KEY,
  MAINT_START_ACTION,
  MAINT_STATUSES,
  overdueDays as calcOverdueDays,
  rangesOverlap,
  ruleFor,
  todayISO,
  validateMaintTransition,
  validatePolicyRules,
  type MaintCategoryRule,
  type MaintDraft,
  type MaintPolicy,
  type MaintStatus,
} from '@/domain/pumpmaint'

export type MaintRow = EntryRow

type FinishPayload = {
  finishDate: string
  replacedParts: string
}

type UpsertResult = ActionResult & { id?: number }

export type MaintSummary = {
  pending: number
  running: number
  overdue: number
  finishedThisMonth: number
}

export type MaintSuggestion = {
  cycleDays: number
  annualTimes: number
  lastFinishDate: string
  suggestedStart: string
}

// ---- 期限口径 ---------------------------------------------------------------

export function getPolicy(): MaintPolicy {
  const policy = getKv<MaintPolicy>(MAINT_POLICY_KV_KEY, DEFAULT_MAINT_POLICY)
  return policy && Array.isArray(policy.rules) && policy.rules.length > 0
    ? policy
    : { ...DEFAULT_MAINT_POLICY }
}

/** 保存新口径，随后对所有在挂记录按新口径重算一次超期标记。 */
export function savePolicy(rules: MaintCategoryRule[]): ActionResult & { policy?: MaintPolicy } {
  const checked = validatePolicyRules(rules)
  if (!checked.ok) {
    return { ok: false, message: checked.message }
  }
  const policy: MaintPolicy = {
    version: getPolicy().version + 1,
    updatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
    rules: rules.map((rule) => ({
      category: rule.category.trim(),
      cycleDays: rule.cycleDays,
      graceDays: rule.graceDays,
      maxDurationDays: rule.maxDurationDays,
    })),
  }
  setKv(MAINT_POLICY_KV_KEY, policy)
  const recalculated = recalcOverdue()
  return {
    ok: true,
    policy,
    message: `口径已保存为第 ${policy.version} 版，已按新口径重算 ${recalculated} 条在挂记录的超期标记`,
  }
}

// ---- 行内口径字段 -----------------------------------------------------------

function statusOf(row: MaintRow): MaintStatus {
  return MAINT_STATUSES.includes(row.status as MaintStatus) ? (row.status as MaintStatus) : '待开工'
}

function isHanging(row: MaintRow): boolean {
  return statusOf(row) !== '已完工'
}

function isLatest(row: MaintRow): boolean {
  return row.isLatest !== false
}

/** 按当前口径重算一条记录的派生标记（计划完工、超期、异常位），返回是否有改动。 */
function applyDerivedFlags(row: MaintRow, policy: MaintPolicy, today: string): boolean {
  const plannedFinish = addDaysISO(String(row['计划开工'] ?? ''), Number(row['计划工期']) - 1)
  const days = isHanging(row)
    ? calcOverdueDays(String(row['计划完工'] ?? plannedFinish), String(row['检修类别'] ?? ''), policy, today)
    : 0
  let changed = false
  if (String(row['计划完工'] ?? '') !== plannedFinish) {
    row['计划完工'] = plannedFinish
    changed = true
  }
  if (Number(row['_overdueDays'] ?? 0) !== days) {
    row['_overdueDays'] = days
    changed = true
  }
  if (Boolean(row['_overdue']) !== (days > 0)) {
    row['_overdue'] = days > 0
    changed = true
  }
  if (Boolean(row.abnormal) !== (days > 0)) {
    row.abnormal = days > 0
    changed = true
  }
  return changed
}

/**
 * 冲突标记：同一台泵的两条在挂最新版检修，时间区间叠在一起时，
 * 后来登记（id 更大）的那条带 _conflict，先把冲突解决了才允许再存新安排。
 */
function markConflicts(rows: MaintRow[]): boolean {
  let changed = false
  for (const row of rows) {
    if (Boolean(row['_conflict'])) {
      row['_conflict'] = false
      changed = true
    }
  }
  const active = rows
    .filter((row) => isLatest(row) && isHanging(row))
    .sort((a, b) => Number(a.id) - Number(b.id))
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const earlier = active[i]
      const later = active[j]
      if (String(earlier['泵组编号']) !== String(later['泵组编号'])) {
        continue
      }
      const overlap = rangesOverlap(
        String(earlier['计划开工']),
        String(earlier['计划完工']),
        String(later['计划开工']),
        String(later['计划完工']),
      )
      if (overlap && !later['_conflict']) {
        later['_conflict'] = true
        changed = true
      }
    }
  }
  return changed
}

/** 口径定下来后（以及每次读取时兜底）对在挂记录按新口径重算超期标记。 */
export function recalcOverdue(): number {
  const policy = getPolicy()
  const rows = listRows('pumpmaint').map((row) => ({ ...row }))
  const today = todayISO()
  let touched = 0
  for (const row of rows) {
    if (applyDerivedFlags(row, policy, today)) {
      touched += 1
    }
  }
  markConflicts(rows)
  saveRows('pumpmaint', rows)
  return touched
}

// ---- 登记 / 版本覆盖 --------------------------------------------------------

function findLatestPair(rows: MaintRow[], code: string, pump: string): MaintRow | undefined {
  return rows.find(
    (row) =>
      isLatest(row) &&
      String(row['检修编号']).trim() === code &&
      String(row['泵组编号']).trim() === pump,
  )
}

/**
 * 登记（或重复提交覆盖）一条检修安排：
 * 1. 基础字段必填、日期/工期合法；
 * 2. 计划工期超过该类别上限不允许落库，退回时写明超了多少天；
 * 3. 同一台泵与在挂安排时间叠加，后来的这条必须先解决冲突才让存。
 * 4. 检修编号+泵组编号是唯一一对：命中即按最新版覆盖，旧版归档备查。
 */
export function upsertMaintEntry(draft: MaintDraft): UpsertResult {
  const code = draft.检修编号.trim()
  const pump = draft.泵组编号.trim()
  const category = draft.检修类别.trim()
  const team = draft.检修班组.trim()
  const start = draft.计划开工
  const duration = Number(draft.计划工期)

  if (!code || !pump || !category || !team) {
    return { ok: false, message: '检修编号、泵组编号、检修类别、检修班组均为必填项' }
  }
  if (!isValidISODate(start)) {
    return { ok: false, message: '计划开工日期格式不正确，需为 YYYY-MM-DD 的合法日期' }
  }
  if (!Number.isInteger(duration) || duration <= 0) {
    return { ok: false, message: '计划工期必须是正整数天数' }
  }

  const policy = getPolicy()
  const rule = ruleFor(policy, category)
  if (!rule) {
    return {
      ok: false,
      message: `检修类别「${category}」没有期限口径，请先在口径设置里配置后再登记`,
    }
  }
  if (duration > rule.maxDurationDays) {
    return {
      ok: false,
      message: `计划工期 ${duration} 天超过「${category}」上限 ${rule.maxDurationDays} 天，超出 ${
        duration - rule.maxDurationDays
      } 天，不允许落库，请压缩工期或调整检修类别`,
    }
  }

  const plannedFinish = addDaysISO(start, duration - 1)
  const rows = listRows('pumpmaint').map((row) => ({ ...row }))
  const existing = findLatestPair(rows, code, pump)
  // 覆盖自身时不跟自己的旧区间打架。
  const blockers = rows.filter(
    (row) =>
      row !== existing &&
      isLatest(row) &&
      isHanging(row) &&
      String(row['泵组编号']).trim() === pump &&
      rangesOverlap(
        start,
        plannedFinish,
        String(row['计划开工']),
        String(row['计划完工']),
      ),
  )
  if (blockers.length > 0) {
    const detail = blockers
      .map(
        (row) =>
          `「${String(row['检修编号'])}」（${String(row['计划开工'])} 至 ${String(
            row['计划完工'],
          )}）`,
      )
      .join('、')
    return {
      ok: false,
      message: `泵组 ${pump} 已有在挂检修安排 ${detail} 与本次计划（${start} 至 ${plannedFinish}）时间叠加，后来的安排须先解决冲突才允许落库`,
    }
  }

  const now = new Date().toISOString().slice(0, 16)
  let id: number
  let version: number
  if (existing) {
    // 重复提交按最新版覆盖：旧版保留在表里备查，只把 isLatest 摘掉。
    existing.isLatest = false
    id = nextRowId('pumpmaint')
    version = Number(existing.version ?? 1) + 1
  } else {
    id = nextRowId('pumpmaint')
    version = 1
  }

  const row: MaintRow = {
    id,
    status: '待开工',
    pending: true,
    abnormal: false,
    检修编号: code,
    泵组编号: pump,
    检修类别: category,
    检修班组: team,
    计划开工: start,
    计划工期: duration,
    计划完工: plannedFinish,
    完成日期: '',
    更换部件: '',
    检修状态: '待开工',
    isLatest: true,
    version,
    registeredAt: now,
    _overdue: false,
    _overdueDays: 0,
  }
  rows.push(row)
  const policyNow = getPolicy()
  for (const item of rows) {
    applyDerivedFlags(item, policyNow, todayISO())
  }
  markConflicts(rows)
  saveRows('pumpmaint', rows)

  return {
    ok: true,
    id,
    message: existing
      ? `检修 ${code}（泵组 ${pump}）重复提交，已按第 ${version} 版覆盖，旧版保留备查`
      : `检修 ${code}（泵组 ${pump}）已落库，计划 ${start} 至 ${plannedFinish}，共 ${duration} 天`,
  }
}

// ---- 单向状态流转 -----------------------------------------------------------

/**
 * 泵组检修动作：记录只能从待开工单向走到完工。
 * 确认完工必须回填完成日期与更换部件，且完成日期不得早于计划开工。
 */
export function runMaintAction(
  id: number,
  action: string,
  payload?: Partial<FinishPayload>,
): ActionResult {
  const rows = listRows('pumpmaint').map((row) => ({ ...row }))
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的泵组检修记录` }
  }
  const row = rows[index]
  if (!isLatest(row)) {
    return { ok: false, message: '这是已被新版覆盖的归档旧版，仅供查阅，不能操作' }
  }

  const transition = validateMaintTransition(String(row.status), action)
  if (!transition.ok) {
    return transition
  }

  if (action === MAINT_START_ACTION) {
    row.status = '检修中'
    row['检修状态'] = '检修中'
  } else if (action === MAINT_FINISH_ACTION) {
    const finishDate = String(payload?.finishDate ?? '').trim()
    const replacedParts = String(payload?.replacedParts ?? '').trim()
    if (!isValidISODate(finishDate)) {
      return { ok: false, message: '完工必须回填合法的完成日期（YYYY-MM-DD）' }
    }
    if (!replacedParts) {
      return { ok: false, message: '完工必须回填更换部件；未更换部件请填写「无」' }
    }
    if (diffDays(String(row['计划开工']), finishDate) === null) {
      return { ok: false, message: '完成日期无法与计划开工比较，请核对日期' }
    }
    if (diffDays(String(row['计划开工']), finishDate)! < 0) {
      return { ok: false, message: `完成日期 ${finishDate} 早于计划开工 ${String(row['计划开工'])}，请核对` }
    }
    row.status = '已完工'
    row['检修状态'] = '已完工'
    row['完成日期'] = finishDate
    row['更换部件'] = replacedParts
    row.pending = false
  }

  const policy = getPolicy()
  for (const item of rows) {
    applyDerivedFlags(item, policy, todayISO())
  }
  markConflicts(rows)
  saveRows('pumpmaint', rows)
  return {
    ok: true,
    message:
      action === MAINT_FINISH_ACTION
        ? `检修 ${String(row['检修编号'])} 已完工，完成日期 ${String(row['完成日期'])}`
        : `检修 ${String(row['检修编号'])} 已${action}，当前状态「${row.status}」`,
  }
}

export { MAINT_START_ACTION, MAINT_FINISH_ACTION }

// ---- 查询 -------------------------------------------------------------------

export function listMaintEntries(filters: Record<string, string> = {}): PageResult {
  recalcOverdue()
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  const matched = listRows('pumpmaint')
    .filter((row) => isLatest(row))
    .filter((row) =>
      pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
    )
    .sort((a, b) => Number(b.id) - Number(a.id))
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function listMaintVersions(filters: { 检修编号?: string; 泵组编号?: string } = {}): EntryRow[] {
  const code = filters.检修编号?.trim() ?? ''
  const pump = filters.泵组编号?.trim() ?? ''
  return listRows('pumpmaint')
    .filter((row) => (code ? String(row['检修编号']).includes(code) : true))
    .filter((row) => (pump ? String(row['泵组编号']).includes(pump) : true))
    .sort((a, b) => Number(b.id) - Number(a.id))
}

export function maintSummary(): MaintSummary {
  const rows = listMaintEntries().items
  const nowMonth = todayISO().slice(0, 7)
  return {
    pending: rows.filter((row) => statusOf(row) === '待开工').length,
    running: rows.filter((row) => statusOf(row) === '检修中').length,
    overdue: rows.filter((row) => Boolean(row['_overdue'])).length,
    finishedThisMonth: rows.filter(
      (row) => statusOf(row) === '已完工' && String(row['完成日期']).startsWith(nowMonth),
    ).length,
  }
}

/** 登记时给出该泵该类别的周期参考：上次同类完工 + 周期 = 建议开工日。 */
export function cycleSuggestion(pump: string, category: string): MaintSuggestion | null {
  const policy = getPolicy()
  const rule = ruleFor(policy, category)
  if (!rule || !pump.trim()) {
    return null
  }
  const last = listRows('pumpmaint')
    .filter(
      (row) =>
        isLatest(row) &&
        String(row['泵组编号']).trim() === pump.trim() &&
        String(row['检修类别']).trim() === category &&
        statusOf(row) === '已完工' &&
        isValidISODate(String(row['完成日期'])),
    )
    .sort((a, b) => String(b['完成日期']).localeCompare(String(a['完成日期'])))[0]
  const lastFinishDate = last ? String(last['完成日期']) : ''
  return {
    cycleDays: rule.cycleDays,
    annualTimes: annualTimes(rule),
    lastFinishDate,
    suggestedStart: lastFinishDate ? addDaysISO(lastFinishDate, rule.cycleDays) : '',
  }
}

export function exportMaintEntries(): { filename: string; content: string } {
  const header = [...MAINT_FIELDS, '超期天数', '冲突标记']
  const lines = [header.join(',')]
  for (const row of listMaintEntries().items) {
    const values = [
      ...MAINT_FIELDS.map((field) => row[field] ?? ''),
      row['_overdue'] ? row['_overdueDays'] : '',
      row['_conflict'] ? '冲突待解决' : '',
    ]
    lines.push(values.map((value) => String(value)).join(','))
  }
  return { filename: '泵组检修-清单.csv', content: `﻿${lines.join('\n')}` }
}
