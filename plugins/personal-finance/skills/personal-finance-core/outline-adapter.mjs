import { createHash } from "node:crypto"
import { assertValidHandoff } from "./handoff.mjs"
import {
  findForbiddenPaths,
  isIsoDateTime,
} from "./validation.mjs"
import {
  registerEvent,
  registerPeriodNotification,
  validateEvent,
} from "./ledger.mjs"

const ENVELOPE_VERSION = 1
const INDEX_VERSION = 1
const INFO_CONCURRENCY = 4
const PAGE_LIMIT = 100
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OPERATION_QUEUES = new Map()

const DOCUMENTS = {
  root: {
    idKey: "root",
    key: "root",
    kind: "asset-management-system-root",
    title: "자산관리 시스템",
  },
  events: {
    idKey: "container:events",
    key: "events",
    kind: "asset-management-container",
    title: "이벤트",
  },
  notifications: {
    idKey: "container:notifications",
    key: "notifications",
    kind: "asset-management-container",
    title: "알림",
  },
  eventIndex: {
    idKey: "index:events",
    key: "events-index",
    kind: "asset-management-index",
    title: "이벤트 인덱스",
  },
  notificationIndex: {
    idKey: "index:notifications",
    key: "notifications-index",
    kind: "asset-management-index",
    title: "알림 인덱스",
  },
  handoff: {
    idKey: "fixed:handoff",
    key: "handoff",
    kind: "asset-management-handoff",
    title: "인계 데이터",
  },
  snapshot: {
    idKey: "fixed:snapshot",
    key: "snapshot",
    kind: "asset-management-snapshot",
    title: "파생 상태",
  },
}

const INDEXED_COLLECTIONS = {
  events: {
    acceptedStatus: "accepted",
    container: "events",
    index: "eventIndex",
    recordIdPrefix: "event",
    recordKeyField: "event_id",
    recordKind: "asset-management-event",
    resultField: "event",
    recordTitlePrefix: "이벤트",
  },
  notifications: {
    acceptedStatus: "created",
    container: "notifications",
    index: "notificationIndex",
    recordIdPrefix: "notification",
    recordKeyField: "period_id",
    recordKind: "asset-management-notification",
    resultField: "notification",
    recordTitlePrefix: "알림",
  },
}

function enqueueOperation(key, operation) {
  const previous = OPERATION_QUEUES.get(key) ?? Promise.resolve()
  const result = previous.then(operation)
  const settled = result.catch(() => {})
  OPERATION_QUEUES.set(key, settled)
  return result.finally(() => {
    if (OPERATION_QUEUES.get(key) === settled) OPERATION_QUEUES.delete(key)
  })
}

async function mapWithConcurrency(items, mapper) {
  const results = new Array(items.length)
  let firstError
  let nextIndex = 0
  async function worker() {
    while (!firstError && nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = await mapper(items[index], index)
      } catch (error) {
        firstError ??= error
      }
    }
  }
  const workerCount = Math.min(INFO_CONCURRENCY, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  if (firstError) throw firstError
  return results
}

function stableJson(value) {
  const ancestors = new WeakSet()
  const output = []
  const stack = [{ type: "value", value }]
  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame.type === "text") {
      output.push(frame.text)
      continue
    }
    if (frame.type === "leave") {
      ancestors.delete(frame.value)
      output.push(frame.text)
      continue
    }
    const current = frame.value
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      output.push(JSON.stringify(current))
      continue
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("Outline data must contain only finite JSON numbers")
      output.push(JSON.stringify(current))
      continue
    }
    if (!current || typeof current !== "object") {
      throw new Error("Outline data must be JSON-serializable")
    }
    if (ancestors.has(current)) throw new Error("Outline data must not contain cycles")
    const array = Array.isArray(current)
    if (!array) {
      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Outline data must contain only plain JSON objects")
      }
    }
    const keys = array
      ? Array.from({ length: current.length }, (_, index) => index)
      : Object.keys(current).sort()
    if (keys.length === 0) {
      output.push(array ? "[]" : "{}")
      continue
    }
    ancestors.add(current)
    output.push(array ? "[" : "{")
    stack.push({ text: array ? "]" : "}", type: "leave", value: current })
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]
      let child = current[key]
      if (array && !Object.hasOwn(current, key)) child = null
      stack.push({ type: "value", value: child })
      stack.push({
        text: `${index === 0 ? "" : ","}${array ? "" : `${JSON.stringify(key)}:`}`,
        type: "text",
      })
    }
  }
  return output.join("")
}

