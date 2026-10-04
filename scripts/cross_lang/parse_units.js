// Cross-language test helper: converts a decimal string to a fixed-point
// integer with ethers.js `parseUnits`, so
// `quant/tests/test_fixed_point_cross_lang.py` can assert Python's
// `serialization.to_fixed_point` (round-half-up) agrees with it exactly
// for values that don't hit the rounding boundary ethers (round-down/
// truncate) and Python (round-half-up) deliberately disagree on.
//
// Usage: node parse_units.js < request.json
//   request.json: {"value": "1.23456789", "decimals": 18}
// Prints: {"result": "1234567890000000000"}

const { ethers } = require("ethers");

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const raw = await readStdin();
  const { value, decimals } = JSON.parse(raw);
  const result = ethers.parseUnits(value, decimals).toString();
  process.stdout.write(JSON.stringify({ result }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
