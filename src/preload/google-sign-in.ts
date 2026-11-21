// On Google's sign-in host, makes the page's own scripts see the Firefox user agent that
// src/main/google-sign-in.ts sends in the request headers. Runs in every frame of the browsing
// session and does nothing anywhere else. Changing the user agent from the main process instead
// (webContents.setUserAgent) aborts Electron when a redirect crosses the host boundary.
//
// A script, not a module: sandboxed preloads have no `exports`.
{
  const { contextBridge, ipcRenderer }: typeof import('electron') = require('electron')

  if (location.protocol === 'https:' && location.hostname === 'accounts.google.com') {
    try {
      const ua: string = ipcRenderer.sendSync('stage:google-sign-in-ua')
      contextBridge.executeInMainWorld({
        // Serialized into the page's main world, so everything it uses must live inside it.
        func: (userAgent: string) => {
          const appVersion = userAgent.slice(userAgent.indexOf('/') + 1)
          for (const [name, value] of [['userAgent', userAgent], ['appVersion', appVersion]] as const) {
            Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true, enumerable: true })
          }
        },
        args: [ua],
      })
    } catch (e) {
      console.error('[stage] google-sign-in preload failed', e)
    }
  }
}
