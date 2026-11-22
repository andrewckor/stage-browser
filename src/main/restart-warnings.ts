// What a restart would lose right now, so an update never ends a download, a call or a half-written
// form without saying so first. Looking never changes a page: no script of the page's runs, and no
// event is sent to it.
import type { DownloadItem, WebContents } from 'electron'
import type { Ctx } from './context'

const PROBE_MS = 1500
const SHOWN = 3
const TITLE_MAX = 40

const downloads = new Set<DownloadItem>()

export function trackDownload(item: DownloadItem): void {
  downloads.add(item)
  item.once('done', () => downloads.delete(item))
}

interface Listener {
  type: string
}

/**
 * Whether the page has a beforeunload handler, the way a page asks to keep unsaved changes. The
 * DevTools protocol lists the handlers without calling them. Some pages always have one, so this
 * says "may".
 */
async function asksBeforeLeaving(wc: WebContents): Promise<boolean> {
  if (wc.isDestroyed() || wc.debugger.isAttached()) return false
  try {
    wc.debugger.attach('1.3')
  } catch {
    return false // DevTools may hold it
  }
  const group = 'stage-restart'
  try {
    const { result } = (await wc.debugger.sendCommand('Runtime.evaluate', { expression: 'window', objectGroup: group, silent: true })) as { result: { objectId?: string } }
    if (!result.objectId) return false
    const { listeners } = (await wc.debugger.sendCommand('DOMDebugger.getEventListeners', { objectId: result.objectId })) as { listeners: Listener[] }
    return listeners.some((l) => l.type === 'beforeunload')
  } catch {
    return false
  } finally {
    await wc.debugger.sendCommand('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {})
    try {
      wc.debugger.detach()
    } catch {
      // already gone
    }
  }
}

const within = <T>(work: Promise<T>, fallback: T): Promise<T> => Promise.race([work, new Promise<T>((done) => setTimeout(() => done(fallback), PROBE_MS))])

const quoted = (title: string): string => {
  const flat = title.replace(/\s+/g, ' ').trim() || 'A tab'
  return `“${flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat}”`
}

function names(titles: string[]): string {
  const shown = titles.slice(0, SHOWN).map(quoted)
  const more = titles.length - shown.length
  if (more > 0) shown.push(`${more} more`)
  return shown.length < 2 ? (shown[0] ?? '') : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}

/** One sentence per kind of loss, empty when a restart loses nothing Stage can see. */
export async function restartWarnings(ctx: Ctx): Promise<string[]> {
  const out: string[] = []
  const active = [...downloads].filter((d) => d.getState() === 'progressing')
  if (active.length) out.push(active.length === 1 ? 'A download is still in progress.' : `${active.length} downloads are still in progress.`)

  const tabs = ctx.tabs.list.filter((t) => !t.wc.isDestroyed())
  const sound = tabs.filter((t) => t.wc.isCurrentlyAudible())
  if (sound.length) out.push(`${names(sound.map((t) => t.title))} ${sound.length === 1 ? 'is' : 'are'} playing sound.`)

  const asking = await Promise.all(tabs.map((t) => within(asksBeforeLeaving(t.wc), false)))
  const unsaved = tabs.filter((_, i) => asking[i])
  if (unsaved.length) out.push(`${names(unsaved.map((t) => t.title))} may have unsaved changes.`)
  return out
}
