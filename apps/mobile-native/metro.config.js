const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('node:path');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const appRoot = __dirname;
const workspaceRoot = path.resolve(appRoot, '../..');

const config = {
  watchFolders: [workspaceRoot, path.resolve(workspaceRoot, 'apps/mobile')],
  resolver: {
    nodeModulesPaths: [
      path.resolve(appRoot, 'node_modules'),
      path.resolve(workspaceRoot, 'node_modules'),
    ],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
