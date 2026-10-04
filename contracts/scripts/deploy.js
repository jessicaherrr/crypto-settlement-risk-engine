// contracts/scripts/deploy.js
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Update environment variable in .env.local file
 * @param {string} content - Current file content
 * @param {string} key - Environment variable key
 * @param {string} value - Environment variable value
 * @returns {string} Updated file content
 */
function updateEnvVariable(content, key, value) {
  const regex = new RegExp(`^${key}=.*$`, "m");
  const newLine = `${key}=${value}`;

  if (regex.test(content)) {
    return content.replace(regex, newLine);
  } else {
    return content + (content.endsWith("\n") ? "" : "\n") + newLine + "\n";
  }
}

/**
 * Save contract addresses to JSON file for frontend access
 * @param {Object} contractsData - Contract addresses and metadata
 */
function saveContractAddresses(contractsData) {
  const rootDir = path.join(__dirname, "../..");

  const publicDir = path.join(rootDir, "apps", "web", "public");
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(publicDir, "contracts.json"),
    JSON.stringify(contractsData, null, 2)
  );

  console.log("✅ Contract addresses saved to: apps/web/public/contracts.json");
}

/**
 * Update .env.local file with contract addresses
 * @param {Object} addresses - Contract addresses
 */
function updateEnvFile(addresses) {
  const envPath = path.join(__dirname, "../..", ".env.local");

  let envContent = "";
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, "utf8");
  }

  envContent = updateEnvVariable(
    envContent,
    "NEXT_PUBLIC_RISK_ESCROW_ADDRESS",
    addresses.riskEscrow
  );

  fs.writeFileSync(envPath, envContent);
  console.log("✅ Contract address updated in: .env.local");
}

/**
 * Display deployment information
 * @param {Object} deploymentInfo - Deployment details
 */
function displayDeploymentInfo(deploymentInfo) {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 DEPLOYMENT COMPLETE");
  console.log("=".repeat(60));

  console.log("\n📋 Contract Address:");
  console.log("└─ RiskEscrow:", deploymentInfo.riskEscrow);

  console.log("\n📝 Network:", deploymentInfo.network);
  console.log("👤 Deployer:", deploymentInfo.deployer);
  console.log("🔑 Risk Oracle:", deploymentInfo.riskOracle);
  console.log("💰 Deployer Balance:", deploymentInfo.deployerBalance, deploymentInfo.nativeCurrency);
  console.log("📅 Deployment Time:", deploymentInfo.deployedAt);

  const isAmoy = deploymentInfo.network === "polygonAmoy";

  if (isAmoy) {
    console.log("\n" + "=".repeat(60));
    console.log("🔗 Verification Command:");
    console.log("=".repeat(60));
    console.log("\nTo verify the contract on Polygonscan, run:");
    console.log(
      `npx hardhat verify --network polygonAmoy ${deploymentInfo.riskEscrow} "${deploymentInfo.platformWallet}" "${deploymentInfo.riskOracle}"`
    );
  }

  console.log("\n" + "=".repeat(60));
  console.log("🎯 Next Steps:");
  console.log("=".repeat(60));

  console.log("\n1. Restart your Next.js dev server:");
  console.log("   npm run dev -w apps/web");

  if (isAmoy) {
    console.log("\n2. View the contract on Polygonscan:");
    console.log(`   https://amoy.polygonscan.com/address/${deploymentInfo.riskEscrow}`);
  }

  console.log("\n✅ Deployment successful!");
}

/**
 * Main deployment function
 */
