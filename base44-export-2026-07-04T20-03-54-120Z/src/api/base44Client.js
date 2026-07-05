import { createClient } from '@base44/sdk'

import { appParams } from '@/lib/app-params'

const memoryStore = {}

function ensureCollection(entityName) {
  if (!memoryStore[entityName]) {
    memoryStore[entityName] = []
  }
  return memoryStore[entityName]
}

function createId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function matchesFilter(row, query = {}) {
  return Object.entries(query).every(([key, value]) => row?.[key] === value)
}

function createEntityHandler(entityName) {
  return {
    async list() {
      return [...ensureCollection(entityName)]
    },
    async filter(query = {}) {
      return ensureCollection(entityName).filter((row) => matchesFilter(row, query))
    },
    async get(id) {
      return ensureCollection(entityName).find((row) => row.id === id) ?? null
    },
    async create(payload = {}) {
      const collection = ensureCollection(entityName)
      const row = { id: payload.id ?? createId(), ...payload }
      collection.push(row)
      return row
    },
    async bulkCreate(rows = []) {
      const collection = ensureCollection(entityName)
      const created = rows.map((row) => ({ id: row?.id ?? createId(), ...row }))
      collection.push(...created)
      return created
    },
    async update(id, payload = {}) {
      const collection = ensureCollection(entityName)
      const index = collection.findIndex((row) => row.id === id)
      if (index === -1) return null
      collection[index] = { ...collection[index], ...payload, id: collection[index].id }
      return collection[index]
    },
    async bulkUpdate(updates = []) {
      const collection = ensureCollection(entityName)
      const results = []
      for (const patch of updates) {
        const id = patch?.id
        if (!id) continue
        const index = collection.findIndex((row) => row.id === id)
        if (index === -1) continue
        collection[index] = { ...collection[index], ...patch, id: collection[index].id }
        results.push(collection[index])
      }
      return results
    },
    async delete(id) {
      const collection = ensureCollection(entityName)
      const index = collection.findIndex((row) => row.id === id)
      if (index === -1) return { deleted: 0 }
      collection.splice(index, 1)
      return { deleted: 1 }
    },
    async deleteMany(query = {}) {
      const collection = ensureCollection(entityName)
      const kept = collection.filter((row) => !matchesFilter(row, query))
      const deleted = collection.length - kept.length
      memoryStore[entityName] = kept
      return { deleted }
    },
  }
}

const fallbackClient = {
  auth: {
    isAuthenticated: async () => false,
    me: async () => null,
    loginViaEmailPassword: async () => {
      throw new Error('Local mode: Base44 auth is not configured.')
    },
    loginWithProvider: () => {},
    redirectToLogin: () => {
      if (typeof window !== 'undefined') {
        window.location.href = '/login'
      }
    },
    logout: () => {},
  },
  entities: new Proxy(
    {},
    {
      get: (_target, entityName) => createEntityHandler(String(entityName)),
    }
  ),
  integrations: { Core: { UploadFile: async () => ({ file_url: '' }) } },
}

const base44 = appParams.appId && appParams.appBaseUrl
  ? createClient({
      appId: appParams.appId,
      appBaseUrl: appParams.appBaseUrl,
      token: appParams.token,
      functionsVersion: appParams.functionsVersion,
    })
  : fallbackClient

if (typeof window !== 'undefined') {
  window.__B44_DB__ = base44
}

globalThis.__B44_DB__ = base44

export { base44 }
export default base44
