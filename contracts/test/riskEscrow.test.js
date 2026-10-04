const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

describe("RiskEscrow", function () {
  let RiskEscrow, riskEscrow, MockERC20, token;
  let owner, depositor, counterparty, platformWallet, riskOracle, otherAccount;

  // requiredCollateral intentionally exceeds notional: the difference is the
  // risk buffer, which must come back to the depositor on settlement rather
  // than becoming counterparty income.
  const NOTIONAL = ethers.parseEther("10");
  const BUFFER = ethers.parseEther("2");
  const COLLATERAL = NOTIONAL + BUFFER;
  const SETTLEMENT_HORIZON = 7n * 24n * 3600n; // 7 days, within [MIN,MAX] bounds
  const MODEL_VERSION = "garch-1.1.0";
  const RISK_SNAPSHOT_HASH = ethers.keccak256(ethers.toUtf8Bytes("risk-snapshot-fixture"));

  let domain;
  const RISK_QUOTE_TYPES = {
    RiskQuote: [
      { name: "quoteId", type: "bytes32" },
      { name: "depositor", type: "address" },
      { name: "counterparty", type: "address" },
      { name: "settlementAsset", type: "address" },
      { name: "notional", type: "uint256" },
      { name: "requiredCollateral", type: "uint256" },
      { name: "quoteExpiration", type: "uint256" },
      { name: "settlementHorizon", type: "uint256" },
      { name: "modelVersion", type: "string" },
      { name: "riskSnapshotHash", type: "bytes32" },
    ],
  };

  async function futureExpiration(seconds = 3600) {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block.timestamp + seconds);
  }

  function randomQuoteId() {
    return ethers.hexlify(ethers.randomBytes(32));
  }

  async function buildQuote(overrides = {}) {
    return {
      quoteId: randomQuoteId(),
      depositor: depositor.address,
      counterparty: counterparty.address,
      settlementAsset: ethers.ZeroAddress,
      notional: NOTIONAL,
      requiredCollateral: COLLATERAL,
      quoteExpiration: await futureExpiration(),
      settlementHorizon: SETTLEMENT_HORIZON,
      modelVersion: MODEL_VERSION,
      riskSnapshotHash: RISK_SNAPSHOT_HASH,
      ...overrides,
    };
  }

  async function signQuote(signer, quote) {
    return signer.signTypedData(domain, RISK_QUOTE_TYPES, quote);
  }

  async function createActiveDeal(overrides = {}, { value } = {}) {
    const quote = await buildQuote(overrides);
    const signature = await signQuote(riskOracle, quote);
    const sendValue = value !== undefined ? value : quote.requiredCollateral;
    const tx = await riskEscrow.connect(depositor).createEscrow(quote, signature, { value: sendValue });
    await tx.wait();
    return { quote, signature, dealId: await riskEscrow.dealCounter() };
  }

  beforeEach(async function () {
    [owner, depositor, counterparty, platformWallet, riskOracle, otherAccount] = await ethers.getSigners();

    RiskEscrow = await ethers.getContractFactory("RiskEscrow");
    riskEscrow = await RiskEscrow.deploy(platformWallet.address, riskOracle.address);
    await riskEscrow.waitForDeployment();

    MockERC20 = await ethers.getContractFactory("MockERC20");
    token = await MockERC20.deploy("Mock USD", "mUSD");
    await token.waitForDeployment();

    const network = await ethers.provider.getNetwork();
    domain = {
      name: "AskGeneRiskEscrow",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await riskEscrow.getAddress(),
    };
  });

  describe("Deployment", function () {
    it("Should deploy with correct initial values", async function () {
      expect(await riskEscrow.platformWallet()).to.equal(platformWallet.address);
      expect(await riskEscrow.riskOracle()).to.equal(riskOracle.address);
      expect(await riskEscrow.dealCounter()).to.equal(0);
      expect(await riskEscrow.platformFeeBps()).to.equal(500);
      expect(await riskEscrow.MIN_SETTLEMENT_HORIZON()).to.equal(3600);
      expect(await riskEscrow.MAX_SETTLEMENT_HORIZON()).to.equal(90n * 24n * 3600n);
      expect(await riskEscrow.totalLocked(ethers.ZeroAddress)).to.equal(0);
    });

    it("Should reject a zero platform wallet or risk oracle", async function () {
      await expect(RiskEscrow.deploy(ethers.ZeroAddress, riskOracle.address)).to.be.revertedWith(
        "Invalid platform wallet"
      );
      await expect(RiskEscrow.deploy(platformWallet.address, ethers.ZeroAddress)).to.be.revertedWith(
        "Invalid risk oracle"
      );
    });
  });

  describe("createEscrow - valid creation", function () {
    it("Should create a native-asset escrow, lock collateral, and set a settlement deadline from the horizon", async function () {
      const quote = await buildQuote();
      const signature = await signQuote(riskOracle, quote);

      await expect(
        riskEscrow.connect(depositor).createEscrow(quote, signature, { value: COLLATERAL })
      )
        .to.emit(riskEscrow, "RiskEscrowCreated")
        .withArgs(
          1,
          quote.quoteId,
          depositor.address,
          counterparty.address,
          ethers.ZeroAddress,
          NOTIONAL,
          COLLATERAL,
          anyValue,
          MODEL_VERSION,
          RISK_SNAPSHOT_HASH
        );

      const deal = await riskEscrow.getDeal(1);
      expect(deal.depositor).to.equal(depositor.address);
      expect(deal.counterparty).to.equal(counterparty.address);
      expect(deal.collateralLocked).to.equal(COLLATERAL);
      expect(deal.notional).to.equal(NOTIONAL);
      expect(deal.modelVersion).to.equal(MODEL_VERSION);
      expect(deal.riskSnapshotHash).to.equal(RISK_SNAPSHOT_HASH);
      expect(deal.status).to.equal(0); // ACTIVE
      expect(deal.settlementDeadline).to.equal(deal.createdAt + SETTLEMENT_HORIZON);

      expect(await riskEscrow.usedQuotes(quote.quoteId)).to.equal(true);
      expect(await ethers.provider.getBalance(await riskEscrow.getAddress())).to.equal(COLLATERAL);
      expect(await riskEscrow.totalLocked(ethers.ZeroAddress)).to.equal(COLLATERAL);
    });

    it("Should create an ERC-20 settlement escrow and pull collateral via transferFrom", async function () {
      await token.mint(depositor.address, COLLATERAL);
      await token.connect(depositor).approve(await riskEscrow.getAddress(), COLLATERAL);

      const quote = await buildQuote({ settlementAsset: await token.getAddress() });
      const signature = await signQuote(riskOracle, quote);

      await expect(riskEscrow.connect(depositor).createEscrow(quote, signature)).to.emit(
        riskEscrow,
        "RiskEscrowCreated"
      );

      expect(await token.balanceOf(await riskEscrow.getAddress())).to.equal(COLLATERAL);
      expect(await token.balanceOf(depositor.address)).to.equal(0);
      expect(await riskEscrow.totalLocked(await token.getAddress())).to.equal(COLLATERAL);
    });

    it("Should accept requiredCollateral exactly equal to notional (zero buffer)", async function () {
      const quote = await buildQuote({ requiredCollateral: NOTIONAL });
      const signature = await signQuote(riskOracle, quote);
      await expect(
        riskEscrow.connect(depositor).createEscrow(quote, signature, { value: NOTIONAL })
      ).to.emit(riskEscrow, "RiskEscrowCreated");
    });
  });

  describe("createEscrow - invalid / expired quote", function () {
    it("Should reject an expired quote", async function () {
      const block = await ethers.provider.getBlock("latest");
      const quote = await buildQuote({ quoteExpiration: BigInt(block.timestamp) });
      const signature = await signQuote(riskOracle, quote);

      await expect(
        riskEscrow.connect(depositor).createEscrow(quote, signature, { value: COLLATERAL })
      ).to.be.revertedWith("Risk quote expired");
    });

    it("Should reject a quote signed by a non-oracle key", async function () {
      const quote = await buildQuote();
      const signature = await signQuote(otherAccount, quote);

      await expect(
        riskEscrow.connect(depositor).createEscrow(quote, signature, { value: COLLATERAL })
      ).to.be.revertedWith("Invalid risk quote signature");
    });

    it("Should reject a quote whose fields were tampered with after signing", async function () {
      const quote = await buildQuote();
      const signature = await signQuote(riskOracle, quote);
      const tampered = { ...quote, requiredCollateral: COLLATERAL * 2n };

      await expect(
        riskEscrow.connect(depositor).createEscrow(tampered, signature, { value: COLLATERAL * 2n })
      ).to.be.revertedWith("Invalid risk quote signature");
    });

    it("Should reject when the caller is not the quoted depositor", async function () {
      const quote = await buildQuote();
      const signature = await signQuote(riskOracle, quote);

      await expect(
        riskEscrow.connect(otherAccount).createEscrow(quote, signature, { value: COLLATERAL })
      ).to.be.revertedWith("Caller is not the quoted depositor");
    });

    it("Should reject a zero counterparty or self-dealing quote", async function () {
      const zeroCounterparty = await buildQuote({ counterparty: ethers.ZeroAddress });
      await expect(
        riskEscrow
          .connect(depositor)
          .createEscrow(zeroCounterparty, await signQuote(riskOracle, zeroCounterparty), { value: COLLATERAL })
      ).to.be.revertedWith("Invalid counterparty");

      const selfDeal = await buildQuote({ counterparty: depositor.address });
      await expect(
        riskEscrow
          .connect(depositor)
          .createEscrow(selfDeal, await signQuote(riskOracle, selfDeal), { value: COLLATERAL })
      ).to.be.revertedWith("Depositor cannot equal counterparty");
    });

    it("Should reject a settlement horizon below the minimum", async function () {
      const quote = await buildQuote({ settlementHorizon: 60n }); // 1 minute, below 1 hour floor
      const signature = await signQuote(riskOracle, quote);
      await expect(
        riskEscrow.connect(depositor).createEscrow(quote, signature, { value: COLLATERAL })
      ).to.be.revertedWith("Settlement horizon out of bounds");
    });

    it("Should reject a settlement horizon above the maximum", async function () {
      const quote = await buildQuote({ settlementHorizon: 91n * 24n * 3600n }); // 91 days
      const signature = await signQuote(riskOracle, quote);
      await expect(
        riskEscrow.connect(depositor).createEscrow(quote, signature, { value: COLLATERAL })
      ).to.be.revertedWith("Settlement horizon out of bounds");
    });
  });

  describe("createEscrow - replay protection", function () {
    it("Should reject reusing a quoteId across two escrow creations", async function () {
      const { quote, signature } = await createActiveDeal();

      await expect(
        riskEscrow.connect(depositor).createEscrow(quote, signature, { value: quote.requiredCollateral })
      ).to.be.revertedWith("Risk quote already used");
    });
  });

  describe("createEscrow - insufficient collateral", function () {
    it("Should reject native collateral that does not match the quote", async function () {
      const quote = await buildQuote();
      const signature = await signQuote(riskOracle, quote);

      await expect(
        riskEscrow.connect(depositor).createEscrow(quote, signature, { value: COLLATERAL - 1n })
      ).to.be.revertedWith("Collateral does not match quote");
    });

    it("Should reject ERC-20 collateral without sufficient allowance", async function () {
      await token.mint(depositor.address, COLLATERAL);
      // No approve() call.
      const quote = await buildQuote({ settlementAsset: await token.getAddress() });
      const signature = await signQuote(riskOracle, quote);

      await expect(riskEscrow.connect(depositor).createEscrow(quote, signature)).to.be.reverted;
    });

    it("Should reject native value sent alongside an ERC-20 settlement quote", async function () {
      await token.mint(depositor.address, COLLATERAL);
      await token.connect(depositor).approve(await riskEscrow.getAddress(), COLLATERAL);

      const quote = await buildQuote({ settlementAsset: await token.getAddress() });
      const signature = await signQuote(riskOracle, quote);

      await expect(
        riskEscrow.connect(depositor).createEscrow(quote, signature, { value: 1n })
      ).to.be.revertedWith("Native value not accepted for ERC-20 settlement");
    });

    it("Should reject a quote whose required collateral is below its notional", async function () {
      const quote = await buildQuote({ requiredCollateral: NOTIONAL - 1n });
      const signature = await signQuote(riskOracle, quote);
      await expect(
        riskEscrow.connect(depositor).createEscrow(quote, signature, { value: NOTIONAL - 1n })
      ).to.be.revertedWith("Collateral must cover notional");
    });
  });

  describe("settle - notional-based fee and collateral-buffer return", function () {
    it("Should pay the counterparty notional-minus-fee, the platform fee-on-notional, and return the buffer to the depositor", async function () {
      const { dealId } = await createActiveDeal();

      const expectedFee = (NOTIONAL * 500n) / 10_000n;
      const expectedCounterpartyPayout = NOTIONAL - expectedFee;
      const expectedDepositorRefund = COLLATERAL - NOTIONAL; // == BUFFER

      const counterpartyBefore = await ethers.provider.getBalance(counterparty.address);
      const platformBefore = await ethers.provider.getBalance(platformWallet.address);
      const depositorBefore = await ethers.provider.getBalance(depositor.address);

      // depositor calls settle() here so its own gas cost doesn't have to be
      // backed out of the counterparty/platform/depositor balance checks below.
      const tx = await riskEscrow.connect(depositor).settle(dealId);
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;

      await expect(tx)
        .to.emit(riskEscrow, "RiskEscrowSettled")
        .withArgs(dealId, counterparty.address, expectedCounterpartyPayout, expectedFee, expectedDepositorRefund);

      expect(await ethers.provider.getBalance(counterparty.address)).to.equal(
        counterpartyBefore + expectedCounterpartyPayout
      );
      expect(await ethers.provider.getBalance(platformWallet.address)).to.equal(platformBefore + expectedFee);
      expect(await ethers.provider.getBalance(depositor.address)).to.equal(
        depositorBefore + expectedDepositorRefund - gasCost
      );

      // Accounting identity: fee + counterparty payout + depositor refund == collateral locked.
      expect(expectedFee + expectedCounterpartyPayout + expectedDepositorRefund).to.equal(COLLATERAL);

      const deal = await riskEscrow.getDeal(dealId);
      expect(deal.status).to.equal(1); // SETTLED
      expect(await riskEscrow.totalLocked(ethers.ZeroAddress)).to.equal(0);
      expect(await ethers.provider.getBalance(await riskEscrow.getAddress())).to.equal(0);
    });

    it("Should not return a buffer when requiredCollateral equals notional", async function () {
      const quote = await buildQuote({ requiredCollateral: NOTIONAL });
      const signature = await signQuote(riskOracle, quote);
      await riskEscrow.connect(depositor).createEscrow(quote, signature, { value: NOTIONAL });
      const dealId = await riskEscrow.dealCounter();

      const depositorBefore = await ethers.provider.getBalance(depositor.address);
      await riskEscrow.connect(counterparty).settle(dealId);
      // Depositor made no call here, so balance only changes if a (spurious) refund is paid.
      expect(await ethers.provider.getBalance(depositor.address)).to.equal(depositorBefore);
    });

    it("Should settle an ERC-20 escrow with the same notional-based accounting", async function () {
      await token.mint(depositor.address, COLLATERAL);
      await token.connect(depositor).approve(await riskEscrow.getAddress(), COLLATERAL);
      const { dealId } = await createActiveDeal({ settlementAsset: await token.getAddress() }, { value: 0n });

      const expectedFee = (NOTIONAL * 500n) / 10_000n;
      const expectedPayout = NOTIONAL - expectedFee;
      const expectedRefund = COLLATERAL - NOTIONAL;

      await riskEscrow.connect(counterparty).settle(dealId);

      expect(await token.balanceOf(counterparty.address)).to.equal(expectedPayout);
      expect(await token.balanceOf(platformWallet.address)).to.equal(expectedFee);
      expect(await token.balanceOf(depositor.address)).to.equal(expectedRefund);
      expect(await riskEscrow.totalLocked(await token.getAddress())).to.equal(0);
    });

    it("Should reject settlement from a non-party", async function () {
      const { dealId } = await createActiveDeal();
      await expect(riskEscrow.connect(otherAccount).settle(dealId)).to.be.revertedWith(
        "Not a party to this escrow"
      );
    });

    it("Should reject settling an already-settled or refunded escrow", async function () {
      const { dealId } = await createActiveDeal();
      await riskEscrow.connect(depositor).settle(dealId);
      await expect(riskEscrow.connect(depositor).settle(dealId)).to.be.revertedWith("Escrow not active");
    });

    it("Should reject settling a non-existent escrow", async function () {
      await expect(riskEscrow.connect(depositor).settle(999)).to.be.revertedWith("Escrow does not exist");
    });
  });

  describe("refund / timeout (driven by the per-quote settlement horizon)", function () {
    it("Should reject refund while the settlement window is still open", async function () {
      const { dealId } = await createActiveDeal();
      await expect(riskEscrow.connect(depositor).refund(dealId)).to.be.revertedWith(
        "Settlement window still open"
      );
    });

    it("Should refund the full collateral (notional + buffer) once the quote's settlement horizon elapses", async function () {
      const { dealId } = await createActiveDeal();

      await ethers.provider.send("evm_increaseTime", [Number(SETTLEMENT_HORIZON) + 1]);
      await ethers.provider.send("evm_mine", []);

      const depositorBefore = await ethers.provider.getBalance(depositor.address);

      await expect(riskEscrow.connect(counterparty).refund(dealId))
        .to.emit(riskEscrow, "RiskEscrowRefunded")
        .withArgs(dealId, depositor.address, COLLATERAL);

      expect(await ethers.provider.getBalance(depositor.address)).to.equal(depositorBefore + COLLATERAL);

      const deal = await riskEscrow.getDeal(dealId);
      expect(deal.status).to.equal(2); // REFUNDED
      expect(await riskEscrow.totalLocked(ethers.ZeroAddress)).to.equal(0);
    });

    it("Two deals with different settlement horizons should become refundable at different times", async function () {
      const shortHorizon = 3600n; // 1 hour (minimum)
      const longHorizon = 30n * 24n * 3600n; // 30 days

      const { dealId: shortDealId } = await createActiveDeal({ settlementHorizon: shortHorizon });
      const { dealId: longDealId } = await createActiveDeal({ settlementHorizon: longHorizon });

      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine", []);

      expect(await riskEscrow.isRefundable(shortDealId)).to.equal(true);
      expect(await riskEscrow.isRefundable(longDealId)).to.equal(false);
    });

    it("Should reject refund from a non-party", async function () {
      const { dealId } = await createActiveDeal();
      await ethers.provider.send("evm_increaseTime", [Number(SETTLEMENT_HORIZON) + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(riskEscrow.connect(otherAccount).refund(dealId)).to.be.revertedWith(
        "Not a party to this escrow"
      );
    });

    it("Should reject refunding an escrow that was already settled", async function () {
      const { dealId } = await createActiveDeal();
      await riskEscrow.connect(depositor).settle(dealId);

      await ethers.provider.send("evm_increaseTime", [Number(SETTLEMENT_HORIZON) + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(riskEscrow.connect(depositor).refund(dealId)).to.be.revertedWith("Escrow not active");
    });

    it("isRefundable / isSettleable should reflect escrow state over time", async function () {
      const { dealId } = await createActiveDeal();

      expect(await riskEscrow.isSettleable(dealId)).to.equal(true);
      expect(await riskEscrow.isRefundable(dealId)).to.equal(false);

      await ethers.provider.send("evm_increaseTime", [Number(SETTLEMENT_HORIZON) + 1]);
      await ethers.provider.send("evm_mine", []);

      expect(await riskEscrow.isRefundable(dealId)).to.equal(true);
      expect(await riskEscrow.isSettleable(999)).to.equal(false);
      expect(await riskEscrow.isRefundable(999)).to.equal(false);
    });
  });

  describe("fee handling", function () {
    it("Should allow the owner to update the platform fee within the cap", async function () {
      await expect(riskEscrow.connect(owner).updatePlatformFee(1000))
        .to.emit(riskEscrow, "PlatformFeeUpdated")
        .withArgs(500, 1000);
      expect(await riskEscrow.platformFeeBps()).to.equal(1000);
    });

    it("Should reject a fee above the maximum", async function () {
      await expect(riskEscrow.connect(owner).updatePlatformFee(2001)).to.be.revertedWith(
        "Fee exceeds maximum"
      );
    });

    it("Should reject fee updates from a non-owner", async function () {
      await expect(riskEscrow.connect(otherAccount).updatePlatformFee(1000)).to.be.revertedWithCustomError(
        riskEscrow,
        "OwnableUnauthorizedAccount"
      );
    });

    it("Should allow the owner to update the platform wallet", async function () {
      await expect(riskEscrow.connect(owner).updatePlatformWallet(otherAccount.address))
        .to.emit(riskEscrow, "PlatformWalletUpdated")
        .withArgs(platformWallet.address, otherAccount.address);
      expect(await riskEscrow.platformWallet()).to.equal(otherAccount.address);
    });

    it("A higher fee should shrink only the counterparty payout, never the depositor's buffer refund", async function () {
      const { dealId } = await createActiveDeal();
      await riskEscrow.connect(owner).updatePlatformFee(2000); // 20% cap

      const expectedFee = (NOTIONAL * 2000n) / 10_000n;
      const expectedPayout = NOTIONAL - expectedFee;
      const expectedRefund = COLLATERAL - NOTIONAL;

      await expect(riskEscrow.connect(depositor).settle(dealId))
        .to.emit(riskEscrow, "RiskEscrowSettled")
        .withArgs(dealId, counterparty.address, expectedPayout, expectedFee, expectedRefund);
    });
  });

  describe("authorization - admin functions", function () {
    it("Should allow only the owner to rotate the risk oracle", async function () {
      await expect(riskEscrow.connect(owner).setRiskOracle(otherAccount.address))
        .to.emit(riskEscrow, "RiskOracleUpdated")
        .withArgs(riskOracle.address, otherAccount.address);
      expect(await riskEscrow.riskOracle()).to.equal(otherAccount.address);

      await expect(riskEscrow.connect(otherAccount).setRiskOracle(owner.address)).to.be.revertedWithCustomError(
        riskEscrow,
        "OwnableUnauthorizedAccount"
      );
    });

    it("A quote signed by the old oracle should fail after rotation", async function () {
      const quote = await buildQuote();
      await riskEscrow.connect(owner).setRiskOracle(otherAccount.address);

      const signature = await signQuote(riskOracle, quote); // old oracle signs
      await expect(
        riskEscrow.connect(depositor).createEscrow(quote, signature, { value: COLLATERAL })
      ).to.be.revertedWith("Invalid risk quote signature");
    });

    it("Should restrict emergencyWithdraw to the owner", async function () {
      await expect(
        riskEscrow.connect(otherAccount).emergencyWithdraw(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(riskEscrow, "OwnableUnauthorizedAccount");
    });
  });

  describe("emergencyWithdraw - cannot touch funds backing active escrows", function () {
    it("Should refuse to withdraw when the entire native balance backs an active escrow", async function () {
      await createActiveDeal();
      expect(await riskEscrow.surplusBalance(ethers.ZeroAddress)).to.equal(0);
      await expect(riskEscrow.connect(owner).emergencyWithdraw(ethers.ZeroAddress)).to.be.revertedWith(
        "No surplus balance to withdraw"
      );
    });

    it("Should only withdraw native balance in excess of locked collateral", async function () {
      const { dealId } = await createActiveDeal();

      // RiskEscrow has no receive()/fallback(), so a plain transfer would
      // revert; force stray ETH in via selfdestruct to simulate funds
      // landing outside the normal escrow flow (e.g. a forced transfer).
      const stray = ethers.parseEther("0.5");
      const ForceSend = await ethers.getContractFactory("ForceSend");
      const forceSend = await ForceSend.deploy({ value: stray });
      await forceSend.waitForDeployment();
      await forceSend.destroy(await riskEscrow.getAddress());

      expect(await riskEscrow.surplusBalance(ethers.ZeroAddress)).to.equal(stray);

      const ownerBefore = await ethers.provider.getBalance(owner.address);
      const tx = await riskEscrow.connect(owner).emergencyWithdraw(ethers.ZeroAddress);
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;

      expect(await ethers.provider.getBalance(owner.address)).to.equal(ownerBefore + stray - gasCost);
      // The active deal's collateral must remain fully intact.
      expect(await ethers.provider.getBalance(await riskEscrow.getAddress())).to.equal(COLLATERAL);
      expect(await riskEscrow.totalLocked(ethers.ZeroAddress)).to.equal(COLLATERAL);

      // The deal itself must still be settleable for its full collateral afterwards.
      await riskEscrow.connect(depositor).settle(dealId);
      const deal = await riskEscrow.getDeal(dealId);
      expect(deal.status).to.equal(1); // SETTLED
    });

    it("Should allow withdrawing the full balance once a deal is no longer active", async function () {
      const { dealId } = await createActiveDeal();
      await riskEscrow.connect(depositor).settle(dealId);

      // Settlement pays out everything, so there should be nothing left at all.
      expect(await riskEscrow.surplusBalance(ethers.ZeroAddress)).to.equal(0);
      expect(await ethers.provider.getBalance(await riskEscrow.getAddress())).to.equal(0);
    });

    it("Should only withdraw ERC-20 surplus, never the locked token collateral", async function () {
      await token.mint(depositor.address, COLLATERAL);
      await token.connect(depositor).approve(await riskEscrow.getAddress(), COLLATERAL);
      await createActiveDeal({ settlementAsset: await token.getAddress() }, { value: 0n });

      const stray = ethers.parseEther("3");
      await token.mint(await riskEscrow.getAddress(), stray);

      expect(await riskEscrow.surplusBalance(await token.getAddress())).to.equal(stray);

      await riskEscrow.connect(owner).emergencyWithdraw(await token.getAddress());

      expect(await token.balanceOf(owner.address)).to.equal(stray);
      expect(await token.balanceOf(await riskEscrow.getAddress())).to.equal(COLLATERAL);
    });
  });

  describe("edge cases", function () {
    it("Should reject a zero notional quote", async function () {
      const quote = await buildQuote({ notional: 0n });
      const signature = await signQuote(riskOracle, quote);
      await expect(
        riskEscrow.connect(depositor).createEscrow(quote, signature, { value: COLLATERAL })
      ).to.be.revertedWith("Notional must be greater than 0");
    });

    it("Should reject a zero required-collateral quote (fails the collateral-covers-notional check)", async function () {
      const quote = await buildQuote({ requiredCollateral: 0n });
      const signature = await signQuote(riskOracle, quote);
      await expect(riskEscrow.connect(depositor).createEscrow(quote, signature, { value: 0n })).to.be.revertedWith(
        "Collateral must cover notional"
      );
    });

    it("hashRiskQuote / recoverRiskQuoteSigner should agree with off-chain signing", async function () {
      const quote = await buildQuote();
      const signature = await signQuote(riskOracle, quote);
      expect(await riskEscrow.recoverRiskQuoteSigner(quote, signature)).to.equal(riskOracle.address);
    });

    it("getDeal should revert for a non-existent dealId", async function () {
      await expect(riskEscrow.getDeal(0)).to.be.revertedWith("Escrow does not exist");
      await expect(riskEscrow.getDeal(42)).to.be.revertedWith("Escrow does not exist");
    });
  });

  describe("fuzz-style property checks", function () {
    it("fee + counterparty payout + depositor refund should always equal collateral locked, across randomized notional/collateral/fee combinations", async function () {
      for (let i = 0; i < 12; i++) {
        const notional = ethers.parseEther((1 + Math.random() * 20).toFixed(6));
        const buffer = ethers.parseEther((Math.random() * 10).toFixed(6)); // may be 0
        const collateral = notional + buffer;
        const feeBps = Math.floor(Math.random() * 2001); // 0..MAX_FEE_BPS inclusive
        await riskEscrow.connect(owner).updatePlatformFee(feeBps);

        const quote = await buildQuote({ notional, requiredCollateral: collateral });
        const signature = await signQuote(riskOracle, quote);
        await riskEscrow.connect(depositor).createEscrow(quote, signature, { value: collateral });
        const dealId = await riskEscrow.dealCounter();

        const counterpartyBefore = await ethers.provider.getBalance(counterparty.address);
        const platformBefore = await ethers.provider.getBalance(platformWallet.address);
        const depositorBefore = await ethers.provider.getBalance(depositor.address);

        // depositor calls settle() so the counterparty/platform balance deltas
        // below are pure payouts, with no gas cost to back out.
        const tx = await riskEscrow.connect(depositor).settle(dealId);
        const receipt = await tx.wait();
        const gasCost = receipt.gasUsed * receipt.gasPrice;

        const payout = (await ethers.provider.getBalance(counterparty.address)) - counterpartyBefore;
        const fee = (await ethers.provider.getBalance(platformWallet.address)) - platformBefore;
        const depositorRefund =
          (await ethers.provider.getBalance(depositor.address)) - depositorBefore + gasCost;

        expect(payout + fee + depositorRefund).to.equal(collateral);
        expect(fee).to.equal((notional * BigInt(feeBps)) / 10_000n);
        expect(depositorRefund).to.equal(buffer);
      }
    });

    it("a quote can never be consumed twice regardless of amount or expiration spacing", async function () {
      for (let i = 0; i < 8; i++) {
        const { quote, signature } = await createActiveDeal({
          requiredCollateral: NOTIONAL + ethers.parseEther((0.1 + Math.random() * 5).toFixed(6)),
        });
        await expect(
          riskEscrow.connect(depositor).createEscrow(quote, signature, { value: quote.requiredCollateral })
        ).to.be.revertedWith("Risk quote already used");
      }
    });
  });
});
