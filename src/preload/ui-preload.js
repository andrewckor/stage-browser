'use strict'
// Preload for the overlay UI view (sandbox: false, contextIsolation: true).
const { contextBridge, ipcRenderer } = require('electron')
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action')

// <browser-action-list> custom element for extension icons
injectBrowserAction()

const send = (channel, ...args) => ipcRenderer.send(channel, ...args)

contextBridge.exposeInMainWorld('stage', {
  getState: () => ipcRenderer.invoke('stage:getState'),
  onState(cb) {
    const handler = (_e, state) => cb(state)
    ipcRenderer.on('stage:state', handler)
    return () => ipcRenderer.removeListener('stage:state', handler)
  },

  activateTab: (id) => send('stage:activateTab', id),
  closeTab: (id) => send('stage:closeTab', id),
  moveTab: (id, toIndex) => send('stage:moveTab', id, toIndex),
  showTabMenu: (id) => send('stage:showTabMenu', id),

  openOmnibox: (mode) => send('stage:openOmnibox', mode),
  closeOverlay: () => send('stage:closeOverlay'),
  suggest: (query) => ipcRenderer.invoke('stage:suggest', query),
  submitOmnibox: (input, opts) => send('stage:submitOmnibox', input, opts),

  back: () => send('stage:back'),
  forward: () => send('stage:forward'),
  reload: () => send('stage:reload'),

  setBarHover: (hovering) => send('stage:setBarHover', !!hovering),
  // A click in the transparent band under the floating bar: hide the bar and give the click to the page.
  passClick: (x, y, button, clickCount) => send('stage:passClick', x, y, button, clickCount),

  // Window dragging fallback (see docs): call on mousedown over empty bar background,
  // endWindowDrag on mouseup / pointercancel / blur. Main moves the window by cursor delta.
  startWindowDrag: () => send('stage:startWindowDrag'),
  endWindowDrag: () => send('stage:endWindowDrag'),
})
