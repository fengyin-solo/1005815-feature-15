<template>
  <section class="page" data-module="pumpmaint">
    <header class="page-head">
      <div>
        <h2>泵组检修管理</h2>
        <p class="page-desc">
          按检修类别定口径：检修周期与允许顺延天数决定计划工期上限与超期判定；同一台泵排期冲突先解决再存；
          检修编号与泵组编号唯一对、重复提交按最新版覆盖留档；状态只能 待开工 → 检修中 → 已完工 单向流转。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记检修安排</button>
        <button class="btn" type="button" @click="openRules">期限口径</button>
        <button class="btn" type="button" @click="recalc">按口径重算超期</button>
        <button class="btn" type="button" @click="exportRows">导出清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ 'stat-warn': item.label === '超期未完工' && Number(item.value) > 0 }">
          {{ item.value }}
        </strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item legend-warn">超期未完工：{{ overdueCount }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload()">
      <label class="filter-item">
        <span>检修编号</span>
        <input v-model="filters['检修编号']" placeholder="按检修编号检索" />
      </label>
      <label class="filter-item">
        <span>泵组编号</span>
        <input v-model="filters['泵组编号']" placeholder="按泵组编号检索" />
      </label>
      <label class="filter-item">
        <span>检修类别</span>
        <select v-model="filters['检修类别']">
          <option value="">全部类别</option>
          <option v-for="rule in categories" :key="rule.name" :value="rule.name">{{ rule.name }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>当前状态</span>
        <select v-model="filters.status">
          <option value="">全部状态</option>
          <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>超期标记</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>{{ row['检修编号'] }}</td>
          <td>{{ row['泵组编号'] }}</td>
          <td>{{ row['检修类别'] }}</td>
          <td>{{ row['检修班组'] }}</td>
          <td>{{ row['计划开工日期'] }}</td>
          <td>{{ row['计划完工日期'] }}</td>
          <td>{{ durationText(row) }}</td>
          <td>{{ row['完成日期'] || '—' }}</td>
          <td>{{ row['更换部件'] || '—' }}</td>
          <td>v{{ row['版本'] ?? 1 }}</td>
          <td>
            <span v-if="Number(row['超期天数']) > 0" class="badge badge-overdue">
              超期 {{ row['超期天数'] }} 天
            </span>
            <span v-else class="badge badge-ok">正常</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-if="String(row.status) === '待开工'"
              class="link"
              type="button"
              @click="doStart(row)"
            >
              提交开工
            </button>
            <button
              v-if="String(row.status) === '检修中'"
              class="link"
              type="button"
              @click="openFinish(row)"
            >
              确认完工
            </button>
            <button
              v-if="String(row.status) !== '已完工'"
              class="link"
              type="button"
              @click="openEdit(row)"
            >
              改期/覆盖
            </button>
            <button class="link" type="button" @click="openHistory(row)">历史版本</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无泵组检修数据，可先登记检修安排</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>
        共 {{ total }} 条泵组检修记录 · 超期判定基准日 {{ today }}
        <button class="link foot-link" type="button" @click="restoreSeed">恢复示例数据</button>
      </span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <!-- 登记 / 改期覆盖 -->
    <div v-if="formVisible" class="modal-mask" @click.self="closeForm">
      <div class="modal">
        <h3>{{ form.id === undefined ? '登记泵组检修安排' : `改期/覆盖 · 第 ${Number(versionOfEditing) + 1} 版` }}</h3>
        <p class="modal-tip">
          计划工期上限 = 检修周期 + 允许顺延天数；同一台泵与在挂安排时间窗重叠、或工期超上限，都不允许落库。
        </p>
        <div class="form-grid">
          <label>
            <span>检修编号</span>
            <input v-model="form['检修编号']" placeholder="如 JX-2026-0006" />
          </label>
          <label>
            <span>泵组编号</span>
            <input v-model="form['泵组编号']" placeholder="如 BZ-1号机组" />
          </label>
          <label>
            <span>检修类别</span>
            <select v-model="form['检修类别']">
              <option value="" disabled>请选择检修类别</option>
              <option v-for="rule in categories" :key="rule.name" :value="rule.name">
                {{ rule.name }}（周期 {{ rule.cycleDays }} 天 / 顺延 {{ rule.graceDays }} 天）
              </option>
            </select>
          </label>
          <label>
            <span>检修班组</span>
            <input v-model="form['检修班组']" placeholder="如 检修一班" />
          </label>
          <label>
            <span>计划开工日期</span>
            <input v-model="form['计划开工日期']" type="date" />
          </label>
          <label>
            <span>计划完工日期</span>
            <input v-model="form['计划完工日期']" type="date" />
          </label>
        </div>
        <p class="duration-hint" :class="{ 'hint-over': formOverDays > 0 }">
          <template v-if="formDays === null">请先填写合法的计划开工与完工日期。</template>
          <template v-else-if="!selectedRule">当前类别不在期限口径中，请先维护口径。</template>
          <template v-else>
            本次工期 {{ formDays }} 天，上限 {{ formLimit }} 天（周期 {{ selectedRule.cycleDays }} 天 + 顺延
            {{ selectedRule.graceDays }} 天，年约检修 {{ timesPerYear(selectedRule) }} 次）
            <template v-if="formOverDays > 0">——已超上限 {{ formOverDays }} 天，提交将被退回</template>
            <template v-else>——在允许范围内</template>
          </template>
        </p>
        <p v-if="formError" class="error-text form-error">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeForm">取消</button>
          <button class="btn primary" type="button" @click="submitForm">保存</button>
        </div>
      </div>
    </div>

    <!-- 完工回填 -->
    <div v-if="finishVisible" class="modal-mask" @click.self="finishVisible = false">
      <div class="modal">
        <h3>确认完工：{{ finishRow?.['检修编号'] }}</h3>
        <p class="modal-tip">完工为单向终态，必须回填完成日期与更换部件，保存后不可回退。</p>
        <div class="form-grid">
          <label>
            <span>完成日期</span>
            <input v-model="finishForm['完成日期']" type="date" />
          </label>
          <label class="full-span">
            <span>更换部件</span>
            <textarea v-model="finishForm['更换部件']" rows="3" placeholder="如 机械密封、轴承、叶轮"></textarea>
          </label>
        </div>
        <p v-if="finishError" class="error-text form-error">{{ finishError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="finishVisible = false">取消</button>
          <button class="btn primary" type="button" @click="submitFinish">确认完工</button>
        </div>
      </div>
    </div>

    <!-- 期限口径维护 -->
    <div v-if="rulesVisible" class="modal-mask" @click.self="rulesVisible = false">
      <div class="modal modal-wide">
        <h3>检修期限口径</h3>
        <p class="modal-tip">
          按检修类别分别设检修周期与允许顺延天数；工期上限 = 周期 + 顺延，超期天数 = 今天 −（计划完工日 + 顺延天数）。
          保存后正在挂着的检修记录会立即按新口径重算超期标记。
        </p>
        <table class="data-table">
          <thead>
            <tr>
              <th>检修类别</th>
              <th>检修周期（天）</th>
              <th>允许顺延（天）</th>
              <th>工期上限（天）</th>
              <th>年约检修次数</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(rule, index) in ruleDraft" :key="index">
              <td><input v-model="rule.name" placeholder="类别名称" /></td>
              <td><input v-model.number="rule.cycleDays" type="number" min="1" class="num-input" /></td>
              <td><input v-model.number="rule.graceDays" type="number" min="0" class="num-input" /></td>
              <td>{{ ruleLimit(rule) }}</td>
              <td>{{ ruleTimes(rule) }}</td>
              <td>
                <button class="link" type="button" @click="ruleDraft.splice(index, 1)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
        <button class="btn" type="button" @click="addRule">新增类别</button>
        <p v-if="rulesError" class="error-text form-error">{{ rulesError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="restoreDefaultRules">恢复默认口径</button>
          <button class="btn ghost" type="button" @click="rulesVisible = false">取消</button>
          <button class="btn primary" type="button" @click="saveRules">保存并重算超期</button>
        </div>
      </div>
    </div>

    <!-- 历史版本 -->
    <div v-if="historyVisible" class="modal-mask" @click.self="historyVisible = false">
      <div class="modal modal-wide">
        <h3>历史版本：{{ historyTitle }}</h3>
        <p class="modal-tip">重复提交按最新版覆盖，旧版整体快照留在这里备查，只读不可改。</p>
        <table class="data-table">
          <thead>
            <tr>
              <th>版本</th>
              <th>状态</th>
              <th>检修类别</th>
              <th>检修班组</th>
              <th>计划开工</th>
              <th>计划完工</th>
              <th>登记/覆盖时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="version in historyVersions" :key="version.version">
              <td>v{{ version.version }}{{ version.version === historyVersions[0]?.version ? '（最新）' : '' }}</td>
              <td>{{ version.status }}</td>
              <td>{{ version.检修类别 }}</td>
              <td>{{ version.检修班组 }}</td>
              <td>{{ version.计划开工日期 }}</td>
              <td>{{ version.计划完工日期 }}</td>
              <td>{{ version.changedAt || '—' }}</td>
            </tr>
          </tbody>
        </table>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="historyVisible = false">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, resetModule } from '@/api/local-service'
import {
  durationLimit,
  finishMaint,
  historyOf,
  listCategories,
  listMaint,
  maintStats,
  recalcOverdue,
  resetCategories,
  saveCategories,
  spanDays,
  startMaint,
  submitMaint,
  timesPerYear,
  type HistoryVersion,
  type MaintCategory,
  type MaintDraft,
} from '@/api/pumpmaint-service'
import type { EntryRow } from '@/data/types'

const MODULE_KEY = 'pumpmaint'
const columns = [
  '检修编号',
  '泵组编号',
  '检修类别',
  '检修班组',
  '计划开工日期',
  '计划完工日期',
  '计划工期',
  '完成日期',
  '更换部件',
  '版本',
]
const statuses = ['待开工', '检修中', '已完工']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(false)
const filters = ref<Record<string, string>>({ 检修类别: '', status: '' })
const categories = ref<MaintCategory[]>([])
const today = todayText()

const stats = computed(() => maintStats(rows.value))
const overdueCount = computed(() => rows.value.filter((row) => Number(row['超期天数']) > 0).length)
const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// ---------- 登记 / 改期表单 ----------

type FormState = MaintDraft & { id?: number }

const emptyForm = (): FormState => ({
  id: undefined,
  检修编号: '',
  泵组编号: '',
  检修类别: '',
  检修班组: '',
  计划开工日期: '',
  计划完工日期: '',
})

const formVisible = ref(false)
const form = ref<FormState>(emptyForm())
const formError = ref('')
const versionOfEditing = ref(1)

const selectedRule = computed(() => categories.value.find((rule) => rule.name === form.value.检修类别))
const formDays = computed(() => spanDays(form.value.计划开工日期, form.value.计划完工日期))
const formLimit = computed(() => (selectedRule.value ? durationLimit(selectedRule.value) : 0))
const formOverDays = computed(() =>
  formDays.value !== null && selectedRule.value ? Math.max(0, formDays.value - formLimit.value) : 0,
)

function openCreate() {
  form.value = emptyForm()
  formError.value = ''
  formVisible.value = true
}

function openEdit(row: EntryRow) {
  form.value = {
    id: Number(row.id),
    检修编号: String(row['检修编号'] ?? ''),
    泵组编号: String(row['泵组编号'] ?? ''),
    检修类别: String(row['检修类别'] ?? ''),
    检修班组: String(row['检修班组'] ?? ''),
    计划开工日期: String(row['计划开工日期'] ?? ''),
    计划完工日期: String(row['计划完工日期'] ?? ''),
  }
  versionOfEditing.value = Number(row['版本']) || 1
  formError.value = ''
  formVisible.value = true
}

function closeForm() {
  formVisible.value = false
}

function submitForm() {
  const result = submitMaint(form.value, form.value.id)
  if (!result.ok) {
    formError.value = result.message
    return
  }
  formVisible.value = false
  reload(result.message, true)
}

// ---------- 完工回填 ----------

const finishVisible = ref(false)
const finishRow = ref<EntryRow | null>(null)
const finishForm = ref({ 完成日期: today, 更换部件: '' })
const finishError = ref('')

function openFinish(row: EntryRow) {
  finishRow.value = row
  finishForm.value = { 完成日期: today, 更换部件: '' }
  finishError.value = ''
  finishVisible.value = true
}

function submitFinish() {
  if (!finishRow.value) {
    return
  }
  const result = finishMaint(Number(finishRow.value.id), finishForm.value)
  if (!result.ok) {
    finishError.value = result.message
    return
  }
  finishVisible.value = false
  reload(result.message, true)
}

// ---------- 期限口径 ----------

const rulesVisible = ref(false)
const ruleDraft = ref<MaintCategory[]>([])
const rulesError = ref('')

function openRules() {
  ruleDraft.value = listCategories().map((rule) => ({ ...rule }))
  rulesError.value = ''
  rulesVisible.value = true
}

function addRule() {
  ruleDraft.value.push({ name: '', cycleDays: 30, graceDays: 3 })
}

function ruleLimit(rule: MaintCategory): number | string {
  return Number.isInteger(rule.cycleDays) && Number.isInteger(rule.graceDays)
    ? durationLimit({ name: rule.name, cycleDays: Number(rule.cycleDays), graceDays: Number(rule.graceDays) })
    : '—'
}

function ruleTimes(rule: MaintCategory): number | string {
  return Number.isInteger(rule.cycleDays) && Number(rule.cycleDays) > 0
    ? timesPerYear({ name: rule.name, cycleDays: Number(rule.cycleDays), graceDays: Number(rule.graceDays) })
    : '—'
}

function saveRules() {
  const result = saveCategories(
    ruleDraft.value.map((rule) => ({
      name: String(rule.name ?? ''),
      cycleDays: Number(rule.cycleDays),
      graceDays: Number(rule.graceDays),
    })),
  )
  if (!result.ok) {
    rulesError.value = result.message
    return
  }
  rulesVisible.value = false
  categories.value = listCategories()
  reload(result.message, true)
}

function restoreDefaultRules() {
  resetCategories()
  categories.value = listCategories()
  rulesVisible.value = false
  reload('已恢复默认期限口径，并按默认口径重算超期标记', true)
}

// ---------- 历史版本 ----------

const historyVisible = ref(false)
const historyTitle = ref('')
const historyVersions = ref<HistoryVersion[]>([])

function openHistory(row: EntryRow) {
  historyTitle.value = `${String(row['检修编号'])} · ${String(row['泵组编号'])}`
  historyVersions.value = historyOf(row)
  historyVisible.value = true
}

// ---------- 列表与动作 ----------

function durationText(row: EntryRow): string {
  const days = spanDays(String(row['计划开工日期'] ?? ''), String(row['计划完工日期'] ?? ''))
  return days === null ? '—' : `${days} 天`
}

function doStart(row: EntryRow) {
  const result = startMaint(Number(row.id))
  reload(result.message, result.ok)
}

function recalc() {
  const summary = recalcOverdue()
  reload(`已按当前口径重算：挂账检修 ${summary.checked} 条，其中超期 ${summary.overdue} 条`, true)
}

function resetFilters() {
  filters.value = { 检修类别: '', status: '' }
  reload()
}

function exportRows() {
  downloadEntries(MODULE_KEY)
}

function restoreSeed() {
  resetModule(MODULE_KEY)
  recalcOverdue()
  reload('已恢复为泵组检修示例数据', true)
}

function reload(notice = '', ok = false) {
  message.value = notice
  messageOk.value = ok
  categories.value = listCategories()
  const payload = listMaint(filters.value)
  rows.value = payload.items
  total.value = payload.total
}

function todayText(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

onMounted(() => {
  // 口径定下来之后，正在挂着的检修记录按当前口径重算一次超期标记。
  recalcOverdue()
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
.legend-warn {
  background: #fee4e2;
  color: #b42318;
}
.badge {
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  white-space: nowrap;
}
.badge-overdue {
  background: #fee4e2;
  color: #b42318;
}
.badge-ok {
  background: #d1fadf;
  color: #027a48;
}
.foot-link {
  margin-left: 12px;
}
.ok-text {
  color: #027a48;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(16, 24, 40, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal {
  background: #fff;
  border-radius: 10px;
  width: 560px;
  max-width: calc(100vw - 40px);
  max-height: calc(100vh - 60px);
  overflow: auto;
  padding: 20px 22px;
}
.modal-wide {
  width: 780px;
}
.modal h3 {
  margin: 0 0 8px;
  font-size: 16px;
}
.modal-tip {
  font-size: 12px;
  color: var(--muted);
  margin: 0 0 14px;
  line-height: 1.6;
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.form-grid label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
.form-grid .full-span {
  grid-column: 1 / -1;
}
.form-grid input,
.form-grid select,
.form-grid textarea,
.data-table input,
.data-table select {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 13px;
  color: #1f2937;
}
.num-input {
  width: 90px;
}
.duration-hint {
  font-size: 12px;
  color: #027a48;
  margin: 12px 0 0;
}
.hint-over {
  color: #b42318;
}
.form-error {
  margin: 10px 0 0;
  line-height: 1.6;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
.filter-item select {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 8px;
  font-size: 13px;
}
</style>
