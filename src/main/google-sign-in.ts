// Google refuses to sign in from browsers built on Electron ("This browser or app may not be
// secure"). Removing "Electron" from the user agent is not enough: Google sees a Chromium that
// isn't Google Chrome and still says no. It does accept Firefox, so on Google's sign-in host
// Stage presents itself as Firefox. The rest of the web, Gmail and YouTube included, keeps
// seeing Stage's normal Chrome user agent and the session cookies the sign-in left behind.
//
// Two halves: request headers here, and what the page's scripts read in
// src/preload/google-sign-in.ts. Both key off the URL alone, so a redirect into or out of the
// sign-in host needs no bookkeeping.
import { ipcMain, type Session } from 'electron'
import { join } from 'node:path'

const SIGN_IN_HOST = 'accounts.google.com'
const UA_CHANNEL = 'stage:google-sign-in-ua'

// Firefox ships a release every four weeks. Claim the one before the current release, so the
// version stays believable as time passes without ever naming a release that doesn't exist yet.
const FIREFOX_140 = Date.UTC(2025, 5, 24)
const RELEASE_CYCLE = 28 * 24 * 60 * 60 * 1000

export function firefoxUA(now = Date.now()): string {
  const version = Math.max(140, 140 + Math.floor((now - FIREFOX_140) / RELEASE_CYCLE) - 1)
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${version}.0) Gecko/20100101 Firefox/${version}.0`
}

export function isGoogleSignIn(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname === SIGN_IN_HOST
  } catch {
    return false
  }
}

/** Presents `session` as Firefox to Google's sign-in host, in its request headers and page scripts. */
export function setupGoogleSignIn(session: Session): void {
  const firefox = firefoxUA()

  // Firefox sends no client hints, so the Sec-CH-UA family goes too.
  session.webRequest.onBeforeSendHeaders({ urls: [`https://${SIGN_IN_HOST}/*`] }, (details, callback) => {
    const headers = { ...details.requestHeaders }
    for (const name of Object.keys(headers)) if (/^sec-ch-ua/i.test(name)) delete headers[name]
    headers['User-Agent'] = firefox
    callback({ requestHeaders: headers })
  })

  ipcMain.on(UA_CHANNEL, (e) => {
    e.returnValue = firefox
  })
  session.registerPreloadScript({ id: 'stage-google-sign-in', type: 'frame', filePath: join(__dirname, '..', 'preload', 'google-sign-in.js') })
}
