// Prints an scrypt hash of a password, for `auth.passwordHash` in the bridge's config.json.
// `portals-host setup` makes and hashes one by itself; this is for setting one by hand.
//
//   node scripts/hash-password.ts                    asks for the password
//   PORTALS_PASSWORD=… node scripts/hash-password.ts
//   node scripts/hash-password.ts --user dana      prints the whole "auth" block
//
// The password is read from $PORTALS_PASSWORD (as the probe reads it), else from
// standard input: typed without echo at a terminal, or piped.

import { hashPassword } from "../src/http/auth.ts";
import { readPassword } from "../src/setup/password.ts";

const userIndex = process.argv.indexOf("--user");
const user = userIndex >= 0 ? process.argv[userIndex + 1] : undefined;
if (userIndex >= 0 && !user) {
  console.error("--user needs a name");
  process.exit(2);
}

let password: string;
try {
  password = await readPassword();
} catch {
  process.exit(130);
}
if (password === "") {
  console.error("The password is empty.");
  process.exit(1);
}
const hash = await hashPassword(password);
console.log(user ? JSON.stringify({ auth: { username: user, passwordHash: hash } }, null, 2) : hash);
