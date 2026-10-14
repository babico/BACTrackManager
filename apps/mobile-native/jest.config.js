module.exports = {
  preset: '@react-native/jest-preset',
  transformIgnorePatterns: [
    'node_modules/(?!\\.pnpm|((jest-)?react-native|@react-native(-community)?)/)',
  ],
};
