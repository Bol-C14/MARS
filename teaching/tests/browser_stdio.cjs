// Exercise the generated JavaScript in Node using the same Worker message bridge.
const vm = require('node:vm'), fs = require('node:fs'), readline = require('node:readline');
const plain = process.argv.includes("--plain");
let serial = 0;
const scope = {
  exports: {}, crypto: globalThis.crypto, performance, setTimeout, clearTimeout,
  console: new console.Console(process.stderr, process.stderr),
  postMessage(message) { if (!message.ready) process.stdout.write(JSON.stringify(plain ? message.result ?? { error: message.error } : message) + '\n'); },
};
vm.runInNewContext(fs.readFileSync('teaching/dist/kernel.js', 'utf8'), scope);
scope.exports.main([], (error) => { if (error) throw error; });
readline.createInterface({ input: process.stdin }).on('line', (message) => scope.marsReceive(plain ? JSON.stringify({ id: ++serial, body: JSON.parse(message) }) : message));
