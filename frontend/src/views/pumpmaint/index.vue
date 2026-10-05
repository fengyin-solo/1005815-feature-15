<template>
  <section class="page" data-module="pumpmaint">
    <header class="page-head">
      <div>
        <h2>泵组检修管理</h2>
        <p class="page-desc">
          按检修类别口径（检修周期、允许顺延天数、计划工期上限）登记检修安排；
          超期按口径自动重算，检修编号与泵组编号为唯一一对，重复提交按最新版覆盖、旧版备查。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记检修安排</button>
        <button class="btn" type="button" @click="openPolicy">期限口径设置</button>
        <button class="btn" type="button" @click="openVersions">旧版备查</button>
        <button class="btn" type="button" @click="exportRows">导出清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ 'stat-warn': item.warn }">{{ item.value }}</strong>
      </article>
    </div>

    <section class="policy-banner">
      <strong>现行期限口径（第 {{ policy.version }} 版{{ policy.updatedAt ? `，${policy.updatedAt} 调整` : '，默认口径' }}）：</strong>
      <span v-for="rule in policy.rules" :key="rule.category" class="policy-chip">
        {{ rule.category }}｜周期 {{ rule.cycleDays }} 天（年约 {{ annual(rule) }} 次）｜顺延上限 {{ rule.graceDays }} 天｜工期上限 {{ rule.maxDurationDays }} 天
      </span>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item legend-warn">超期：{{ summary.overdue }}</span>
      <span class="legend-item legend-conflict">冲突待解决：{{ conflictCount }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table maint-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>口径标记</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-overdue': row._overdue, 'row-conflict': row._conflict }">
          <td v-for="column in columns" :key="column">
            {{ row[column] || '—' }}
            <span v-if="column === '检修编号' && Number(row.version) > 1" class="version-tag">v{{ row.version }}</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="mark-cell">
            <span v-if="row._overdue" class="badge badge-overdue">超期 {{ row._overdueDays }} 天</span>
            <span v-if="row._conflict" class="badge badge-conflict">冲突待解决</span>
            <span v-if="!row._overdue && !row._conflict" class="badge badge-ok">正常</span>
          </td>
          <td class="row-actions">
            <button
              v-if="row.status === '待开工'"
              class="link"
              type="button"
              @click="startWork(row)"
            >
              提交开工
            </button>
            <button
              v-if="row.status === '检修中'"
              class="link"
              type="button"
              @click="openFinish(row)"
            >
              确认完工
            </button>
            <span v-if="row.status === '已完工'" class="muted-text">流程已终结</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无泵组检修数据，可先登记检修安排</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条泵组检修记录（在挂最新版，旧版见「旧版备查」）</span>
      <span v-if="message" class="error-text">{{ message }}</span>
    </footer>

    <!-- 登记检修安排 -->
    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
      <div class="modal">
        <h3>登记泵组检修安排</h3>
        <div class="form-grid">
          <label class="form-item">
            <span>检修编号 *</span>
            <input v-model="form.检修编号" placeholder="如 JX-2026-007" />
          </label>
          <label class="form-item">
            <span>泵组编号 *</span>
            <input v-model="form.泵组编号" placeholder="如 P-01" @change="refreshSuggestion" />
          </label>
          <label class="form-item">
            <span>检修类别 *</span>
            <select v-model="form.检修类别" @change="refreshSuggestion">
              <option value="" disabled>请选择</option>
              <option v-for="rule in policy.rules" :key="rule.category" :value="rule.category">{{ rule.category }}</option>
            </select>
          </label>
          <label class="form-item">
            <span>检修班组 *</span>
            <input v-model="form.检修班组" placeholder="如 检修一班" />
          </label>
          <label class="form-item">
            <span>计划开工 *</span>
            <input v-model="form.计划开工" type="date" />
          </label>
          <label class="form-item">
            <span>计划工期（天）*</span>
            <input v-model.number="form.计划工期" type="number" min="1" step="1" />
          </label>
        </div>
        <p v-if="activeRule" class="form-hint">
          口径：周期 {{ activeRule.cycleDays }} 天（年约 {{ annual(activeRule) }} 次），允许顺延 {{ activeRule.graceDays }} 天，
          计划工期上限 <strong>{{ activeRule.maxDurationDays }}</strong> 天。
        </p>
        <p v-if="suggestion" class="form-hint">
          <template v-if="suggestion.lastFinishDate">
            该泵上次{{ form.检修类别 }}完工 {{ suggestion.lastFinishDate }}，按周期建议开工日 {{ suggestion.suggestedStart }}。
          </template>
          <template v-else>该泵暂无{{ form.检修类别 }}完工记录，请按实际安排填写。</template>
        </p>
        <p v-if="form.检修类别 && form.计划开工 && Number(form.计划工期) > 0" class="form-hint">
          本次计划区间：{{ form.计划开工 }} 至 {{ plannedFinishPreview }}。
        </p>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="showCreate = false">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">提交落库</button>
        </div>
      </div>
    </div>

    <!-- 完工回填 -->
    <div v-if="showFinish" class="modal-mask" @click.self="showFinish = false">
      <div class="modal">
        <h3>确认完工：{{ finishTarget?.['检修编号'] }}（{{ finishTarget?.['泵组编号'] }}）</h3>
        <p class="form-hint">检修记录只能单向流转，完工后不可回退；必须回填完成日期与更换部件。</p>
        <div class="form-grid">
          <label class="form-item">
            <span>完成日期 *</span>
            <input v-model="finishForm.finishDate" type="date" />
          </label>
          <label class="form-item form-item-wide">
            <span>更换部件 *</span>
            <input v-model="finishForm.replacedParts" placeholder="如 机械密封1套；未更换填「无」" />
          </label>
        </div>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="showFinish = false">取消</button>
          <button class="btn primary" type="button" @click="submitFinish">确认完工</button>
        </div>
      </div>
    </div>

    <!-- 期限口径设置 -->
    <div v-if="showPolicyModal" class="modal-mask modal-wide" @click.self="showPolicyModal = false">
      <div class="modal">
        <h3>泵组检修期限口径设置</h3>
        <p class="form-hint">
          每类检修分别设定：检修周期（一年该检修几次的基准）、允许顺延天数（拖多久算超期）、计划工期上限（超上限不允许落库）。
          保存后自动对全部在挂记录按新口径重算超期标记。
        </p>
        <table class="data-table policy-table">
          <thead>
            <tr>
              <th>检修类别</th>
              <th>检修周期（天）</th>
              <th>年检修次数（参考）</th>
              <th>允许顺延（天）</th>
              <th>计划工期上限（天）</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(rule, index) in policyForm" :key="rule.category">
              <td><input v-model="rule.category" /></td>
              <td><input v-model.number="rule.cycleDays" type="number" min="1" step="1" /></td>
              <td>{{ Number.isInteger(Number(rule.cycleDays)) && Number(rule.cycleDays) > 0 ? annual(rule) : '—' }}</td>
              <td><input v-model.number="rule.graceDays" type="number" min="0" step="1" /></td>
              <td><input v-model.number="rule.maxDurationDays" type="number" min="1" step="1" /></td>
              <td><button class="link danger" type="button" @click="removeRule(index)">删除</button></td>
            </tr>
          </tbody>
        </table>
        <button class="btn" type="button" @click="addRule">新增类别</button>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="showPolicyModal = false">取消</button>
          <button class="btn primary" type="button" @click="submitPolicy">保存口径并重算</button>
        </div>
      </div>
    </div>

    <!-- 旧版备查 -->
    <div v-if="showVersionsModal" class="modal-mask modal-wide" @click.self="showVersionsModal = false">
      <div class="modal">
        <h3>检修版本台账（旧版备查）</h3>
        <div class="filter-bar">
          <label class="filter-item">
            <span>检修编号</span>
            <input v-model="versionFilter.检修编号" placeholder="按检修编号检索" />
          </label>
          <label class="filter-item">
            <span>泵组编号</span>
            <input v-model="versionFilter.泵组编号" placeholder="按泵组编号检索" />
          </label>
          <button class="btn" type="button" @click="reloadVersions">查询</button>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>检修编号</th>
              <th>泵组编号</th>
              <th>版本</th>
              <th>类别</th>
              <th>计划区间</th>
              <th>状态</th>
              <th>版本情况</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in versionRows" :key="String(row.id)">
              <td>{{ row['检修编号'] }}</td>
              <td>{{ row['泵组编号'] }}</td>
              <td>v{{ row.version }}</td>
              <td>{{ row['检修类别'] }}</td>
              <td>{{ row['计划开工'] }} 至 {{ row['计划完工'] }}（{{ row['计划工期'] }} 天）</td>
              <td>{{ row.status }}</td>
              <td>
                <span v-if="row.isLatest" class="badge badge-ok">当前最新版</span>
                <span v-else class="badge badge-archived">旧版已归档</span>
              </td>
            </tr>
            <tr v-if="!versionRows.length">
              <td colspan="7" class="empty-state">暂无符合条件的版本记录</td>
            </tr>
          </tbody>
        </table>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="showVersionsModal = false">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  cycleSuggestion,
  exportMaintEntries,
  getPolicy,
  listMaintEntries,
  listMaintVersions,
  maintSummary,
  recalcOverdue,
  runMaintAction,
  savePolicy,
  upsertMaintEntry,
  type MaintSuggestion,
} from '@/api/pumpmaint-service'
import type { EntryRow } from '@/data/types'
import {
  addDaysISO,
  annualTimes,
  todayISO,
  type MaintCategoryRule,
  type MaintDraft,
  type MaintPolicy,
} from '@/domain/pumpmaint'

