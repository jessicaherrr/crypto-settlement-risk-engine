// Bridges the Hardhat test suite to the real Python signing layer
// (quant/src/askgene_quant/signing/, via quant/scripts/sign_quote_cli.py),
// so "Python signs, Solidity verifies" can be tested against the actual
// risk-oracle implementation rather than a JS re-implementation of EIP-712
// signing standing in for it.

const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const QUANT_DIR = path.join(__dirname, "..", "..", "..", "quant");
const SIGN_CLI = path.join(QUANT_DIR, "scripts", "sign_quote_cli.py");

function resolvePythonExecutable() {
  if (process.env.ASKGENE_PYTHON) return process.env.ASKGENE_PYTHON;
  const unixPython = path.join(QUANT_DIR, ".venv", "bin", "python");
  if (fs.existsSync(unixPython)) return unixPython;
  const winPython = path.join(QUANT_DIR, ".venv", "Scripts", "python.exe");
  if (fs.existsSync(winPython)) return winPython;
  return null;
}

const PYTHON_EXECUTABLE = resolvePythonExecutable();

/// Well-known Hardhat/Anvil default test account #0 private key - used
/// here purely as *a* deterministic test key for the risk oracle, not
/// because it's Hardhat account #0 specifically. Public, never used for
/// anything real.
const TEST_ORACLE_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ORACLE_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/// A second, unrelated deterministic key - well-formed but *not* the
/// configured oracle key, for "forged signature" tests.
const FORGED_SIGNER_PRIVATE_KEY = "0x" + "ab".repeat(32);

function isPythonSignerAvailable() {
  return PYTHON_EXECUTABLE !== null;
}

/// Converts the JSON-safe (string) uint fields the CLI returns back into
/// BigInt, matching the shape ethers.js expects for a struct argument.
function toContractQuote(fields) {
  return {
    quoteId: fields.quoteId,
    depositor: fields.depositor,
    counterparty: fields.counterparty,
    settlementAsset: fields.settlementAsset,
    notional: BigInt(fields.notional),
    requiredCollateral: BigInt(fields.requiredCollateral),
    quoteExpiration: BigInt(fields.quoteExpiration),
    settlementHorizon: BigInt(fields.settlementHorizon),
    modelVersion: fields.modelVersion,
    riskSnapshotHash: fields.riskSnapshotHash,
  };
}

function runSignCli(request) {
  if (!PYTHON_EXECUTABLE) {
    throw new Error(
      "quant/.venv python executable not found; run `python3 -m venv quant/.venv && " +
        "quant/.venv/bin/pip install -e quant` (see quant/README.md) before running this suite, " +
        "or set ASKGENE_PYTHON to a Python executable with askgene_quant installed."
    );
  }
  const result = spawnSync(PYTHON_EXECUTABLE, [SIGN_CLI], {
    input: JSON.stringify(request),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`sign_quote_cli.py failed (exit ${result.status}):\n${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

/// Signs an explicit on-chain RiskQuote field dict exactly as given
/// (no risk pipeline involved) - for tamper/expiry/replay/party-binding
/// test cases that need precise control over individual fields.
function signRawQuote(fields, { chainId, verifyingContract, privateKey = TEST_ORACLE_PRIVATE_KEY }) {
  const jsonSafeFields = Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])
  );
  const response = runSignCli({
    mode: "raw",
    private_key: privateKey,
    chain_id: chainId,
    verifying_contract: verifyingContract,
    fields: jsonSafeFields,
  });
  return { quote: toContractQuote(response.fields), signature: response.signature, digest: response.digest, signer: response.signer };
}

/// Runs the real quantitative risk pipeline (quant/src/askgene_quant/service/quoting.py)
/// for (asset, notional, horizon) and signs the resulting RiskQuote - for
/// "a real Python-generated quote is accepted on-chain" end-to-end tests.
function signGeneratedQuote({
  asset = "ETH-USD",
  notional,
  horizonDays,
  depositor,
  counterparty,
  settlementAsset = "0x0000000000000000000000000000000000000000",
  settlementAssetDecimals = 18,
  chainId,
  verifyingContract,
  privateKey = TEST_ORACLE_PRIVATE_KEY,
}) {
  const response = runSignCli({
    mode: "generate",
    private_key: privateKey,
    chain_id: chainId,
    verifying_contract: verifyingContract,
    asset,
    notional,
    horizon_days: horizonDays,
    depositor,
    counterparty,
    settlement_asset: settlementAsset,
    settlement_asset_decimals: settlementAssetDecimals,
  });
  return {
    quote: toContractQuote(response.fields),
    signature: response.signature,
    digest: response.digest,
    signer: response.signer,
    riskQuote: response.quote,
  };
}

module.exports = {
  isPythonSignerAvailable,
  signRawQuote,
  signGeneratedQuote,
  toContractQuote,
  TEST_ORACLE_PRIVATE_KEY,
  TEST_ORACLE_ADDRESS,
  FORGED_SIGNER_PRIVATE_KEY,
};
