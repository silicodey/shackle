// Ad-hoc signs the macOS app. Apple silicon refuses to launch unsigned code, and without a paid
// Developer ID this is the minimum that lets the app run. Replace with real signing + notarization
// (electron-builder "mac.identity" and "notarize") once you have an Apple Developer account.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
