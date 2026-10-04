// contracts/scripts/deploy_local.js
//
// Deploys RiskEscrow (and a MockERC20 for the ERC-20 settlement path) to
// a local Hardhat node for `scripts/dev_stack.sh`, and writes every env
// var the rest of the local stack needs into the monorepo root's
// .env.local - unlike contracts/scripts/deploy.js (the Amoy-oriented
// script this borrows its address-saving helpers from), this one
// targets exactly one network (localhost, chainId 31337) and is meant
// to be re-run on every fresh `hardhat node`.
//
// The risk oracle is the well-known Hardhat account #0
// (0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266) - the same address
// contracts/test/helpers/pythonRiskOracle.js and the real Python
// risk-oracle service's local test key already sign with, so a locally
// requested quote verifies against this deployment with no extra setup.
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const TEST_ORACLE_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ROOT_DIR = path.join(__dirname, "../..");

function updateEnvVariable(content, key, value) {
  const regex = new RegExp(`^${key}=.*$`, "m");
  const newLine = `${key}=${value}`;
  if (regex.test(content)) return content.replace(regex, newLine);
  return content + (content.endsWith("\n") || content === "" ? "" : "\n") + newLine + "\n";
}

async function main() {
  const [deployer, depositor, counterparty, platformWallet] = await ethers.getSigners();

  console.log("Deploying RiskEscrow to localhost...");
  console.log("  deployer:    ", deployer.address);
  console.log("  risk oracle: ", TEST_ORACLE_ADDRESS, "(well-known Hardhat account #0)");

  const RiskEscrow = await ethers.getContractFactory("RiskEscrow");
  const riskEscrow = await RiskEscrow.deploy(platformWallet.address, TEST_ORACLE_ADDRESS);
  await riskEscrow.waitForDeployment();
  const riskEscrowAddress = await riskEscrow.getAddress();
  console.log("RiskEscrow deployed:", riskEscrowAddress);

  console.log("Deploying MockERC20 (tWETH) for the ERC-20 settlement path...");
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const mockToken = await MockERC20.deploy("Test Wrapped Ether", "tWETH");
  await mockToken.waitForDeployment();
  const mockTokenAddress = await mockToken.getAddress();
  const mintAmount = ethers.parseEther("1000");
  await (await mockToken.mint(depositor.address, mintAmount)).wait();
  await (await mockToken.mint(counterparty.address, mintAmount)).wait();
  console.log("MockERC20 (tWETH) deployed:", mockTokenAddress, "- minted 1000 to accounts #1 and #2");

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const settlementAssets = JSON.stringify([
    { address: mockTokenAddress, symbol: "tWETH", label: "Test Wrapped Ether (tWETH)", decimals: 18 },
  ]);

  const envPath = path.join(ROOT_DIR, ".env.local");
  let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const updates = {
    NEXT_PUBLIC_CHAIN_ID: String(chainId),
    NEXT_PUBLIC_RPC_URL: "http://127.0.0.1:8545",
    NEXT_PUBLIC_RISK_ESCROW_ADDRESS: riskEscrowAddress,
    NEXT_PUBLIC_SETTLEMENT_ASSETS: `'${settlementAssets}'`,
    RISK_ESCROW_ADDRESS: riskEscrowAddress,
    RPC_URL: "http://127.0.0.1:8545",
    CHAIN_ID: String(chainId),
    START_BLOCK: "0",
    CONFIRMATION_DEPTH: "2",
    DATABASE_URL: process.env.DATABASE_URL || "postgres://askgene:askgene@localhost:5432/askgene_quantfi",
  };
  for (const [key, value] of Object.entries(updates)) {
    envContent = updateEnvVariable(envContent, key, value);
  }
  fs.writeFileSync(envPath, envContent);
  console.log("Wrote", path.relative(ROOT_DIR, envPath));

  const publicDir = path.join(ROOT_DIR, "apps", "web", "public");
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(
    path.join(publicDir, "contracts.json"),
    JSON.stringify(
      {
        riskEscrow: riskEscrowAddress,
        mockERC20: mockTokenAddress,
        platformWallet: platformWallet.address,
        riskOracle: TEST_ORACLE_ADDRESS,
        network: "localhost",
        chainId,
        deployer: deployer.address,
        deployedAt: new Date().toISOString(),
        testAccounts: { depositor: depositor.address, counterparty: counterparty.address },
      },
      null,
      2
    )
  );
  console.log("Wrote apps/web/public/contracts.json");
  console.log("\nLocal demo stack is ready. Restart the Next.js dev server if it was already running.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("deploy_local.js failed:", error);
    process.exit(1);
  });
