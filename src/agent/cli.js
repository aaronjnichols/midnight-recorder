import { execute } from './client.js';
import { commands } from '../application/service.js';

try {
  const [command, json] = process.argv.slice(2);
  if (!command || ['help', '--help', 'commands'].includes(command)) {
    process.stdout.write(JSON.stringify({ usage: 'node src/agent/cli.js <command> [JSON arguments]', commands }, null, 2) + '\n');
  } else {
    const result = await execute(command, json ? JSON.parse(json) : {});
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