function cloneJson(value) {
  return JSON.parse(stableJson(value))
}

function digestEnvelope(kind, key, data) {
  return createHash("sha256")
    .update(stableJson({ data, key, kind, version: ENVELOPE_VERSION }))
    .digest("hex")
}

function renderEnvelope(kind, key, data) {
  const envelope = {
    data,
    digest: digestEnvelope(kind, key, data),
    key,
    kind,
    version: ENVELOPE_VERSION,
  }
  return `\`\`\`json\n${stableJson(envelope)}\n\`\`\``
}

function parseEnvelope(text, expectedKind, expectedKey = undefined) {
  if (typeof text !== "string") throw new Error("Outline document is missing Markdown text")
  const match = /^```json\n([\s\S]+)\n```\n?$/.exec(text)
  if (!match) throw new Error("Outline document has a malformed machine envelope")
  let envelope
  try {
    envelope = JSON.parse(match[1])
  } catch (error) {
    throw new Error(`Outline document contains invalid envelope JSON: ${error.message}`)
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("Outline document envelope must be an object")
  }
  const fields = Object.keys(envelope).sort()
  if (fields.join(",") !== "data,digest,key,kind,version") {
    throw new Error("Outline document envelope has unexpected fields")
  }
  if (stableJson(envelope) !== match[1]) {
    throw new Error("Outline document envelope JSON must use canonical encoding")
  }
  if (envelope.kind !== expectedKind) {
    throw new Error(`Outline document has wrong kind: expected ${expectedKind}`)
  }
  if (envelope.version !== ENVELOPE_VERSION) {
    throw new Error(`Outline document has unsupported envelope version: ${envelope.version}`)
  }
  if (typeof envelope.key !== "string" || envelope.key.length === 0) {
    throw new Error("Outline document envelope key must be a non-empty string")
  }
  if (expectedKey !== undefined && envelope.key !== expectedKey) {
    throw new Error(`Outline document has wrong key: expected ${expectedKey}`)
  }
  const expectedDigest = digestEnvelope(envelope.kind, envelope.key, envelope.data)
  if (envelope.digest !== expectedDigest) throw new Error("Outline document envelope digest mismatch")
  return { data: envelope.data, key: envelope.key }
}

function uuidFromDigestInput(input) {
  const bytes = createHash("sha256").update(input).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function deterministicOutlineDocumentId(collectionId, key) {
  return uuidFromDigestInput(`asset-management:outline\0${collectionId.toLowerCase()}\0${key}`)
}

function assertSafeData(value, label) {
  const forbiddenPaths = findForbiddenPaths(value, label)
  if (forbiddenPaths.length > 0) throw new Error(`${forbiddenPaths[0]} is forbidden`)
  return value
}

function assertSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("snapshot must be an object")
  }
  const prototype = Object.getPrototypeOf(snapshot)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("snapshot must be a plain object")
  }
  return assertSafeData(snapshot, "snapshot")
}

function assertNotification(notification) {
  if (!notification || typeof notification !== "object" || Array.isArray(notification)) {
    throw new Error("notification must be an object")
  }
  registerPeriodNotification([], notification)
  if (notification.created_at !== undefined && !isIsoDateTime(notification.created_at)) {
    throw new Error("notification.created_at must be an ISO date-time")
  }
  assertSafeData(notification, "notification")
  return notification
}

function sameData(left, right) {
  return stableJson(left) === stableJson(right)
}

export class OutlineAssetAdapter {
  #apiToken
  #baseUrl
  #collectionId
  #fetch
  #ids
  #queueKey

