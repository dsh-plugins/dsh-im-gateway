#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { dshPath } from '@deepseek-ai/dsh-home-paths'
import { localeOf } from '../dist/i18n.js'
import { GatewayState, loginWechat } from '../dist/index.js'

const channels = ['telegram', 'wechat', 'feishu', 'wecom', 'onebot', 'qq', 'discord']
function dictionary(locale) {
  return JSON.parse(readFileSync(new URL('../locale/' + locale + '.json', import.meta.url), 'utf8')).cli
}
const environmentLocale = [process.env.DSH_LOCALE, process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG,
  Intl.DateTimeFormat().resolvedOptions().locale].map(localeOf).find(Boolean) ?? 'en'
let copy = dictionary(environmentLocale)
function tr(key, params = {}) { return copy[key].replace(/\{(\w+)\}/g, (_, name) => params[name]) }
class CliError extends Error {}
function help() {
  return `prism-im login wechat|feishu [--config prism.config.json]
prism-im pair CHANNEL[/BOT] [--config prism.config.json]
prism-im setup CHANNEL --config prism.config.json

login          ${tr('login')}
pair           ${tr('pair')}
setup          ${tr('setup')}
--config FILE  ${tr('config')}
--state FILE   ${tr('state')}
${tr('channels')} · ${channels.join(', ')}`
}

async function configAt(path) {
  const config = JSON.parse(await readFile(path, 'utf8'))
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      (config.im && (typeof config.im !== 'object' || Array.isArray(config.im)))) {
    throw new CliError(tr('invalidConfig'))
  }
  return config
}

async function enable(path, name, fields, stateOverride, qrLogin = false) {
  const config = await configAt(path)
  config.im ??= {}
  config.im[name] = { ...config.im[name], ...fields }
  if (stateOverride) config.im.statePath = resolve(stateOverride)
  if (qrLogin && name === 'feishu') {
    // A newly registered app owns its own domain, credentials and verified account.
    for (const key of ['appId', 'appSecretEnv', 'domain']) delete config.im.feishu[key]
  }
  const temporary = path + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: (await stat(path)).mode & 0o777 })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, state: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } })
  const path = values.config && resolve(values.config)
  const config = path && await configAt(path)
  copy = dictionary(localeOf(config?.im?.locale) ?? environmentLocale)
  if (values.help || !positionals.length) { console.log(help()); return }
  const [op, target] = positionals
  const platform = target?.split('/')[0]
  if (positionals.length !== 2 || !channels.includes(platform) ||
      !['pair', 'login', 'setup'].includes(op) || (op !== 'pair' && target !== platform)) throw new CliError(help())
  let database = values.state
  if (!database && config && config.im?.statePath) database = resolve(dirname(path), config.im.statePath)
  if (!database) database = dshPath('data', 'prism', 'im.sqlite')
  const stop = new AbortController()
  const abort = () => stop.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  const state = new GatewayState(database)
  let prompt
  function ask(label) {
    prompt ??= createInterface({ input: process.stdin, output: process.stdout })
    return prompt.question(label + ' ', { signal: stop.signal })
  }
  try {
    if (op === 'pair') {
      console.log('/pair ' + state.issuePairingCode(target))
      console.log(tr('paired'))
      return
    }
    if (op === 'login') {
      if (!['wechat', 'feishu'].includes(platform)) throw new CliError(tr('onlyQr'))
      const { default: qr } = await import('qrcode-terminal')
      const show = link => { console.log(tr('login')); qr.generate(link, { small: true }); console.log(link) }
      if (platform === 'wechat') await loginWechat(state, show, () => ask(tr('digits')), stop.signal)
      else {
        const { loginFeishu } = await import('../dist/feishu.js')
        await loginFeishu(state, show, stop.signal)
      }
      if (path) await enable(path, platform, {}, values.state, true)
      console.log(path ? tr('authorized') : tr('enable', { platform }))
      return
    }
    if (!path) throw new CliError(tr('configNeeded'))
    const channel = config.im?.[platform] ?? {}
    const fields = {}
    const requiredFields = {
      wecom: ['botId'], qq: ['appId'], onebot: ['selfId', 'apiBase'],
    }
    for (const field of requiredFields[platform] ?? []) {
      if (!channel[field]) {
        fields[field] = (await ask(tr('field', { platform, field }))).trim()
        if (!fields[field]) throw new CliError(tr('missing', { field }))
      }
    }
    const secrets = {
      telegram: [channel.tokenEnv ?? 'TELEGRAM_BOT_TOKEN'], discord: [channel.tokenEnv ?? 'DISCORD_BOT_TOKEN'],
      qq: [channel.appSecretEnv ?? 'QQ_BOT_SECRET'], wecom: [channel.secretEnv ?? 'WECOM_BOT_SECRET'],
      onebot: [channel.accessTokenEnv ?? 'ONEBOT_ACCESS_TOKEN', channel.eventSecretEnv ?? 'ONEBOT_EVENT_SECRET'],
    }
    if (secrets[platform]) console.log(tr('env', { vars: secrets[platform].join(', ') }))
    else console.log(tr('runLogin', { command: 'prism-im login ' + platform + ' --config ' + JSON.stringify(path) }))
    await enable(path, platform, fields, values.state)
    console.log(tr('enabled', { platform }))
    if (secrets[platform]) console.log(tr('pairInfo') + '\n/pair ' + state.issuePairingCode(platform))
  } finally {
    prompt?.close()
    state.close()
    process.off('SIGINT', abort)
    process.off('SIGTERM', abort)
  }
}
main().catch(error => {
  // Third-party SDK failures can include request objects. Keep credential-bearing fields off the terminal.
  const code = typeof error?.code === 'string' && /^[A-Z_0-9]+$/.test(error.code) ? ' (' + error.code + ')' : ''
  console.error(error instanceof CliError ? error.message : tr('failed') + code)
  process.exitCode = 1
})
