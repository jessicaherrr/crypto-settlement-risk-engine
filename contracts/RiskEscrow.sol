// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./RiskQuoteVerifier.sol";

/**
 * @title RiskEscrow
 * @dev Risk-aware on-chain escrow. A deal only comes into existence when the
 * depositor presents a RiskQuote signed by the trusted risk oracle (the
 * Python risk engine's signing key): the quote fixes the notional, the
 * required collateral (a risk buffer on top of the notional), the
 * settlement asset, the settlement horizon, the model version and a risk
 * snapshot hash, and expires after `quoteExpiration`. The contract verifies
 * and enforces that quote - it never computes risk itself.
 *
 * Lifecycle: RiskQuote (off-chain) -> createEscrow (collateral locked,
 * ACTIVE, settlement deadline = now + quote.settlementHorizon) -> settle
 * (notional - fee to counterparty, fee to platform, any collateral above
 * notional returned to depositor) or refund (full collateral returned to
 * depositor once the settlement deadline elapses without settlement).
 *
 * Carries forward from the project's prior generic Escrow.sol: fund
 * locking, reentrancy protection, access control, platform fee handling,
 * timeout-based refunds, and ERC-20-safe transfer patterns. Drops the old
 * multi-step CREATED -> confirm -> complete flow: a cryptographically
 * signed, party-bound quote is itself the confirmation that both sides have
 * agreed to these terms, so the deal is ACTIVE as soon as collateral lands.
 */
