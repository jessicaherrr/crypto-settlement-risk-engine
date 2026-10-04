// Cross-language test helper: computes an EIP-712 digest with ethers.js
// (the same library the Hardhat test suite and `apps/web` tooling would
// use for TypedDataEncoder-style hashing) so `quant/tests/test_eip712.py`
// can assert that Python's independently-computed digest
// (`askgene_quant.signing.eip712.typed_data_digest`) agrees with it,
// without going through a deployed contract.
//
// Usage: node eip712_digest.js < request.json
//   request.json: {"domain": {...}, "types": {"RiskQuote": [...]}, "value": {...}}
// Prints: {"digest": "0x..."}

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
  const { domain, types, value } = JSON.parse(raw);

  // Large uint256 fields arrive as decimal strings (JSON can't carry them
  // losslessly as numbers); ethers accepts strings directly for uint*.
  const digest = ethers.TypedDataEncoder.hash(domain, types, value);
  process.stdout.write(JSON.stringify({ digest }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
