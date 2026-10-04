#!/usr/bin/env node
// Minimal fake `claude` for CLI tests: logged in with a subscription.
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('2.1.289 (Claude Code)');
else if (args[0] === 'auth')
  console.log(
    JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' }),
  );
else process.exit(9);