contract RiskEscrow is RiskQuoteVerifier, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // ============ ENUMS ============

    enum EscrowStatus {
        ACTIVE,
        SETTLED,
        REFUNDED
    }

    // ============ STRUCTS ============

    /**
     * @dev On-chain record of a risk escrow deal, snapshotted from the
     * RiskQuote at creation time. `collateralLocked` may exceed `notional`
     * (the risk buffer); only the buffer above `notional` is returned to
     * the depositor on settlement.
     */
    struct RiskEscrowDeal {
        address depositor;
        address counterparty;
        address settlementAsset;
        uint256 notional;
        uint256 collateralLocked;
        string modelVersion;
        bytes32 riskSnapshotHash;
        bytes32 quoteId;
        EscrowStatus status;
        uint256 createdAt;
        uint256 settlementDeadline;
        uint256 settledAt;
    }

    // ============ STATE VARIABLES ============

    uint256 public dealCounter;
    uint256 public platformFeeBps = 500; // 5%, in basis points, applied to notional
    uint256 public constant MAX_FEE_BPS = 2000; // 20% cap

    // Sanity bounds on the per-quote settlement horizon. The risk engine
    // will offer several discrete horizons (1d/7d/14d/30d, etc); these just
    // guard against a degenerate (near-zero or unbounded) horizon reaching
    // the chain, they are not meant to encode a specific product horizon.
    uint256 public constant MIN_SETTLEMENT_HORIZON = 1 hours;
    uint256 public constant MAX_SETTLEMENT_HORIZON = 90 days;

    address public platformWallet;

    mapping(uint256 => RiskEscrowDeal) public deals;
    mapping(bytes32 => bool) public usedQuotes;

    /// @dev Collateral currently locked in ACTIVE deals, per settlement asset
    /// (address(0) for native). emergencyWithdraw can only ever touch the
    /// surplus above this - it can never reach funds backing active escrows.
    mapping(address => uint256) public totalLocked;

    // ============ EVENTS ============

    event RiskEscrowCreated(
        uint256 indexed dealId,
        bytes32 indexed quoteId,
        address indexed depositor,
        address counterparty,
        address settlementAsset,
        uint256 notional,
        uint256 collateralLocked,
        uint256 settlementDeadline,
        string modelVersion,
        bytes32 riskSnapshotHash
    );

    event RiskEscrowSettled(
        uint256 indexed dealId,
        address indexed counterparty,
        uint256 payout,
        uint256 platformFee,
        uint256 depositorRefund
    );

    event RiskEscrowRefunded(uint256 indexed dealId, address indexed depositor, uint256 amount);

    event PlatformFeeUpdated(uint256 previousFeeBps, uint256 newFeeBps);
    event PlatformWalletUpdated(address previousWallet, address newWallet);

    // ============ MODIFIERS ============

    modifier dealExists(uint256 dealId) {
        require(dealId > 0 && dealId <= dealCounter, "Escrow does not exist");
        _;
    }

    // ============ CONSTRUCTOR ============

    constructor(address _platformWallet, address _riskOracle)
        RiskQuoteVerifier("AskGeneRiskEscrow", "1", _riskOracle)
        Ownable(msg.sender)
    {
        require(_platformWallet != address(0), "Invalid platform wallet");
        platformWallet = _platformWallet;
    }

    // ============ EXTERNAL FUNCTIONS ============

    /**
     * @notice Create a risk escrow by presenting a signed RiskQuote and locking
     * the collateral it requires.
     * @dev `quote.depositor` must equal the caller, binding the quote to the
     * account that actually funds it. The quote cannot be reused (replay
     * protection via `usedQuotes`) and must not be expired. `quoteExpiration`
     * only governs how long the quote may be used to create an escrow; the
     * resulting escrow's own settlement deadline is `now + settlementHorizon`,
     * independent of quote acceptance timing.
     * @param quote The RiskQuote signed by the risk oracle.
     * @param signature EIP-712 signature over `quote`.
     * @return dealId The ID of the newly created escrow.
     */
    function createEscrow(RiskQuote calldata quote, bytes calldata signature)
        external
        payable
        nonReentrant
        returns (uint256 dealId)
    {
        require(msg.sender == quote.depositor, "Caller is not the quoted depositor");
        require(quote.counterparty != address(0), "Invalid counterparty");
        require(quote.counterparty != quote.depositor, "Depositor cannot equal counterparty");
        require(quote.notional > 0, "Notional must be greater than 0");
        require(quote.requiredCollateral >= quote.notional, "Collateral must cover notional");
        require(
            quote.settlementHorizon >= MIN_SETTLEMENT_HORIZON && quote.settlementHorizon <= MAX_SETTLEMENT_HORIZON,
            "Settlement horizon out of bounds"
        );
        require(!usedQuotes[quote.quoteId], "Risk quote already used");

        _verifyRiskQuote(quote, signature);

        usedQuotes[quote.quoteId] = true;

        if (quote.settlementAsset == address(0)) {
            require(msg.value == quote.requiredCollateral, "Collateral does not match quote");
        } else {
            require(msg.value == 0, "Native value not accepted for ERC-20 settlement");
            IERC20(quote.settlementAsset).safeTransferFrom(msg.sender, address(this), quote.requiredCollateral);
        }

        totalLocked[quote.settlementAsset] += quote.requiredCollateral;

        dealCounter++;
        dealId = dealCounter;

        uint256 settlementDeadline = block.timestamp + quote.settlementHorizon;

        deals[dealId] = RiskEscrowDeal({
            depositor: quote.depositor,
            counterparty: quote.counterparty,
            settlementAsset: quote.settlementAsset,
            notional: quote.notional,
            collateralLocked: quote.requiredCollateral,
            modelVersion: quote.modelVersion,
            riskSnapshotHash: quote.riskSnapshotHash,
            quoteId: quote.quoteId,
            status: EscrowStatus.ACTIVE,
            createdAt: block.timestamp,
            settlementDeadline: settlementDeadline,
            settledAt: 0
        });

        emit RiskEscrowCreated(
            dealId,
            quote.quoteId,
            quote.depositor,
            quote.counterparty,
            quote.settlementAsset,
            quote.notional,
            quote.requiredCollateral,
            settlementDeadline,
            quote.modelVersion,
            quote.riskSnapshotHash
        );
    }

    /**
     * @notice Settle the escrow: the counterparty receives the notional
     * minus the platform fee, the platform receives the fee, and any
     * collateral locked above the notional (the risk buffer) is returned to
     * the depositor. Callable by either party.
     * @dev The platform fee is charged on `notional`, not on the full
     * collateral, so it never eats into the risk buffer. Phase B keeps the
     * payout itself as a fixed release of the full notional, carried over
     * from the prior generic escrow; a future phase may gate this behind a
     * second signed quote attesting a realized (possibly partial) split.
     * @param dealId ID of the escrow.
     */
    function settle(uint256 dealId) external dealExists(dealId) nonReentrant {
        RiskEscrowDeal storage deal = deals[dealId];

        require(deal.status == EscrowStatus.ACTIVE, "Escrow not active");
        require(msg.sender == deal.depositor || msg.sender == deal.counterparty, "Not a party to this escrow");

        uint256 fee = (deal.notional * platformFeeBps) / 10_000;
        uint256 counterpartyPayout = deal.notional - fee;
        uint256 depositorRefund = deal.collateralLocked - deal.notional;

        // Update status before transfers to prevent reentrancy.
        deal.status = EscrowStatus.SETTLED;
        deal.settledAt = block.timestamp;
        totalLocked[deal.settlementAsset] -= deal.collateralLocked;

        _payout(deal.settlementAsset, platformWallet, fee);
        _payout(deal.settlementAsset, deal.counterparty, counterpartyPayout);
        _payout(deal.settlementAsset, deal.depositor, depositorRefund);

        emit RiskEscrowSettled(dealId, deal.counterparty, counterpartyPayout, fee, depositorRefund);
    }

    /**
     * @notice Refund the full locked collateral back to the depositor once
     * the settlement deadline has elapsed without settlement.
     * @param dealId ID of the escrow.
     */
    function refund(uint256 dealId) external dealExists(dealId) nonReentrant {
        RiskEscrowDeal storage deal = deals[dealId];

        require(deal.status == EscrowStatus.ACTIVE, "Escrow not active");
        require(msg.sender == deal.depositor || msg.sender == deal.counterparty, "Not a party to this escrow");
        require(block.timestamp > deal.settlementDeadline, "Settlement window still open");

        // Update status before transfer to prevent reentrancy.
        deal.status = EscrowStatus.REFUNDED;
        totalLocked[deal.settlementAsset] -= deal.collateralLocked;

        _payout(deal.settlementAsset, deal.depositor, deal.collateralLocked);

        emit RiskEscrowRefunded(dealId, deal.depositor, deal.collateralLocked);
    }

    // ============ VIEW FUNCTIONS ============

    function getDeal(uint256 dealId) external view dealExists(dealId) returns (RiskEscrowDeal memory) {
        return deals[dealId];
    }

    function isSettleable(uint256 dealId) external view returns (bool) {
        if (dealId == 0 || dealId > dealCounter) return false;
        return deals[dealId].status == EscrowStatus.ACTIVE;
    }

    function isRefundable(uint256 dealId) external view returns (bool) {
        if (dealId == 0 || dealId > dealCounter) return false;
        RiskEscrowDeal storage deal = deals[dealId];
        return deal.status == EscrowStatus.ACTIVE && block.timestamp > deal.settlementDeadline;
    }

    function getContractBalance(address asset) external view returns (uint256) {
        if (asset == address(0)) return address(this).balance;
        return IERC20(asset).balanceOf(address(this));
    }

    /// @notice Balance of `asset` held by this contract that is not backing
    /// any ACTIVE escrow, i.e. the amount emergencyWithdraw can touch.
    function surplusBalance(address asset) external view returns (uint256) {
        return _surplusBalance(asset);
    }

    // ============ INTERNAL HELPERS ============

    function _payout(address asset, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (asset == address(0)) {
            (bool success, ) = to.call{value: amount}("");
            require(success, "Native transfer failed");
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
    }

    function _surplusBalance(address asset) internal view returns (uint256) {
        uint256 balance = asset == address(0) ? address(this).balance : IERC20(asset).balanceOf(address(this));
        uint256 locked = totalLocked[asset];
        return balance > locked ? balance - locked : 0;
    }

    // ============ ADMIN FUNCTIONS ============

    function setRiskOracle(address newOracle) external onlyOwner {
        _setRiskOracle(newOracle);
    }

    function updatePlatformFee(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= MAX_FEE_BPS, "Fee exceeds maximum");
        emit PlatformFeeUpdated(platformFeeBps, newFeeBps);
        platformFeeBps = newFeeBps;
    }

    function updatePlatformWallet(address newWallet) external onlyOwner {
        require(newWallet != address(0), "Invalid wallet address");
        emit PlatformWalletUpdated(platformWallet, newWallet);
        platformWallet = newWallet;
    }

    /**
     * @notice Recover an asset balance that is not backing any ACTIVE
     * escrow (e.g. tokens sent to the contract by mistake, or dust left
     * over from rounding). Can never withdraw collateral locked in an
     * active deal, regardless of how much of `asset` the contract holds.
     * @dev Pass address(0) for the native asset, or an ERC-20 token address.
     */
    function emergencyWithdraw(address asset) external onlyOwner nonReentrant {
        uint256 surplus = _surplusBalance(asset);
        require(surplus > 0, "No surplus balance to withdraw");
        _payout(asset, owner(), surplus);
    }
}