const columns = ['检修编号', '泵组编号', '检修类别', '检修班组', '计划开工', '计划工期', '计划完工', '完成日期', '更换部件']
const filterFields = ['检修编号', '泵组编号', '检修类别']
const statuses = ['待开工', '检修中', '已完工']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const filters = ref<Record<string, string>>({})
const policy = ref<MaintPolicy>(getPolicy())

const summary = ref(maintSummarySafe())

function maintSummarySafe() {
  try {
    return maintSummary()
  } catch {
    return { pending: 0, running: 0, overdue: 0, finishedThisMonth: 0 }
  }
}

const stats = computed(() => [
  { label: '待开工检修', value: summary.value.pending, warn: false },
  { label: '检修中泵组', value: summary.value.running, warn: false },
  { label: '超期检修', value: summary.value.overdue, warn: summary.value.overdue > 0 },
  { label: '本月完工数', value: summary.value.finishedThisMonth, warn: false },
])

const conflictCount = computed(() => rows.value.filter((row) => row['_conflict']).length)
const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function annual(rule: MaintCategoryRule): number {
  return annualTimes(rule)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  const { filename, content } = exportMaintEntries()
  // 与通用导出保持一致的下载方式（BOM + CSV）。
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

// ---- 登记 ----

const showCreate = ref(false)
const formError = ref('')
const emptyForm = (): MaintDraft => ({
  检修编号: '',
  泵组编号: '',
  检修类别: '',
  检修班组: '',
  计划开工: todayISO(),
  计划工期: 1,
})
const form = ref<MaintDraft>(emptyForm())
const suggestion = ref<MaintSuggestion | null>(null)

const activeRule = computed(() =>
  policy.value.rules.find((rule) => rule.category === form.value.检修类别),
)
const plannedFinishPreview = computed(() =>
  addDaysISO(form.value.计划开工, Number(form.value.计划工期) - 1),
)

function openCreate() {
  form.value = emptyForm()
  formError.value = ''
  suggestion.value = null
  showCreate.value = true
}

function refreshSuggestion() {
  suggestion.value = cycleSuggestion(form.value.泵组编号, form.value.检修类别)
}

function submitCreate() {
  formError.value = ''
  const result = upsertMaintEntry({
    ...form.value,
    计划工期: Number(form.value.计划工期),
  })
  if (!result.ok) {
    formError.value = result.message
    return
  }
  showCreate.value = false
  message.value = ''
  reload()
}

// ---- 开工 / 完工 ----

const showFinish = ref(false)
const finishTarget = ref<EntryRow | null>(null)
const finishForm = ref({ finishDate: todayISO(), replacedParts: '' })

function startWork(row: EntryRow) {
  message.value = ''
  const result = runMaintAction(Number(row.id), '提交开工')
  if (!result.ok) {
    message.value = result.message
    return
  }
  reload()
}

function openFinish(row: EntryRow) {
  finishTarget.value = row
  finishForm.value = { finishDate: todayISO(), replacedParts: '' }
  formError.value = ''
  showFinish.value = true
}

function submitFinish() {
  if (!finishTarget.value) {
    return
  }
  formError.value = ''
  const result = runMaintAction(Number(finishTarget.value.id), '确认完工', { ...finishForm.value })
  if (!result.ok) {
    formError.value = result.message
    return
  }
  showFinish.value = false
  reload()
}

// ---- 口径设置 ----

const showPolicyModal = ref(false)
const policyForm = ref<MaintCategoryRule[]>([])

function openPolicy() {
  policyForm.value = getPolicy().rules.map((rule) => ({ ...rule }))
  formError.value = ''
  showPolicyModal.value = true
}

function addRule() {
  policyForm.value.push({ category: '', cycleDays: 90, graceDays: 7, maxDurationDays: 3 })
}

function removeRule(index: number) {
  policyForm.value.splice(index, 1)
}

function submitPolicy() {
  formError.value = ''
  const result = savePolicy(policyForm.value.map((rule) => ({
    category: String(rule.category ?? ''),
    cycleDays: Number(rule.cycleDays),
    graceDays: Number(rule.graceDays),
    maxDurationDays: Number(rule.maxDurationDays),
  })))
  if (!result.ok) {
    formError.value = result.message
    return
  }
  policy.value = getPolicy()
  showPolicyModal.value = false
  reload()
  message.value = result.message
}

// ---- 旧版备查 ----

const showVersionsModal = ref(false)
const versionRows = ref<EntryRow[]>([])
const versionFilter = ref<Record<string, string>>({ 检修编号: '', 泵组编号: '' })

function openVersions() {
  versionFilter.value = { 检修编号: '', 泵组编号: '' }
  reloadVersions()
  showVersionsModal.value = true
}

function reloadVersions() {
  versionRows.value = listMaintVersions(versionFilter.value)
}

// ---- 列表刷新 ----

function reload() {
  message.value = ''
  try {
    policy.value = getPolicy()
    const payload = listMaintEntries(filters.value)
    rows.value = payload.items
    total.value = payload.total
    summary.value = maintSummary()
  } catch (error) {
    message.value = error instanceof Error ? error.message : '泵组检修列表读取失败'
  }
}

let recalculated = false
onMounted(() => {
  if (!recalculated) {
    // 口径定下来之后，正在挂着的检修记录按现行口径重算一次超期标记。
    recalcOverdue()
    recalculated = true
  }
  reload()
})
</script>

<style scoped>
.page-actions {
  display: flex;
  gap: 8px;
}
.stat-warn {
  color: #b42318;
}
.policy-banner {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  background: #eef4ff;
  border: 1px solid #c7d9ff;
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 12px;
  font-size: 12px;
}
.policy-chip {
  background: #fff;
  border: 1px solid #c7d9ff;
  border-radius: 999px;
  padding: 2px 10px;
}
.legend-warn {
  background: #fde8e7;
  color: #b42318;
}
.legend-conflict {
  background: #fff4e0;
  color: #b54708;
}
.maint-table .row-overdue {
  background: #fff7f6;
}
.maint-table .row-conflict td {
  background: #fffaf0;
}
.mark-cell {
  white-space: nowrap;
}
.badge {
  display: inline-block;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 12px;
  margin-right: 4px;
}
.badge-ok {
  background: #e7f6ec;
  color: #067647;
}
.badge-overdue {
  background: #fde8e7;
  color: #b42318;
}
.badge-conflict {
  background: #fff4e0;
  color: #b54708;
}
.badge-archived {
  background: #eef2f7;
  color: #64748b;
}
.version-tag {
  margin-left: 4px;
  font-size: 11px;
  color: #64748b;
}
.muted-text {
  color: #94a3b8;
  font-size: 12px;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal {
  background: #fff;
  border-radius: 10px;
  padding: 20px 24px;
  width: 640px;
  max-width: 92vw;
  max-height: 88vh;
  overflow: auto;
}
.modal-wide .modal {
  width: 900px;
}
.modal h3 {
  margin: 0 0 12px;
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 14px;
}
.form-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
.form-item-wide {
  grid-column: 1 / -1;
}
.form-item input,
.form-item select,
.policy-table input {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
}
.form-hint {
  font-size: 12px;
  color: var(--muted);
  margin: 10px 0 0;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
.policy-table {
  margin: 10px 0;
}
.policy-table input {
  width: 100%;
}
.link.danger {
  color: #b42318;
}
</style>
