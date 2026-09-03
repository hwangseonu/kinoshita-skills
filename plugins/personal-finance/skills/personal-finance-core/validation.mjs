export const FORBIDDEN_KEYS = new Set([
  "accountnumber",
  "cardnumber",
  "password",
  "cvc",
  "cvv",
  "otp",
  "login",
  "loginid",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "secret",
])

const FORBIDDEN_KEY_WORDS = new Set([
  "cvc",
  "cvv",
  "credential",
  "credentials",
  "login",
  "otp",
  "password",
  "secret",
  "secrets",
  "token",
  "tokens",
])

const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/

export function isIsoDateTime(value) {
  if (typeof value !== "string") return false
  const match = ISO_DATE_TIME.exec(value)
  if (!match) return false
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const offsetHour = Number(offsetHourText ?? 0)
  const offsetMinute = Number(offsetMinuteText ?? 0)
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0
  return day >= 1
    && day <= daysInMonth
    && hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 23
    && offsetMinute <= 59
    && Number.isFinite(Date.parse(value))
}

export function findForbiddenPaths(value, path = "value", paths = []) {
  const stack = [[value, path]]
  const visited = new WeakSet()
  while (stack.length > 0) {
    const [current, currentPath] = stack.pop()
    if (!current || typeof current !== "object" || visited.has(current)) continue
    visited.add(current)
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push([current[index], `${currentPath}[${index}]`])
      }
      continue
    }
    const entries = Object.entries(current)
    for (const [key] of entries) {
      const words = key
        .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
      const normalizedKey = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
      const hasNumberIdentifier = words.some((word, index) => {
        return word === "number" && (words[index - 1] === "account" || words[index - 1] === "card")
      })
      const hasApiKey = words.some((word, index) => word === "key" && words[index - 1] === "api")
      const hasSensitiveWord = words.some((word) => FORBIDDEN_KEY_WORDS.has(word))
      const hasSensitiveSuffix = [
        "accountnumber",
        "cardnumber",
        "password",
        "cvc",
        "cvv",
        "otp",
        "loginid",
        "apikey",
        "credential",
        "credentials",
        "secret",
        "token",
      ].some((suffix) => normalizedKey.endsWith(suffix))
      if (FORBIDDEN_KEYS.has(normalizedKey)
        || hasNumberIdentifier
        || hasApiKey
        || hasSensitiveWord
        || hasSensitiveSuffix) {
        paths.push(`${currentPath}.${key}`)
      }
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index]
      stack.push([child, `${currentPath}.${key}`])
    }
  }
  return paths
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function typeMatches(value, type) {
  switch (type) {
    case "object": return isObject(value)
    case "array": return Array.isArray(value)
    case "string": return typeof value === "string"
    case "integer": return Number.isSafeInteger(value)
    case "number": return typeof value === "number" && Number.isFinite(value)
    case "boolean": return typeof value === "boolean"
    case "null": return value === null
    default: throw new Error(`unsupported JSON Schema type: ${type}`)
  }
}

function resolveReference(reference, rootSchema) {
  if (!reference.startsWith("#/")) throw new Error(`unsupported JSON Schema reference: ${reference}`)
  return reference
    .slice(2)
    .split("/")
    .reduce((value, segment) => value[segment.replaceAll("~1", "/").replaceAll("~0", "~")], rootSchema)
}

export function validateJsonSchema(value, schema, path = "value", rootSchema = schema) {
  if (schema.$ref) {
    return validateJsonSchema(value, resolveReference(schema.$ref, rootSchema), path, rootSchema)
  }
  const errors = []

  if (schema.not && validateJsonSchema(value, schema.not, path, rootSchema).length === 0) {
    errors.push(`${path} matches a forbidden schema`)
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`)
  }
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push(`${path} must be one of ${schema.enum.join(", ")}`)
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push(`${path} must be ${types.join(" or ")}`)
      return errors
    }
  }

  if (schema.anyOf) {
    const matches = schema.anyOf.some((candidate) => {
      return validateJsonSchema(value, candidate, path, rootSchema).length === 0
    })
    if (!matches) errors.push(`${path} must match at least one allowed schema`)
  }
  if (schema.oneOf) {
    const matchCount = schema.oneOf.filter((candidate) => {
      return validateJsonSchema(value, candidate, path, rootSchema).length === 0
    }).length
    if (matchCount !== 1) errors.push(`${path} must match exactly one allowed schema`)
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path} must have at least ${schema.minLength} characters`)
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path} must have at most ${schema.maxLength} characters`)
    }
    if (schema.format === "date-time" && !isIsoDateTime(value)) {
      errors.push(`${path} must be an ISO date-time`)
    }
  }

  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path} must be greater than or equal to ${schema.minimum}`)
  }
  if (typeof value === "number" && schema.maximum !== undefined && value > schema.maximum) {
    errors.push(`${path} must be less than or equal to ${schema.maximum}`)
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path} must contain at least ${schema.minItems} items`)
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateJsonSchema(item, schema.items, `${path}[${index}]`, rootSchema))
      })
    }
  }

  if (isObject(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`)
    }
    if (schema.additionalProperties === false) {
      for (const [key, child] of Object.entries(value)) {
        if (schema.properties?.[key]) {
          errors.push(...validateJsonSchema(child, schema.properties[key], `${path}.${key}`, rootSchema))
        } else {
          errors.push(`${path}.${key} is not allowed`)
        }
      }
    } else {
      for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
        if (Object.hasOwn(value, key)) {
          errors.push(...validateJsonSchema(value[key], childSchema, `${path}.${key}`, rootSchema))
        }
      }
    }
  }

  for (const childSchema of schema.allOf ?? []) {
    errors.push(...validateJsonSchema(value, childSchema, path, rootSchema))
  }
  if (schema.if) {
    const conditionMatches = validateJsonSchema(value, schema.if, path, rootSchema).length === 0
    if (conditionMatches && schema.then) {
      errors.push(...validateJsonSchema(value, schema.then, path, rootSchema))
    } else if (!conditionMatches && schema.else) {
      errors.push(...validateJsonSchema(value, schema.else, path, rootSchema))
    }
  }
  return errors
}
