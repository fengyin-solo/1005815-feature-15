/**
 * 泵组检修期限口径的服务层验证脚本，不依赖浏览器。
 * 运行：node scripts/run-verify-pumpmaint.mjs（由 package.json 的 verify 脚本经 esbuild 打包后执行）
 */
import {
  durationLimit,
  finishMaint,
  listCategories,
  listMaint,
  overdueDaysOf,
  recalcOverdue,
  saveCategories,
  startMaint,
  submitMaint,
  timesPerYear,
} from '../src/api/pumpmaint-service'

let passed = 0
function check(name, condition, detail = '') {
  if (!condition) {
    console.error(`✗ ${name}${detail ? `：${detail}` : ''}`)
    process.exitCode = 1
  } else {
    passed += 1
    console.log(`✓ ${name}`)
  }
}

// 口径一：默认类别与上限（周期 + 顺延）
const rules = listCategories()
const daily = rules.find((r) => r.name === '日常保养')
const routine = rules.find((r) => r.name === '常规检修')
check('默认口径含日常保养/常规检修/大修', rules.length === 3)
check('日常保养上限 = 30 + 3 = 33 天', durationLimit(daily) === 33)
check('常规检修年约 4 次', timesPerYear(routine) === 4)

// 口径二：工期不超上限才允许落库；退回写清超了多少天
const base = {
  检修编号: 'TEST-0001',
  泵组编号: 'TEST-PUMP-A',
  检修类别: '日常保养',
  检修班组: '验证班组',
  计划开工日期: '2026-10-08',
  计划完工日期: '2026-11-06', // 30 天
}
check('30 天工期允许落库', submitMaint({ ...base }).ok)

const tooLong = submitMaint({
  ...base,
  检修编号: 'TEST-0002',
  泵组编号: 'TEST-PUMP-B',
  计划完工日期: '2026-11-16', // 40 天，超上限 7 天
})
check('40 天工期被退回', !tooLong.ok)
check('退回信息写清超出 7 天与口径构成', tooLong.message.includes('超出 7 天') && tooLong.message.includes('33 天'))

// 类别不在口径里也不收
const badCategory = submitMaint({
  ...base,
  检修编号: 'TEST-0003',
  泵组编号: 'TEST-PUMP-C',
  检修类别: '随便修修',
})
check('非口径类别拒绝落库', !badCategory.ok && badCategory.message.includes('期限口径'))

// 口径三：同一台泵时间窗冲突，后来的先解决冲突才让存
const second = {
  检修编号: 'TEST-0004',
  泵组编号: 'TEST-PUMP-A',
  检修类别: '日常保养',
  检修班组: '验证班组',
  计划开工日期: '2026-11-01',
  计划完工日期: '2026-11-05',
}
const clash = submitMaint({ ...second })
check('重叠时间窗冲突被拦截', !clash.ok && clash.message.includes('重叠'))
check('冲突信息指出是哪条在挂安排', clash.message.includes('TEST-0001'))

const resolved = submitMaint({ ...second, 计划开工日期: '2026-11-07', 计划完工日期: '2026-12-06' })
check('错开到次日（11-07）即允许落库', resolved.ok)

// 相邻不算重叠：11-06 完工、11-07 开工上面已验证；不同泵同期互不影响
const otherPump = submitMaint({
  ...base,
  检修编号: 'TEST-0005',
  泵组编号: 'TEST-PUMP-D',
  计划开工日期: '2026-10-20',
  计划完工日期: '2026-11-01',
})
check('不同泵组时间窗重叠允许并存', otherPump.ok)

// 口径四：检修编号 + 泵组编号唯一对，重复提交按最新版覆盖，旧版留档
const cover = submitMaint({
  ...base,
  检修班组: '验证班组二组',
  计划开工日期: '2026-10-09',
  计划完工日期: '2026-11-05',
})
check('同一唯一对重复提交按最新版覆盖', cover.ok && cover.message.includes('第 2 版'))
const coveredRows = listMaint({ 泵组编号: 'TEST-PUMP-A' }).items.filter(
  (r) => r['检修编号'] === 'TEST-0001',
)
check('覆盖后仍是一条记录', coveredRows.length === 1)
check('最新版字段生效', String(coveredRows[0]['检修班组']) === '验证班组二组' && Number(coveredRows[0]['版本']) === 2)
// 同编号配另一台泵属于另一对，但需不冲突
const pairUnique = submitMaint({
  ...base,
  泵组编号: 'TEST-PUMP-E',
  计划开工日期: '2026-10-08',
  计划完工日期: '2026-11-06',
})
check('同检修编号不同泵组是另一对，可登记', pairUnique.ok)

