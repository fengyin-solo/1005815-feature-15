import { SEED_ROWS } from './seed'
import { SEED_SCHEMA_VERSION } from './seed-version'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'drainage-pump:entries'
const KV_KEY = 'drainage-pump:kv'
const SCHEMA_KEY = 'drainage-pump:schema-version'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

// 种子结构升级时，按版本把受影响模块的旧数据整组换成新种子；没列到的模块保留用户改动。
const SEED_MIGRATIONS: Record<number, string[]> = {
  // v2：泵组检修改为按类别期限口径，字段从占位文本换成真实日期/工期。
  2: ['pumpmaint'],
}

function migrateSeedVersion(): void {
  if (!hasStorage()) {
    return
  }
  const storage = window.localStorage
  const stored = Number(storage.getItem(SCHEMA_KEY) ?? '1')
  if (stored >= SEED_SCHEMA_VERSION) {
    return
  }
  if (storage.getItem(STORAGE_KEY)) {
    const saved = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as Record<string, EntryRow[]>
    for (let version = stored + 1; version <= SEED_SCHEMA_VERSION; version += 1) {
      for (const moduleKey of SEED_MIGRATIONS[version] ?? []) {
        saved[moduleKey] = clone(SEED_ROWS[moduleKey] ?? [])
      }
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(saved))
    cache = null
  }
  storage.setItem(SCHEMA_KEY, String(SEED_SCHEMA_VERSION))
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (!hasStorage()) {
    return fallback
  }
  migrateSeedVersion()
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

function readKv(): Record<string, unknown> {
  if (!hasStorage()) {
    return {}
  }
  const raw = window.localStorage.getItem(KV_KEY)
  if (!raw) {
    return {}
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

let cache: Record<string, EntryRow[]> | null = null
let kvCache: Record<string, unknown> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (hasStorage()) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// 列表之外的零散配置（如泵组检修期限口径）统一放 KV，不挤占模块数据。
export function getKv<T>(key: string, fallback: T): T {
  if (kvCache === null) {
    kvCache = readKv()
  }
  const value = kvCache[key]
  return value === undefined ? fallback : (clone(value) as T)
}

export function setKv<T>(key: string, value: T): void {
  const next = { ...(kvCache ?? readKv()), [key]: value }
  kvCache = next
  if (hasStorage()) {
    window.localStorage.setItem(KV_KEY, JSON.stringify(next))
  }
}

// 新登记记录的自增主键：在该模块现有最大 id 之后续号（含归档旧版）。
export function nextRowId(key: string): number {
  const rows = listRows(key)
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}
