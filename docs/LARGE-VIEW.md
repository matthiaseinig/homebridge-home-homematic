# Large view (settings in a separate window)

The Homebridge UI opens every plugin settings dialog with a fixed, narrow
size. "Open large view" in the dialog header opens a full-width channel
table in its own browser window.

## Use

1. Open the plugin settings in the Homebridge UI and press **Open large view**.
   The dialog form is hidden while the large view is open.
2. In the new window, search and edit: HomeKit on/off, name, service,
   variant and bridge. **CCU einlesen** loads all channels from the CCU.
3. Press **Übernehmen**. The changes are staged in the dialog.
4. Press **Save** in the dialog. Homebridge makes its config backup and
   offers to restart the child bridge.

Closing the dialog closes the large view and its listener.

## How it works

| Part | File |
| --- | --- |
| Listener (static files only) | `src/ui/largeViewServer.ts` |
| Start, reuse, stop, shutdown on dialog close | `src/ui/largeViewController.ts`, `/large-view/info` and `/large-view/stop` in `homebridge-ui/server.src.js` |
| postMessage link (shared kit) | `homebridge-ui/public/kit/link.js` |
| Dialog side: snapshot, checks, apply | `homebridge-ui/public/large-view-host.js`, `app.js` |
| Page | `homebridge-ui/large-view/` |

- The custom UI server child (forked by config-ui-x while the dialog is open)
  starts the listener on `/large-view/info`. It binds to the one private
  address the dialog iframe was loaded from (a literal IP, or a host name
  that resolves to a private address of this host), on a random port.
- Every response carries `frame-ancestors 'none'`, `X-Frame-Options: DENY`
  and a CSP without `connect-src`. Requests with another `Host` header get
  421. Only GET/HEAD of a fixed file list are served.
- The page accepts messages only from `window.opener` with the dialog origin
  (written into the page by the server). The dialog accepts messages only
  from the window it opened, with the page origin.
- The page gets bridge names and channel mappings, never `ccuAuth`. It sends
  back channel operations; the dialog checks them (known service and variant,
  existing bridge, valid address, one operation per channel) and applies them
  to its own copy of the config, so `ccuAuth`, identity seeds and every other
  field stay as they were.
- Each snapshot carries a revision (hash of the config without `ccuAuth`). An
  Apply with an old revision is rejected and the page reloads the table.
- On dialog close config-ui-x disconnects the child and sends SIGTERM; the
  listener closes and the process exits.

## Shared kit

`homebridge-ui/public/kit/` is copied between the owner's plugins. Each file
starts with `/* home-ui-kit <file> <version> sha256:<hash> */`.
`npm run kit:check` fails when a copy differs from its header; after an
intended change, run `node scripts/kit-hash.mjs --write` and bump the version.
The kit lives under `public/` because config-ui-x serves the dialog iframe
only from that folder.

## Limits

- Room is not editable: channels have no room setting, and discovery does
  not map CCU rooms to channels.
- Tested in Chromium. Safari and Firefox are not tested yet.
- The page is plain HTTP on the LAN even when the Homebridge UI uses HTTPS;
  it holds no credentials, and writes still go through the dialog.