// 口径五：状态单向，完工回填完成日期与更换部件
const editingId = Number(coveredRows[0].id)
check('待开工可提交开工', startMaint(editingId).ok)
check('重复开工被拒绝', !startMaint(editingId).ok)

const noParts = finishMaint(editingId, { 完成日期: '2026-11-05', 更换部件: '   ' })
check('完工不填更换部件被拒绝', !noParts.ok)
const noDate = finishMaint(editingId, { 完成日期: '', 更换部件: '机械密封' })
check('完工不填完成日期被拒绝', noDate.ok === false)

const done = finishMaint(editingId, { 完成日期: '2026-11-05', 更换部件: '机械密封、轴承' })
check('回填齐两项可完工', done.ok)
const finished = listMaint({ 泵组编号: 'TEST-PUMP-A' }).items.find((r) => Number(r.id) === editingId)
check('完工状态为已完工且 pending=false', String(finished.status) === '已完工' && finished.pending === false)
check('完工后开工动作不可再用', !startMaint(editingId).ok)
const editFinal = submitMaint(
  { ...base, 检修班组: '终态改期应被拒' },
  editingId,
)
check('完工后不允许再改期覆盖', !editFinal.ok)

// 已完工记录不占档期：同一台泵新安排与已完工时间窗重叠也应放行
const afterDone = submitMaint({
  ...base,
  检修编号: 'TEST-0006',
  泵组编号: 'TEST-PUMP-A',
  计划开工日期: '2026-10-20',
  计划完工日期: '2026-10-25',
})
check('已完工记录不参与冲突判定', afterDone.ok)

// 口径六：超期天数 = 基准日 −（计划完工日 + 顺延天数），只看挂账记录
const ref = {
  检修编号: 'TEST-0007',
  泵组编号: 'TEST-PUMP-F',
  检修类别: '日常保养',
  检修班组: '验证班组',
  计划开工日期: '2026-09-28',
  计划完工日期: '2026-09-30', // 顺延 3 天 → 10-03 前不算超期
}
submitMaint({ ...ref })
const refRow = listMaint({ 检修编号: 'TEST-0007' }).items[0]
check('10-03 当天不超期', overdueDaysOf(refRow, new Date(2026, 9, 3)) === 0)
check('10-05 超期 2 天', overdueDaysOf(refRow, new Date(2026, 9, 5)) === 2)

// 已完工记录永远不算超期
check('已完工记录不参与超期计算', overdueDaysOf(finished, new Date(2027, 0, 1)) === 0)

// 口径调整后，挂账记录按新口径重算：顺延放宽到 10 天，10-05 不再超期
const saved = saveCategories(
  listCategories().map((r) => (r.name === '日常保养' ? { ...r, graceDays: 10 } : r)),
)
check('口径保存成功并触发重算', saved.ok)
const refRow2 = listMaint({ 检修编号: 'TEST-0007' }).items[0]
check('顺延放宽后超期清零', overdueDaysOf(refRow2, new Date(2026, 9, 5)) === 0)

// 非法口径不允许保存
const invalidRules = saveCategories([{ name: '空周期', cycleDays: 0, graceDays: 1 }])
check('周期非正整数的口径拒绝保存', !invalidRules.ok)
const duplicateRules = saveCategories([
  { name: '日常保养', cycleDays: 30, graceDays: 3 },
  { name: '日常保养', cycleDays: 90, graceDays: 5 },
])
check('重名类别拒绝保存', !duplicateRules.ok)

// 显式重算入口
const summary = recalcOverdue()
check('重算返回挂账数与超期数', typeof summary.checked === 'number' && typeof summary.overdue === 'number')

console.log(`\n泵组检修口径验证完成：${passed} 项断言全部通过`)
