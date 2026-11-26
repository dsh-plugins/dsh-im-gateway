import { readFileSync } from 'node:fs'

export const locales = ['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'] as const
export type Locale = (typeof locales)[number]
export function localeOf(code?: string): Locale | undefined {
  const language = typeof code === 'string' ? code.trim().toLowerCase().split(/[-_.@]/)[0] : undefined
  return locales.find(l => l === language)
}
interface Messages {
  help: string; task: string; queued: string; running: string; completed: string; failed: string;
  user: string; assistant: string; tool: string; system: string; noModel: string; currentModel: string;
  selected: string; modelHint: string; noTasks: string; missingTask: string; trace: string;
  noTrace: string; inspect: string; paired: string; language: string
}
const catalogs = new Map<Locale, Messages>()
export function messages(locale: Locale): Messages {
  let found = catalogs.get(locale)
  if (!found) {
    found = JSON.parse(readFileSync(new URL('../locale/' + locale + '.json', import.meta.url), 'utf8')).messages as Messages
    catalogs.set(locale, found)
  }
  return found
}
