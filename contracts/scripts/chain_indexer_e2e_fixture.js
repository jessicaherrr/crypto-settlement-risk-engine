// contracts/scripts/chain_indexer_e2e_fixture.js
//
// Phase F end-to-end fixture: deploys RiskEscrow against a running local
// Hardhat node, prices and signs two real RiskQuotes through the actual
// Python risk engine (quant/), creates both escrows on-chain, settles one
// and refunds the other, then mines a few extra blocks so a small
// CONFIRMATION_DEPTH can already be satisfied. Prints a single JSON object
// to stdout describing exactly what happened, for the Go integration test
// (services/chain-indexer/tests/integration/e2e_test.go) to assert against.
//
// Run with: npx hardhat run --network localhost contracts/scripts/chain_indexer_e2e_fixture.js
// against an already-running `npx hardhat node`.
const { ethers } = require("hardhat");
const { signGeneratedQuote, TEST_ORACLE_ADDRESS } = require("../test/helpers/pythonRiskOracle");

async function main() {
  const [deployer, depositor, counterparty, platformWallet] = await ethers.getSigners();

  const RiskEscrow = await ethers.getContractFactory("RiskEscrow");
  const riskEscrow = await RiskEscrow.deploy(platformWallet.address, TEST_ORACLE_ADDRESS);
  await riskEscrow.waitForDeployment();
  const contractAddress = await riskEscrow.getAddress();

  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  // --- Deal 1: created then settled ---
  const settleQuote = signGeneratedQuote({
    notional: "5",
    horizonDays: 7,
    depositor: depositor.address,
    counterparty: counterparty.address,
    chainId,
    verifyingContract: contractAddress,
  });
  const createSettleTx = await riskEscrow
    .connect(depositor)
    .createEscrow(settleQuote.quote, settleQuote.signature, { value: settleQuote.quote.requiredCollateral });
  const createSettleReceipt = await createSettleTx.wait();
  const settleDealId = await riskEscrow.dealCounter();

  const settleTx = await riskEscrow.connect(depositor).settle(settleDealId);
  const settleReceipt = await settleTx.wait();

  // --- Deal 2: created then refunded (short horizon, time-traveled past deadline) ---
  const refundQuote = signGeneratedQuote({
    notional: "3",
    horizonDays: 1,
    depositor: depositor.address,
    counterparty: counterparty.address,
    chainId,
    verifyingContract: contractAddress,
  });
  const createRefundTx = await riskEscrow
    .connect(depositor)
    .createEscrow(refundQuote.quote, refundQuote.signature, { value: refundQuote.quote.requiredCollateral });
  const createRefundReceipt = await createRefundTx.wait();
  const refundDealId = await riskEscrow.dealCounter();

  await ethers.provider.send("evm_increaseTime", [86_400 + 1]);
  await ethers.provider.send("evm_mine", []);

  const refundTx = await riskEscrow.connect(counterparty).refund(refundDealId);
  const refundReceipt = await refundTx.wait();

  // Mine a few extra empty blocks so a small CONFIRMATION_DEPTH (e.g. 2)
  // is already satisfiable without the Go test needing to wait on
  // Hardhat's own block production.
  for (let i = 0; i < 5; i++) {
    await ethers.provider.send("evm_mine", []);
  }

  const result = {
    chainId,
    contractAddress,
    deals: [
      {
        kind: "settled",
        dealId: settleDealId.toString(),
        quoteId: settleQuote.quote.quoteId,
        notional: settleQuote.quote.notional.toString(),
        requiredCollateral: settleQuote.quote.requiredCollateral.toString(),
        createTxHash: createSettleReceipt.hash,
        createBlockNumber: createSettleReceipt.blockNumber,
        closeTxHash: settleReceipt.hash,
        closeBlockNumber: settleReceipt.blockNumber,
      },
      {
        kind: "refunded",
        dealId: refundDealId.toString(),
        quoteId: refundQuote.quote.quoteId,
        notional: refundQuote.quote.notional.toString(),
        requiredCollateral: refundQuote.quote.requiredCollateral.toString(),
        createTxHash: createRefundReceipt.hash,
        createBlockNumber: createRefundReceipt.blockNumber,
        closeTxHash: refundReceipt.hash,
        closeBlockNumber: refundReceipt.blockNumber,
      },
    ],
  };

  // Single line of JSON on stdout, nothing else - the Go test parses this
  // exact line. Everything else Hardhat/ethers might print goes to the
  // normal console but after this script's own explicit prints, so we
  // print LAST and flush synchronously via console.log.
  console.log("FIXTURE_JSON:" + JSON.stringify(result));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
