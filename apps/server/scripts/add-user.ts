// Generate an AUTH_USERS entry. Usage:
//   npm run add-user -w @carbon/server -- alice 's3cret'
// Then paste the printed line into your .env (comma-separate multiple users).
import { createHash } from 'node:crypto';

const [username, password] = process.argv.slice(2);

if (!username || !password) {
  console.error("Usage: add-user <username> '<password>'");
  process.exit(1);
}

const hash = createHash('sha256').update(password).digest('hex');
console.log('\nAdd this to AUTH_USERS in your .env (comma-separate users):\n');
console.log(`${username}:${hash}\n`);
