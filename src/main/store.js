'use strict'
const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const file = (name) => path.join(app.getPath('userData'), name)

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(name, data) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    const tmp = file(name) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data))
    fs.renameSync(tmp, file(name))
  } catch (e) {
    console.error('[stage] write failed', name, e.message)
  }
}

// ---- history -------------------------------------------------------------
const HISTORY_CAP = 2000
let history = null // Map url -> {url,title,visits,last}
let historyTimer = null

function loadHistory() {
  if (history) return history
  history = new Map()
  for (const h of readJson('history.json', [])) if (h && h.url) history.set(h.url, h)
  return history
}

function addVisit(url, title) {
  const h = loadHistory()
  const e = h.get(url) || { url, title: '', visits: 0, last: 0 }
  e.visits++
  e.last = Date.now()
  if (title) e.title = title
  h.delete(url)
  h.set(url, e)
  if (h.size > HISTORY_CAP) {
    const sorted = [...h.values()].sort((a, b) => b.last - a.last).slice(0, HISTORY_CAP)
    history = new Map(sorted.map((x) => [x.url, x]))
  }
  scheduleHistorySave()
}

function setHistoryTitle(url, title) {
  const e = loadHistory().get(url)
  if (e && title && e.title !== title) {
    e.title = title
    scheduleHistorySave()
  }
}

function scheduleHistorySave() {
  clearTimeout(historyTimer)
  historyTimer = setTimeout(flushHistory, 2000)
}

function flushHistory() {
  clearTimeout(historyTimer)
  historyTimer = null
  if (history) writeJson('history.json', [...history.values()])
}

function historyEntries() {
  return [...loadHistory().values()]
}

module.exports = { readJson, writeJson, addVisit, setHistoryTitle, historyEntries, flushHistory }