async function main() {
  console.log("🚀 Starting smart contract deployment...");
  console.log("=".repeat(60));

  const [deployer] = await ethers.getSigners();
  const deployerAddress = deployer.address;
  const deployerBalance = await ethers.provider.getBalance(deployerAddress);
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  // Polygon (both Amoy and mainnet) rebranded its native asset from MATIC
  // to POL; a local Hardhat chain's native asset is plain (test) ETH.
  const nativeCurrency = chainId === 31337 ? "ETH" : "POL";

  console.log("👤 Deployer Address:", deployerAddress);
  console.log("💰 Deployer Balance:", ethers.formatEther(deployerBalance), nativeCurrency);
  console.log("🌐 Network:", network.name, `(chainId ${chainId})`);

  const minBalance = ethers.parseEther("0.05");
  if (deployerBalance < minBalance) {
    throw new Error(
      `Insufficient balance. Need at least ${ethers.formatEther(minBalance)} ${nativeCurrency}. ` +
      `Current balance: ${ethers.formatEther(deployerBalance)} ${nativeCurrency}`
    );
  }

  console.log("\n" + "-".repeat(60));
  console.log("Deploying RiskEscrow contract...");

  const RiskEscrow = await ethers.getContractFactory("RiskEscrow");

  const platformWallet = deployerAddress;

  // RISK_ORACLE_ADDRESS is the public address matching the signing key the
  // Python risk engine (quant/) will use to sign RiskQuotes (Phase D/E).
  // Until that key exists, default to the deployer so local/testnet deploys
  // keep working; this MUST be rotated to the real oracle key via
  // setRiskOracle() before any quote-gated collateral flows for real.
  const riskOracle = process.env.RISK_ORACLE_ADDRESS || deployerAddress;
  if (!process.env.RISK_ORACLE_ADDRESS) {
    console.log("⚠️  RISK_ORACLE_ADDRESS not set - defaulting risk oracle to the deployer address.");
    console.log("   Rotate this via setRiskOracle() once the risk engine's signing key exists.");
  }

  console.log("📝 Platform Wallet:", platformWallet);
  console.log("🔑 Risk Oracle:", riskOracle);
  console.log("⏳ Deploying...");

  const riskEscrow = await RiskEscrow.deploy(platformWallet, riskOracle);
  await riskEscrow.waitForDeployment();
  const riskEscrowAddress = await riskEscrow.getAddress();

  console.log("✅ RiskEscrow deployed to:", riskEscrowAddress);
  console.log("📊 Transaction:", riskEscrow.deploymentTransaction().hash);

  console.log("\n" + "-".repeat(60));
  console.log("Saving contract address...");

  const contractsData = {
    riskEscrow: riskEscrowAddress,
    platformWallet: platformWallet,
    riskOracle: riskOracle,
    network: network.name,
    chainId: chainId,
    deployer: deployerAddress,
    deployerBalance: ethers.formatEther(deployerBalance),
    deployedAt: new Date().toISOString(),
    transactions: {
      riskEscrow: riskEscrow.deploymentTransaction().hash,
    },
  };

  saveContractAddresses(contractsData);
  updateEnvFile({ riskEscrow: riskEscrowAddress });

  displayDeploymentInfo({
    riskEscrow: riskEscrowAddress,
    platformWallet: platformWallet,
    riskOracle: riskOracle,
    network: network.name,
    nativeCurrency,
    deployer: deployerAddress,
    deployerBalance: ethers.formatEther(deployerBalance),
    deployedAt: new Date().toLocaleString(),
  });

  return contractsData;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Deployment failed!");
    console.error("Error:", error.message);

    if (error.message.includes("insufficient funds")) {
      console.log("\n💡 Solution:");
      console.log("1. Get test MATIC from: https://faucet.polygon.technology/");
      console.log("2. Select 'Polygon Amoy' network");
      console.log("3. Enter your address:", process.env.PRIVATE_KEY ?
        ethers.computeAddress(`0x${process.env.PRIVATE_KEY}`) :
        "Configure PRIVATE_KEY in .env");
    } else if (error.message.includes("network")) {
      console.log("\n💡 Solution:");
      console.log("1. Check your RPC URL in .env.local");
      console.log("2. Ensure you're connected to Polygon Amoy testnet");
      console.log("3. Try: npm run deploy:local for local testing");
    }

    process.exit(1);
  });