  constructor({
    baseUrl = process.env.OUTLINE_URL,
    apiToken = process.env.OUTLINE_API_TOKEN,
    collectionId = process.env.OUTLINE_COLLECTION_ID,
    fetchImpl = globalThis.fetch,
    allowInsecureHttp = false,
  } = {}) {
    if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
      throw new Error("OUTLINE_URL is required")
    }
    if (typeof apiToken !== "string" || apiToken.trim().length === 0) {
      throw new Error("OUTLINE_API_TOKEN is required")
    }
    if (typeof collectionId !== "string" || !UUID_PATTERN.test(collectionId)) {
      throw new Error("OUTLINE_COLLECTION_ID must be a valid UUID")
    }
    if (typeof fetchImpl !== "function") throw new Error("Outline fetch implementation is required")
    if (typeof allowInsecureHttp !== "boolean") {
      throw new Error("allowInsecureHttp must be a boolean")
    }
    const parsedUrl = new URL(baseUrl)
    if (!new Set(["http:", "https:"]).has(parsedUrl.protocol)) {
      throw new Error("OUTLINE_URL must use http or https")
    }
    if (parsedUrl.protocol === "http:" && !allowInsecureHttp) {
      throw new Error("OUTLINE_URL must use https unless allowInsecureHttp is explicitly enabled")
    }
    this.#baseUrl = parsedUrl.toString().replace(/\/+$/, "")
    this.#apiToken = apiToken
    this.#collectionId = collectionId.toLowerCase()
    this.#fetch = fetchImpl
    this.#ids = Object.freeze(Object.fromEntries(
      Object.entries(DOCUMENTS).map(([name, spec]) => [name, this.#documentId(spec.idKey)]),
    ))
    this.#queueKey = `${this.#baseUrl}\0${this.#collectionId}`
  }

  get collectionId() {
    return this.#collectionId
  }

  get documentIds() {
    return { ...this.#ids }
  }

  eventDocumentId(eventId) {
    return this.#documentId(`event:${eventId}`)
  }

  notificationDocumentId(periodId) {
    return this.#documentId(`notification:${periodId}`)
  }

  async bootstrap() {
    return this.#enqueue(async () => {
      const manifests = await this.#bootstrapSystem()
      await this.#readIndexedCollection("events", manifests.events)
      await this.#readIndexedCollection("notifications", manifests.notifications)
      return this.documentIds
    })
  }

  async readHandoff() {
    return this.#enqueue(async () => {
      await this.#bootstrapSystem()
      const data = await this.#readFixed(DOCUMENTS.handoff, this.#ids.handoff)
      if (data === undefined) return null
      assertValidHandoff(data)
      return data
    })
  }

  async writeHandoff(handoff) {
    assertValidHandoff(handoff)
    const input = cloneJson(handoff)
    return this.#enqueue(async () => {
      await this.#bootstrapSystem()
      return this.#writeFixed(DOCUMENTS.handoff, this.#ids.handoff, input)
    })
  }

  async readSnapshot() {
    return this.#enqueue(async () => {
      await this.#bootstrapSystem()
      const snapshot = await this.#readFixed(DOCUMENTS.snapshot, this.#ids.snapshot)
      if (snapshot === undefined) return null
      return assertSnapshot(snapshot)
    })
  }

  async writeSnapshot(snapshot) {
    assertSnapshot(snapshot)
    const input = cloneJson(snapshot)
    return this.#enqueue(async () => {
      await this.#bootstrapSystem()
      return this.#writeFixed(DOCUMENTS.snapshot, this.#ids.snapshot, input)
    })
  }

  async readEvents() {
    return this.#enqueue(async () => {
      const manifests = await this.#bootstrapSystem()
      const state = await this.#readIndexedCollection("events", manifests.events)
      return state.records
    })
  }

  async appendEvent(event) {
    validateEvent(event)
    const input = cloneJson(event)
    return this.#enqueue(() => this.#appendIndexedRecord("events", input))
  }

  async readNotifications() {
    return this.#enqueue(async () => {
      const manifests = await this.#bootstrapSystem()
      const state = await this.#readIndexedCollection("notifications", manifests.notifications)
      return state.records
    })
  }

  async appendNotification(notification) {
    assertNotification(notification)
    const input = cloneJson(notification)
    return this.#enqueue(() => this.#appendIndexedRecord("notifications", input))
  }

  #enqueue(operation) {
    return enqueueOperation(this.#queueKey, operation)
  }

  #registerIndexedRecord(name, records, input) {
    return name === "events"
      ? registerEvent(records, input)
      : registerPeriodNotification(records, input)
  }

  #reconcileIndexedRecord(name, document, input) {
    return name === "events"
      ? this.#reconcileEvent(document, input)
      : this.#reconcileNotification(document, input)
  }

  async #appendIndexedRecord(name, input) {
    const definition = this.#indexDefinition(name)
    const key = input[definition.recordKeyField]
    const spec = this.#recordSpec(name, key, input)
    const manifests = await this.#bootstrapSystem()
    const manifest = manifests[name]
    const state = await this.#readIndexedCollection(name, manifest, {
      allowedOrphan: manifest.created ? null : { id: spec.id, key },
    })
    const indexed = state.recordsById.get(spec.id)
    if (indexed) return this.#reconcileIndexedRecord(name, indexed, input)

    const existing = state.orphanDocument ?? await this.#getDocument(spec.id)
    if (existing) {
      const result = this.#reconcileIndexedRecord(name, existing, input)
      const registration = this.#registerIndexedRecord(name, state.records, input)
      if (registration.status !== definition.acceptedStatus) {
        throw new Error(`Outline unindexed ${definition.resultField} cannot be reconciled: ${key}`)
      }
      await this.#appendIndexEntry(name, state.manifest, key, spec.id)
      return result
    }

    const registration = this.#registerIndexedRecord(name, state.records, input)
    if (registration.status !== definition.acceptedStatus) return registration
    try {
      const created = await this.#createDocument(spec)
      this.#validateStoredDocument(created, spec)
    } catch (error) {
      const reconciled = await this.#getDocument(spec.id)
      if (!reconciled) throw error
      this.#reconcileIndexedRecord(name, reconciled, input)
    }
    await this.#appendIndexEntry(name, state.manifest, key, spec.id)
    return { [definition.resultField]: input, status: definition.acceptedStatus }
  }

  #documentId(key) {
    return deterministicOutlineDocumentId(this.#collectionId, key)
  }

  async #request(endpoint, payload, { missingOk = false } = {}) {
    let response
    try {
      response = await this.#fetch(`${this.#baseUrl}/api/${endpoint}`, {
        body: JSON.stringify(payload),
        headers: {
          Authorization: `Bearer ${this.#apiToken}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        redirect: "error",
      })
    } catch (error) {
      throw new Error(`Outline ${endpoint} request failed: ${error.message}`)
    }
    if (response.status === 404 && missingOk) return null
    let body
    try {
      body = await response.json()
    } catch (error) {
      if (!response.ok) throw this.#httpError(endpoint, response)
      const invalidJsonError = new Error(`Outline ${endpoint} returned invalid JSON (HTTP ${response.status})`)
      invalidJsonError.status = response.status
      throw invalidJsonError
    }
    if (!response.ok || body?.ok !== true) throw this.#httpError(endpoint, response, body)
    return body
  }

  #httpError(endpoint, response, body = undefined) {
    const detail = body?.message ?? body?.error ?? response.statusText ?? "unknown error"
    const retryAfter = response.headers?.get?.("Retry-After") ?? null
    const error = new Error(
      `Outline ${endpoint} failed (HTTP ${response.status}): ${detail}`
        + (retryAfter === null ? "" : `; Retry-After=${retryAfter}`),
    )
    error.status = response.status
    error.responseBody = body
    if (retryAfter !== null) error.retryAfter = retryAfter
    return error
  }

  async #getDocument(id) {
    const response = await this.#request("documents.info", { id }, { missingOk: true })
    if (response === null) return null
    return this.#responseDocument(response, "documents.info")
  }

  async #createDocument(spec) {
    const payload = {
      collectionId: this.#collectionId,
      id: spec.id,
      publish: true,
      text: renderEnvelope(spec.kind, spec.key, spec.data),
      title: spec.title,
    }
    if (spec.parentDocumentId) payload.parentDocumentId = spec.parentDocumentId
    const response = await this.#request("documents.create", payload)
    return this.#responseDocument(response, "documents.create")
  }

  async #updateDocument(spec) {
    const response = await this.#request("documents.update", {
      editMode: "replace",
      id: spec.id,
      publish: true,
      text: renderEnvelope(spec.kind, spec.key, spec.data),
      title: spec.title,
    })
    return this.#responseDocument(response, "documents.update")
  }

  #responseDocument(response, endpoint) {
    if (!response?.data || typeof response.data !== "object" || Array.isArray(response.data)) {
      throw new Error(`Outline ${endpoint} response does not contain document data`)
    }
    return response.data
  }

  #validateLocation(document, { id, parentDocumentId }) {
    if (document.id !== id) throw new Error(`Outline document has unexpected ID: ${document.id}`)
    if (document.collectionId !== this.#collectionId) {
      throw new Error(`Outline document ${id} belongs to another collection`)
    }
    if ((document.parentDocumentId ?? null) !== (parentDocumentId ?? null)) {
      throw new Error(`Outline document ${id} has an unexpected parent`)
    }
    if (document.publishedAt == null || document.archivedAt != null) {
      throw new Error(`Outline document ${id} must be published and not archived`)
    }
  }

  #readStoredDocument(document, spec) {
    this.#validateLocation(document, spec)
    return parseEnvelope(document.text, spec.kind, spec.key).data
  }

  #validateStoredDocument(document, spec) {
    const data = this.#readStoredDocument(document, spec)
    if (!sameData(data, spec.data)) {
      throw new Error(`Outline document conflict: ${spec.key}`)
    }
    return data
  }

  #indexDefinition(name) {
    const definition = INDEXED_COLLECTIONS[name]
    if (!definition) throw new Error(`Unsupported Outline index: ${name}`)
    return definition
  }

  #manifestSpec(name, data = undefined) {
    const definition = this.#indexDefinition(name)
    const documentSpec = DOCUMENTS[definition.index]
    const spec = {
      ...documentSpec,
      id: this.#ids[definition.index],
      parentDocumentId: this.#ids[definition.container],
    }
    if (data !== undefined) spec.data = data
    return spec
  }

  #recordSpec(name, key, data) {
    const definition = this.#indexDefinition(name)
    return {
      data,
      id: this.#documentId(`${definition.recordIdPrefix}:${key}`),
      key,
      kind: definition.recordKind,
      parentDocumentId: this.#ids[definition.container],
      title: `${definition.recordTitlePrefix} ${key}`,
    }
  }

  #emptyIndex() {
    return { entries: [], index_version: INDEX_VERSION }
  }

  #validateIndex(name, data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`Outline ${name} index must be an object`)
    }
    if (Object.keys(data).sort().join(",") !== "entries,index_version") {
      throw new Error(`Outline ${name} index has unexpected fields`)
    }
    if (data.index_version !== INDEX_VERSION) {
      throw new Error(`Outline ${name} index has unsupported version: ${data.index_version}`)
    }
    if (!Array.isArray(data.entries)) throw new Error(`Outline ${name} index entries must be an array`)
    const definition = this.#indexDefinition(name)
    const ids = new Set()
    const keys = new Set()
    for (let index = 0; index < data.entries.length; index += 1) {
      const entry = data.entries[index]
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`Outline ${name} index entry ${index + 1} must be an object`)
      }
      if (Object.keys(entry).sort().join(",") !== "document_id,key,sequence") {
        throw new Error(`Outline ${name} index entry ${index + 1} has unexpected fields`)
      }
      if (entry.sequence !== index + 1) {
        throw new Error(`Outline ${name} index sequence must be contiguous`)
      }
      if (typeof entry.key !== "string" || entry.key.length === 0) {
        throw new Error(`Outline ${name} index entry ${index + 1} has an invalid key`)
      }
      const expectedId = this.#documentId(`${definition.recordIdPrefix}:${entry.key}`)
      if (entry.document_id !== expectedId) {
        throw new Error(`Outline ${name} index entry ${index + 1} has an unexpected document ID`)
      }
      if (ids.has(entry.document_id) || keys.has(entry.key)) {
        throw new Error(`Outline ${name} index contains a duplicate entry`)
      }
      ids.add(entry.document_id)
      keys.add(entry.key)
    }
    return data
  }

  #readManifestDocument(name, document) {
    const data = this.#readStoredDocument(document, this.#manifestSpec(name))
    return this.#validateIndex(name, data)
  }

  async #ensureManifest(name) {
    const spec = this.#manifestSpec(name, this.#emptyIndex())
    const existing = await this.#getDocument(spec.id)
    if (existing) {
      return {
        created: false,
        data: this.#readManifestDocument(name, existing),
        document: existing,
      }
    }
    let document
    try {
      document = await this.#createDocument(spec)
      this.#validateStoredDocument(document, spec)
    } catch (error) {
      document = await this.#getDocument(spec.id)
      if (!document) throw error
      this.#readManifestDocument(name, document)
    }
    return {
      created: true,
      data: this.#readManifestDocument(name, document),
      document,
    }
  }

  async #bootstrapSystem() {
    await this.#ensureSystemDocument({
      ...DOCUMENTS.root,
      data: { role: "root" },
      id: this.#ids.root,
      parentDocumentId: null,
    })
    await this.#ensureSystemDocument({
      ...DOCUMENTS.events,
      data: { role: "events" },
      id: this.#ids.events,
      parentDocumentId: this.#ids.root,
    })
    await this.#ensureSystemDocument({
      ...DOCUMENTS.notifications,
      data: { role: "notifications" },
      id: this.#ids.notifications,
      parentDocumentId: this.#ids.root,
    })
    return {
      events: await this.#ensureManifest("events"),
      notifications: await this.#ensureManifest("notifications"),
    }
  }

  async #ensureSystemDocument(spec) {
    const existing = await this.#getDocument(spec.id)
    if (existing) {
      this.#validateStoredDocument(existing, spec)
      return spec.id
    }
    try {
      const created = await this.#createDocument(spec)
      this.#validateStoredDocument(created, spec)
    } catch (error) {
      const reconciled = await this.#getDocument(spec.id)
      if (!reconciled) throw error
      this.#validateStoredDocument(reconciled, spec)
    }
    return spec.id
  }

  async #readFixed(documentSpec, id) {
    const existing = await this.#getDocument(id)
    if (!existing) return undefined
    return this.#readStoredDocument(existing, {
      ...documentSpec,
      id,
      parentDocumentId: this.#ids.root,
    })
  }

  async #writeFixed(documentSpec, id, input) {
    const data = input
    const spec = {
      ...documentSpec,
      data,
      id,
      parentDocumentId: this.#ids.root,
    }
    let existing = await this.#getDocument(id)
    if (!existing) {
      try {
        const created = await this.#createDocument(spec)
        this.#validateStoredDocument(created, spec)
        return data
      } catch (error) {
        existing = await this.#getDocument(id)
        if (!existing) throw error
      }
    }
    const stored = this.#readStoredDocument(existing, spec)
    if (sameData(stored, data)) return data
    try {
      const updated = await this.#updateDocument(spec)
      this.#validateStoredDocument(updated, spec)
    } catch (error) {
      const reconciled = await this.#getDocument(id)
      if (!reconciled) throw error
      try {
        this.#validateStoredDocument(reconciled, spec)
      } catch {
        throw error
      }
    }
    return data
  }

  async #listChildDocuments(parentDocumentId) {
    const documents = []
    const seenIds = new Set()
    let offset = 0
    let expectedTotal
    while (true) {
      const response = await this.#request("documents.list", {
        collectionId: this.#collectionId,
        direction: "ASC",
        limit: PAGE_LIMIT,
        offset,
        parentDocumentId,
        sort: "createdAt",
        statusFilter: ["published", "draft", "archived"],
      })
      if (!Array.isArray(response.data)) {
        throw new Error("Outline documents.list response does not contain a document array")
      }
      if (response.data.length > PAGE_LIMIT) {
        throw new Error("Outline documents.list exceeded the requested page limit")
      }
      for (const document of response.data) {
        if (!document || typeof document !== "object" || Array.isArray(document)) {
          throw new Error("Outline documents.list returned an invalid document")
        }
        if (!isIsoDateTime(document.createdAt)) {
          throw new Error(`Outline document ${document.id ?? "unknown"} has invalid createdAt`)
        }
        this.#validateLocation(document, { id: document.id, parentDocumentId })
        if (seenIds.has(document.id)) {
          throw new Error(`Outline documents.list repeated document ID: ${document.id}`)
        }
        seenIds.add(document.id)
        documents.push(document)
      }
      offset += response.data.length
      const total = response.pagination?.total
      if (Number.isInteger(total)) {
        if (expectedTotal === undefined) expectedTotal = total
        else if (total !== expectedTotal) throw new Error("Outline documents.list total changed during pagination")
        if (offset >= total) break
      }
      if (response.data.length === 0) break
      if (!response.pagination?.nextPath && response.data.length < PAGE_LIMIT) break
    }
    if (expectedTotal !== undefined && documents.length !== expectedTotal) {
      throw new Error("Outline documents.list returned an incomplete result set")
    }
    return documents
  }

  #readRecordDocument(name, document, entry) {
    const definition = this.#indexDefinition(name)
    const data = this.#readStoredDocument(document, {
      id: entry.document_id,
      key: entry.key,
      kind: definition.recordKind,
      parentDocumentId: this.#ids[definition.container],
    })
    if (data[definition.recordKeyField] !== entry.key) {
      throw new Error(`Outline ${name} record key mismatch: ${entry.key}`)
    }
    if (name === "events") validateEvent(data)
    else assertNotification(data)
    return data
  }

  async #readIndexedCollection(name, manifest, { allowedOrphan = null } = {}) {
    const definition = this.#indexDefinition(name)
    const manifestSpec = this.#manifestSpec(name)
    const entries = manifest.data.entries
    const storedRecords = await mapWithConcurrency(entries, async (entry) => {
      const document = await this.#getDocument(entry.document_id)
      if (document === null) {
        throw new Error(`Outline indexed ${name} document is missing or deleted: ${entry.document_id}`)
      }
      return { data: this.#readRecordDocument(name, document, entry), document }
    })
    const records = storedRecords.map(({ data }) => data)
    const recordsById = new Map(storedRecords.map(({ document }) => [document.id, document]))

    let orphanDocument = null
    if (allowedOrphan && !recordsById.has(allowedOrphan.id)) {
      orphanDocument = await this.#getDocument(allowedOrphan.id)
      if (orphanDocument) {
        this.#readRecordDocument(name, orphanDocument, {
          document_id: allowedOrphan.id,
          key: allowedOrphan.key,
        })
      }
    }

    const listedDocuments = await this.#listChildDocuments(this.#ids[definition.container])
    const listedIds = new Set()
    for (const document of listedDocuments) {
      if (listedIds.has(document.id)) {
        throw new Error(`Outline ${name} container listing contains a duplicate document ID`)
      }
      listedIds.add(document.id)
    }
    const expectedIds = new Set([manifestSpec.id, ...entries.map((entry) => entry.document_id)])
    for (const id of expectedIds) {
      if (!listedIds.has(id)) throw new Error(`Outline ${name} index mismatch: missing direct child ${id}`)
    }
    for (const id of listedIds) {
      if (!expectedIds.has(id) && id !== allowedOrphan?.id) {
        throw new Error(`Outline ${name} index mismatch: unindexed orphan ${id}`)
      }
    }
    if (allowedOrphan
      && listedIds.has(allowedOrphan.id)
      && !recordsById.has(allowedOrphan.id)
      && !orphanDocument) {
      throw new Error(`Outline ${name} orphan disappeared during verification: ${allowedOrphan.id}`)
    }
    return { manifest, orphanDocument, records, recordsById }
  }

  async #writeManifest(name, manifest, data) {
    this.#validateIndex(name, data)
    const spec = this.#manifestSpec(name, data)
    let document
    try {
      document = await this.#updateDocument(spec)
      this.#validateStoredDocument(document, spec)
    } catch (error) {
      document = await this.#getDocument(spec.id)
      if (!document) throw error
      const stored = this.#readManifestDocument(name, document)
      if (!sameData(stored, data)) {
        if (sameData(stored, manifest.data)) throw error
        throw new Error(`Outline ${name} index changed during update`)
      }
    }
    return { created: false, data, document }
  }

  async #appendIndexEntry(name, manifest, key, documentId) {
    if (manifest.data.entries.some((entry) => entry.document_id === documentId || entry.key === key)) {
      throw new Error(`Outline ${name} index already contains ${key}`)
    }
    const data = {
      entries: [
        ...manifest.data.entries,
        {
          document_id: documentId,
          key,
          sequence: manifest.data.entries.length + 1,
        },
      ],
      index_version: INDEX_VERSION,
    }
    return this.#writeManifest(name, manifest, data)
  }

  #reconcileEvent(document, input) {
    const spec = {
      data: input,
      id: this.eventDocumentId(input.event_id),
      key: input.event_id,
      kind: "asset-management-event",
      parentDocumentId: this.#ids.events,
    }
    const stored = this.#readStoredDocument(document, spec)
    validateEvent(stored)
    if (!sameData(stored, input)) throw new Error(`Outline event conflict: ${input.event_id}`)
    return { event: stored, existing_event_id: input.event_id, status: "duplicate" }
  }

  #reconcileNotification(document, input) {
    const spec = {
      id: this.notificationDocumentId(input.period_id),
      key: input.period_id,
      kind: "asset-management-notification",
      parentDocumentId: this.#ids.notifications,
    }
    const stored = this.#readStoredDocument(document, spec)
    assertNotification(stored)
    if (stored.period_id !== input.period_id) {
      throw new Error(`Outline notification conflict: ${input.period_id}`)
    }
    return { notification: stored, status: "already_notified" }
  }
}
