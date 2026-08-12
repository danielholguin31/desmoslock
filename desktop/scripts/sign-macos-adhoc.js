'use strict';

const { signAsync } = require('@electron/osx-sign');

async function sign(options) {
  if (!options || options.platform !== 'darwin' || !options.app.endsWith('.app')) {
    throw new Error('ad-hoc signer accepts only a macOS .app bundle');
  }
  if (options.provisioningProfile) {
    throw new Error('ad-hoc recovery builds must not use a provisioning profile');
  }

  await signAsync({
    ...options,
    identity: '-',
    identityValidation: false,
    keychain: undefined,
  });
}

module.exports = { sign };
