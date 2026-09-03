import { readFile } from "node:fs/promises"
import { validateHandoff } from "./handoff.mjs"

const filePath = process.argv[2]
if (!filePath) {
  console.error("Usage: node validate-handoff.mjs <handoff.json>")
  process.exit(2)
}

try {
  const handoff = JSON.parse(await readFile(filePath, "utf8"))
  const errors = validateHandoff(handoff)
  if (errors.length > 0) {
    for (const error of errors) console.error(error)
    process.exit(1)
  }
  console.log("handoff is valid")
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
