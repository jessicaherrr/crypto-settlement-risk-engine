const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  isPythonSignerAvailable,
  signRawQuote,
  signGeneratedQuote,
  TEST_ORACLE_ADDRESS,
  FORGED_SIGNER_PRIVATE_KEY,
} = require("./helpers/pythonRiskOracle");

/**
 * Cross-language integration: RiskQuotes generated and signed by the real
 * Python risk engine (quant/), verified by the real deployed RiskEscrow /
 * RiskQuoteVerifier bytecode - the Phase E proof that "Python signs,
 * Solidity verifies" holds for the actual implementations on both sides,
 * not a same-language stand-in for either one.
 *
 * `pythonRiskOracle.js` shells out to `quant/scripts/sign_quote_cli.py`.
 * If the quant/ venv isn't set up, every test in this file is skipped
 * (not failed) with an explanatory message - see that helper.
 */
describe("RiskEscrow + Python-signed RiskQuote (cross-language integration)", function () {
  this.timeout(120_000); // the "real pipeline" tests run GARCH/FHS simulation in Python

  before(function () {
    if (!isPythonSignerAvailable()) {
      this.skip();
    }
  });

  let riskEscrow, token;
  let deployer, depositor, counterparty, platformWallet, otherAccount;
  let chainId, verifyingContract;

  const NOTIONAL = ethers.parseEther("10");
  const COLLATERAL = ethers.parseEther("12");
  const SETTLEMENT_HORIZON = 7n * 24n * 3600n;
  const MODEL_VERSION = "garch-1.1.0";

  function randomBytes32() {
    return ethers.hexlify(ethers.randomBytes(32));
  }

  async function futureExpiration(seconds = 3600) {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block.timestamp + seconds);
  }

  async function baselineFields(overrides = {}) {
    return {
      quoteId: randomBytes32(),
      depositor: depositor.address,
      counterparty: counterparty.address,
      settlementAsset: ethers.ZeroAddress,
      notional: NOTIONAL,
      requiredCollateral: COLLATERAL,
      quoteExpiration: await futureExpiration(),
      settlementHorizon: SETTLEMENT_HORIZON,
      modelVersion: MODEL_VERSION,
      riskSnapshotHash: randomBytes32(),
      ...overrides,
    };
  }

  beforeEach(async function () {
    [deployer, depositor, counterparty, platformWallet, otherAccount] = await ethers.getSigners();

    const RiskEscrow = await ethers.getContractFactory("RiskEscrow");
    riskEscrow = await RiskEscrow.deploy(platformWallet.address, TEST_ORACLE_ADDRESS);
    await riskEscrow.waitForDeployment();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token = await MockERC20.deploy("Mock USD", "mUSD");
    await token.waitForDeployment();

    const network = await ethers.provider.getNetwork();
    chainId = Number(network.chainId);
    verifyingContract = await riskEscrow.getAddress();

    expect(await riskEscrow.riskOracle()).to.equal(TEST_ORACLE_ADDRESS);
  });

  describe("deterministic cross-language serialization", function () {
    it("Python's EIP-712 digest and signer match the deployed contract's own hashRiskQuote/recoverRiskQuoteSigner", async function () {
      const fields = await baselineFields();
      const { quote, signature, digest, signer } = signRawQuote(fields, { chainId, verifyingContract });

      expect(signer).to.equal(TEST_ORACLE_ADDRESS);
      expect((await riskEscrow.hashRiskQuote(quote)).toLowerCase()).to.equal(digest.toLowerCase());
      expect(await riskEscrow.recoverRiskQuoteSigner(quote, signature)).to.equal(TEST_ORACLE_ADDRESS);
    });

    it("the same fields signed for a different verifyingContract produce a different digest (no cross-deployment replay)", async function () {
      const fields = await baselineFields();
      const a = signRawQuote(fields, { chainId, verifyingContract });
      const b = signRawQuote(fields, { chainId, verifyingContract: "0x" + "99".repeat(20) });
      expect(a.digest).to.not.equal(b.digest);
      expect(a.signature).to.not.equal(b.signature);
    });
  });

  describe("createEscrow - valid Python-signed quotes", function () {
    it("accepts a Python-signed native-asset quote and activates the escrow", async function () {
      const fields = await baselineFields();
      const { quote, signature } = signRawQuote(fields, { chainId, verifyingContract });

      await expect(riskEscrow.connect(depositor).createEscrow(quote, signature, { value: COLLATERAL })).to.emit(
        riskEscrow,
        "RiskEscrowCreated"
      );

      const deal = await riskEscrow.getDeal(1);
      expect(deal.status).to.equal(0); // ACTIVE
      expect(deal.collateralLocked).to.equal(COLLATERAL);
      expect(await riskEscrow.usedQuotes(quote.quoteId)).to.equal(true);
    });

    it("accepts a Python-signed ERC-20 settlement quote", async function () {
      await token.mint(depositor.address, COLLATERAL);
      await token.connect(depositor).approve(await riskEscrow.getAddress(), COLLATERAL);

      const fields = await baselineFields({ settlementAsset: await token.getAddress() });
      const { quote, signature } = signRawQuote(fields, { chainId, verifyingContract });

      await expect(riskEscrow.connect(depositor).createEscrow(quote, signature)).to.emit(
        riskEscrow,
        "RiskEscrowCreated"
      );
      expect(await token.balanceOf(await riskEscrow.getAddress())).to.equal(COLLATERAL);
    });
  });

  describe("createEscrow - rejections", function () {
    it("rejects a quote tampered with after Python signed it", async function () {
      const fields = await baselineFields();
      const { quote, signature } = signRawQuote(fields, { chainId, verifyingContract });

      const tampered = { ...quote, requiredCollateral: quote.requiredCollateral * 2n };
      await expect(
        riskEscrow.connect(depositor).createEscrow(tampered, signature, { value: tampered.requiredCollateral })
      ).to.be.revertedWith("Invalid risk quote signature");
    });

    it("rejects a quote signed with a key other than the configured risk oracle", async function () {
      const fields = await baselineFields();
      const { quote, signature } = signRawQuote(fields, {
        chainId,
        verifyingContract,
        privateKey: FORGED_SIGNER_PRIVATE_KEY,
      });

      await expect(
        riskEscrow.connect(depositor).createEscrow(quote, signature, { value: quote.requiredCollateral })
      ).to.be.revertedWith("Invalid risk quote signature");
    });

    it("rejects an expired quote", async function () {
      const block = await ethers.provider.getBlock("latest");
      const fields = await baselineFields({ quoteExpiration: BigInt(block.timestamp) });
      const { quote, signature } = signRawQuote(fields, { chainId, verifyingContract });

      await expect(
        riskEscrow.connect(depositor).createEscrow(quote, signature, { value: quote.requiredCollateral })
      ).to.be.revertedWith("Risk quote expired");
    });

    it("rejects replaying an already-used quoteId", async function () {
      const fields = await baselineFields();
      const { quote, signature } = signRawQuote(fields, { chainId, verifyingContract });

      await riskEscrow.connect(depositor).createEscrow(quote, signature, { value: quote.requiredCollateral });
      await expect(
        riskEscrow.connect(depositor).createEscrow(quote, signature, { value: quote.requiredCollateral })
      ).to.be.revertedWith("Risk quote already used");
    });

    it("rejects a caller who is not the quoted depositor", async function () {
      const fields = await baselineFields();
      const { quote, signature } = signRawQuote(fields, { chainId, verifyingContract });

      await expect(
        riskEscrow.connect(otherAccount).createEscrow(quote, signature, { value: quote.requiredCollateral })
      ).to.be.revertedWith("Caller is not the quoted depositor");
    });

    it("rejects a self-dealing quote (counterparty == depositor)", async function () {
      const fields = await baselineFields({ counterparty: depositor.address });
      const { quote, signature } = signRawQuote(fields, { chainId, verifyingContract });

      await expect(
        riskEscrow.connect(depositor).createEscrow(quote, signature, { value: quote.requiredCollateral })
      ).to.be.revertedWith("Depositor cannot equal counterparty");
    });

    it("rejects insufficient native collateral", async function () {
      const fields = await baselineFields();
      const { quote, signature } = signRawQuote(fields, { chainId, verifyingContract });

      await expect(
        riskEscrow.connect(depositor).createEscrow(quote, signature, { value: quote.requiredCollateral - 1n })
      ).to.be.revertedWith("Collateral does not match quote");
    });

    it("rejects a settlement horizon outside RiskEscrow's bounds", async function () {
      const fields = await baselineFields({ settlementHorizon: 60n }); // below MIN_SETTLEMENT_HORIZON
      const { quote, signature } = signRawQuote(fields, { chainId, verifyingContract });

      await expect(
        riskEscrow.connect(depositor).createEscrow(quote, signature, { value: quote.requiredCollateral })
      ).to.be.revertedWith("Settlement horizon out of bounds");
    });
  });

  describe("real Python-generated quotes (full quantitative pipeline)", function () {
    it("prices and signs a real ETH-USD RiskQuote whose on-chain collateral is enforced, and settles it correctly", async function () {
      const { quote, signature, riskQuote } = signGeneratedQuote({
        notional: "10",
        horizonDays: 7,
        depositor: depositor.address,
        counterparty: counterparty.address,
        chainId,
        verifyingContract,
      });

      // The quantitative engine's output must actually be what gets
      // enforced on-chain, not just a pass-through of a hardcoded figure.
      expect(quote.requiredCollateral).to.be.gte(quote.notional);
      expect(riskQuote.required_collateral).to.not.equal(riskQuote.notional); // a real risk buffer was priced

      await expect(
        riskEscrow.connect(depositor).createEscrow(quote, signature, { value: quote.requiredCollateral })
      ).to.emit(riskEscrow, "RiskEscrowCreated");

      const dealId = await riskEscrow.dealCounter();
      const deal = await riskEscrow.getDeal(dealId);
      expect(deal.collateralLocked).to.equal(quote.requiredCollateral);
      expect(deal.modelVersion).to.equal(riskQuote.model_version);

      const expectedFee = (quote.notional * 500n) / 10_000n;
      const expectedPayout = quote.notional - expectedFee;
      const expectedBufferRefund = quote.requiredCollateral - quote.notional;

      const counterpartyBefore = await ethers.provider.getBalance(counterparty.address);
      const platformBefore = await ethers.provider.getBalance(platformWallet.address);
      const depositorBefore = await ethers.provider.getBalance(depositor.address);

      const tx = await riskEscrow.connect(depositor).settle(dealId);
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;

      await expect(tx)
        .to.emit(riskEscrow, "RiskEscrowSettled")
        .withArgs(dealId, counterparty.address, expectedPayout, expectedFee, expectedBufferRefund);

      expect(await ethers.provider.getBalance(counterparty.address)).to.equal(counterpartyBefore + expectedPayout);
      expect(await ethers.provider.getBalance(platformWallet.address)).to.equal(platformBefore + expectedFee);
      expect(await ethers.provider.getBalance(depositor.address)).to.equal(
        depositorBefore + expectedBufferRefund - gasCost
      );
    });

    it("prices and signs a real ERC-20-settled RiskQuote end to end", async function () {
      const tokenAddress = await token.getAddress();
      const { quote, signature } = signGeneratedQuote({
        notional: "10",
        horizonDays: 14,
        depositor: depositor.address,
        counterparty: counterparty.address,
        settlementAsset: tokenAddress,
        chainId,
        verifyingContract,
      });

      await token.mint(depositor.address, quote.requiredCollateral);
      await token.connect(depositor).approve(await riskEscrow.getAddress(), quote.requiredCollateral);

      await expect(riskEscrow.connect(depositor).createEscrow(quote, signature)).to.emit(
        riskEscrow,
        "RiskEscrowCreated"
      );
      expect(await token.balanceOf(await riskEscrow.getAddress())).to.equal(quote.requiredCollateral);

      const dealId = await riskEscrow.dealCounter();
      const expectedFee = (quote.notional * 500n) / 10_000n;
      await riskEscrow.connect(counterparty).settle(dealId);

      expect(await token.balanceOf(counterparty.address)).to.equal(quote.notional - expectedFee);
      expect(await token.balanceOf(platformWallet.address)).to.equal(expectedFee);
      expect(await token.balanceOf(depositor.address)).to.equal(quote.requiredCollateral - quote.notional);
    });

    it("refunds the full collateral once a real quote's settlement deadline elapses unsettled", async function () {
      const { quote, signature } = signGeneratedQuote({
        notional: "10",
        horizonDays: 1,
        depositor: depositor.address,
        counterparty: counterparty.address,
        chainId,
        verifyingContract,
      });

      await riskEscrow.connect(depositor).createEscrow(quote, signature, { value: quote.requiredCollateral });
      const dealId = await riskEscrow.dealCounter();

      await ethers.provider.send("evm_increaseTime", [86_400 + 1]);
      await ethers.provider.send("evm_mine", []);

      const depositorBefore = await ethers.provider.getBalance(depositor.address);
      await expect(riskEscrow.connect(counterparty).refund(dealId))
        .to.emit(riskEscrow, "RiskEscrowRefunded")
        .withArgs(dealId, depositor.address, quote.requiredCollateral);

      expect(await ethers.provider.getBalance(depositor.address)).to.equal(depositorBefore + quote.requiredCollateral);
    });
  });
});
