const { execFileSync } = require('child_process')
const path = require('path')

// electron-builder's own mac signing pass doesn't reliably deep-sign every nested binary
// (Electron Framework, Helper apps, and asarUnpacked native modules like node-pty's .node
// file) when no real Developer ID identity is configured. On Apple Silicon, any unsigned or
// inconsistently-signed code inside an otherwise-signed app bundle gets SIGKILLed by the kernel
// the moment it's loaded, so the whole app dies silently on launch. Re-sign the whole bundle
// ad-hoc with --deep as a final pass so every embedded binary carries a matching signature.
module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)

  execFileSync('codesign', ['--deep', '--force', '--sign', '-', appPath], { stdio: 'inherit' })
}
